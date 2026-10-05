/// <reference types="chrome" />

// Passkey provider via chrome.webAuthenticationProxy: Bramble acts as the WebAuthn
// authenticator for other sites. The crypto is the shared Rust core (Phase 0); this
// module orchestrates the proxy events around it. The orchestration (handleCreate /
// handleGet) takes injected deps so origin validation, the ES256 check, and response
// assembly are unit-tested; the chrome event/attach wiring stays thin. See
// docs/passkey-provider.md.
//
// This module stays import-safe (no chrome at import) so it is unit-testable; the
// chrome wiring (corner-card ceremony, vault IO, attach) lives in ./webauthn-proxy-init,
// which injects the deps below. The proxy is gated behind a pref (default off) because
// attach() intercepts all browser WebAuthn. End-to-end needs a real Chrome.

import type { CryptoAdapter } from "@core/adapters/crypto";
import type { Entry, PasskeyCredential } from "@core/hooks/useVault";
import { base64UrlToBase64 } from "@core/util/bytes";
import {
	attachPasskeyTo,
	findPasskeys,
	loginsCoveringRpId,
	newPasskeyLogin,
	type PasskeyPlacement,
	passkeyAttachTarget,
	planPasskeyPlacement,
} from "@core/vault/passkey";
import {
	authenticationResponseJSON,
	buildClientData,
	COSE_ES256,
	defaultRpId,
	isRegistrableSuffix,
	originHostname,
	parseCreationOptions,
	parseRequestOptions,
	registrationResponseJSON,
} from "./webauthn-json";

/** A WebAuthn-shaped failure; surfaced to the page as a DOMException of this name. */
class WebAuthnError extends Error {
	constructor(
		readonly domName: string,
		message: string,
	) {
		super(message);
		this.name = domName;
	}
}

export interface CeremonyCreateRequest {
	kind: "create";
	rpId: string;
	rpName?: string;
	userName?: string;
	origin: string;
}
export interface CeremonyGetRequest {
	kind: "get";
	rpId: string;
	origin: string;
	/** allowCredentials ids (STANDARD base64) to narrow matches; empty = any for the rpId. */
	allowCredentials?: string[];
}
export type CeremonyRequest = CeremonyCreateRequest | CeremonyGetRequest;

/**
 * User-facing ceremony: confirm intent, ensure the vault is unlocked, perform user
 * verification when required, and let the user pick (create: which login to attach to,
 * with "create new" as an option; get: which matching passkey). Returns `approved: false`
 * to abort (mapped to NotAllowedError), or `approved: false, nativeFallback: true` to
 * hand the request to the user's OTHER authenticators instead of failing it.
 * - `credentialId` (get): the chosen credential, STANDARD base64.
 * - `placement` (create): "new" to force a fresh login, `{ entryId }` to attach to a
 *   specific login, or omitted to let automatic placement decide.
 */
export type CeremonyDecision =
	| {
			approved: true;
			userVerified: boolean;
			credentialId?: string;
			placement?: "new" | { entryId: string };
	  }
	| {
			approved: false;
			/** Give the request to the user's other authenticators: the Firefox shim relays
			 * to the native navigator.credentials; Chrome has no passthrough, so the delivery
			 * layer turns the provider off and the site's retry goes native. */
			nativeFallback?: boolean;
			/** Context for the DOMException message the site sees (defaults to "user declined"). */
			detail?: string;
	  };
export type CeremonyFn = (req: CeremonyRequest) => Promise<CeremonyDecision>;

/** The card reply sentinel for the "use another authenticator" action. Credential ids
 * (base64) and login ids never collide with it. */
export const NATIVE_CHOICE = "native";

/** DOMException message when the request is handed to the user's other authenticators. */
export const NATIVE_FALLBACK_MESSAGE =
	"No Bramble passkey can serve this request. Continue with another authenticator.";

/** DOMException message for the early fail: the vault is locked and unlocking it from this
 * ceremony needs a WebAuthn tap (security key / platform biometric), which pauses the
 * proxy and would kill the very request the ceremony is serving. docs/passkey-provider.md. */
export const WEBAUTHN_UNLOCK_CONFLICT_MESSAGE =
	"This vault unlocks with a security key, which cannot run while Bramble handles this request. Unlock Bramble from its toolbar first, then try again.";

/** A shown card's reply: approved, and (for the create picker) the chosen login id or "new". */
export interface CardReply {
	approved: boolean;
	choice?: string;
}

/**
 * The platform side a ceremony drives: show a card (the variant is chosen by which fields
 * are passed), report/await unlock, and read the vault. Injected so the create/get
 * ceremony flow below is unit-tested without chrome. `webauthn-proxy-init` supplies the
 * real one (corner card + popup unlock + offscreen decrypt).
 */
export interface CeremonyHost {
	showCard: (opts: {
		existingLoginName?: string;
		candidates?: { id: string; name: string; username: string }[];
		passkeyChoices?: { credentialId: string; label: string }[];
		/** get only: the vault holds no passkey that could serve this request. */
		noMatch?: boolean;
		/** Render the "use another authenticator" action; says what the reply will do
		 * ("passthrough" relays natively, "disable" turns the provider off). */
		nativeFallback?: "passthrough" | "disable";
	}) => Promise<CardReply>;
	isLocked: () => boolean;
	ensureUnlocked: () => Promise<boolean>;
	loadEntries: () => Promise<Entry[]>;
	/** How a request the vault cannot serve hands off: "silent" relays to the native
	 * authenticator with no card (Firefox, where the shim holds the page's own options);
	 * "card" asks first, because Chrome's all-or-nothing proxy has no passthrough and the
	 * fallback instead turns the provider off, a state change the user must choose. */
	nativeFallback?: "silent" | "card";
	/** While locked: whether unlocking needs a WebAuthn tap (security-key or platform
	 * slot), which would pause the proxy and kill this very request. The locked branches
	 * fail early with guidance rather than walking the user into that. */
	unlockNeedsWebauthn?: () => Promise<boolean>;
}

/** Label a passkey for the get picker: its account name, else display name, else generic. */
function passkeyLabel(p: { userName?: string; userDisplayName?: string }): string {
	return p.userName?.trim() || p.userDisplayName?.trim() || "Passkey";
}

/** Declined, with the reason the site's DOMException will carry. */
function declined(detail = "user declined"): CeremonyDecision {
	return { approved: false, detail };
}

/** The card opts for the native handoff action, as the host's delivery can afford it. */
function nativeFallbackOpts(host: CeremonyHost): { nativeFallback?: "passthrough" | "disable" } {
	if (!host.nativeFallback) return {};
	return { nativeFallback: host.nativeFallback === "card" ? "disable" : "passthrough" };
}

/** Whether a card reply picked the "use another authenticator" action. */
function isNativeReply(reply: CardReply): boolean {
	return reply.choice === NATIVE_CHOICE;
}

/** No stored passkey can serve this request. Never a confirm-then-error dead end: "silent"
 * relays to the native authenticator immediately; "card" asks, because the handoff turns
 * the provider off (Chrome has no passthrough) and that must be the user's click. */
async function noMatchDecision(host: CeremonyHost): Promise<CeremonyDecision> {
	if (host.nativeFallback === "silent") return { approved: false, nativeFallback: true };
	const reply = await host.showCard({ noMatch: true, ...nativeFallbackOpts(host) });
	if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
	return declined("no matching passkey");
}

/** The locked prologue both ceremonies share: fail early when unlocking from here would
 *  need a WebAuthn tap (it pauses the proxy and kills this very request), confirm intent
 *  with the native handoff offered, unlock. Returns a decision to abort with, or undefined
 *  to proceed unlocked. */
async function lockedGate(host: CeremonyHost): Promise<CeremonyDecision | undefined> {
	if (await unlockWouldConflict(host)) return declined(WEBAUTHN_UNLOCK_CONFLICT_MESSAGE);
	const reply = await host.showCard(nativeFallbackOpts(host));
	if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
	if (!reply.approved) return declined();
	if (!(await host.ensureUnlocked())) return declined();
	return undefined;
}

/** The locked branches' early fail: an unlock from here needs a WebAuthn tap, which
 * pauses the proxy and kills the request the ceremony exists to serve. */
async function unlockWouldConflict(host: CeremonyHost): Promise<boolean> {
	return !!host.unlockNeedsWebauthn && (await host.unlockNeedsWebauthn()) === true;
}

/**
 * get(): confirm + unlock, then pick which stored passkey to sign in with. One match
 * signs in directly; several (multiple accounts on the site) show a picker. Zero matches
 * hands the request to the user's other authenticators rather than erroring cold.
 */
export async function runGetCeremony(
	req: CeremonyGetRequest,
	host: CeremonyHost,
): Promise<CeremonyDecision> {
	const startedLocked = host.isLocked();
	if (startedLocked) {
		const gate = await lockedGate(host);
		if (gate) return gate;
	}

	let entries: Entry[] = [];
	try {
		entries = await host.loadEntries();
	} catch {}
	const matches = findPasskeys(entries, req.rpId, req.allowCredentials);

	// No stored passkey for this site: hand the request to the user's other
	// authenticators (relay or offer), never a dead end.
	if (matches.length === 0) return noMatchDecision(host);

	// The locked path already confirmed via the unlock card, so a single match just proceeds.
	if (startedLocked && matches.length === 1) {
		return { approved: true, userVerified: true, credentialId: matches[0]?.passkey.credentialId };
	}

	// Otherwise always show which account(s): one so the user sees who they're signing in as,
	// several so they can choose. A one-item list preselects it; reply.choice is the pick.
	const reply = await host.showCard({
		passkeyChoices: matches.map((m) => ({
			credentialId: m.passkey.credentialId,
			label: passkeyLabel(m.passkey),
		})),
		...nativeFallbackOpts(host),
	});
	if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
	if (!reply.approved) return declined();
	return {
		approved: true,
		userVerified: true,
		credentialId: reply.choice ?? matches[0]?.passkey.credentialId,
	};
}

/**
 * create(): confirm + unlock, then resolve which login the passkey attaches to. When
 * locked we confirm generically first (the vault can't be read yet); once unlocked we
 * attach to the unambiguous account, create a new login when the domain has none, or
 * show a picker (candidates + "create new") when several accounts are ambiguous. Every
 * card also offers the "use another authenticator" action, so a user who came to enroll
 * a device-native credential (Touch ID, a YubiKey) is never forced through Bramble.
 */
export async function runCreateCeremony(
	req: CeremonyCreateRequest,
	host: CeremonyHost,
): Promise<CeremonyDecision> {
	const startedLocked = host.isLocked();
	if (startedLocked) {
		const gate = await lockedGate(host);
		if (gate) return gate;
	}

	let entries: Entry[] = [];
	try {
		entries = await host.loadEntries();
	} catch {}

	const target = passkeyAttachTarget(entries, req.rpId, req.userName);
	if (target) {
		// Confident account. The locked path already confirmed; otherwise confirm "Add to X".
		if (!startedLocked) {
			const reply = await host.showCard({
				existingLoginName: target.name,
				...nativeFallbackOpts(host),
			});
			if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
			if (!reply.approved) return declined();
		}
		return { approved: true, userVerified: true, placement: { entryId: target.id } };
	}

	const candidates = loginsCoveringRpId(entries, req.rpId);
	if (candidates.length === 0) {
		if (!startedLocked) {
			const reply = await host.showCard(nativeFallbackOpts(host));
			if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
			if (!reply.approved) return declined();
		}
		return { approved: true, userVerified: true, placement: "new" };
	}

	// Several accounts on this domain and no clear match: let the user pick one or create new.
	const reply = await host.showCard({
		candidates: candidates.map((c) => ({ id: c.id, name: c.name, username: c.username })),
		...nativeFallbackOpts(host),
	});
	if (isNativeReply(reply)) return { approved: false, nativeFallback: true };
	if (!reply.approved) return declined();
	return {
		approved: true,
		userVerified: true,
		placement: reply.choice && reply.choice !== "new" ? { entryId: reply.choice } : "new",
	};
}

export interface PasskeyProxyDeps {
	crypto: Pick<CryptoAdapter, "passkeyMakeCredential" | "passkeyGetAssertion">;
	/** Decrypt and return all vault entries. Caller guarantees the vault is unlocked first. */
	loadEntries: () => Promise<Entry[]>;
	/** Persist a freshly minted passkey (attach to / create a login). */
	savePlacement: (plan: PasskeyPlacement) => Promise<void>;
	ceremony: CeremonyFn;
	/** SHA-256(bytes) -> STANDARD base64. WebCrypto in the service worker. */
	sha256: (bytes: Uint8Array) => Promise<string>;
	/** Wall clock; injected for deterministic tests. */
	now: () => number;
	/** Fired after a create persists, for a UI confirmation toast. */
	onSaved?: (info: { rpId: string; loginName: string; created: boolean }) => void;
}

/** Resolve the effective rpId and reject cross-origin / public-suffix rpIds. */
function resolveRpId(
	origin: string,
	requested: string | undefined,
): { rpId: string; host: string } {
	if (!origin) throw new WebAuthnError("NotAllowedError", "request has no origin");
	const host = originHostname(origin);
	const rpId = requested ?? defaultRpId(host);
	if (!isRegistrableSuffix(host, rpId)) {
		throw new WebAuthnError("SecurityError", `rpId ${rpId} is not valid for origin ${origin}`);
	}
	return { rpId, host };
}

/** Apply the ceremony's create placement choice ("new" / a chosen login), else auto. */
function resolveCreatePlan(
	decision: Extract<CeremonyDecision, { approved: true }>,
	entries: Entry[],
	rpId: string,
	rpName: string | undefined,
	credential: PasskeyCredential,
): PasskeyPlacement {
	const placement = decision.placement;
	if (placement === "new") return newPasskeyLogin(rpId, rpName, credential);
	if (placement) {
		const target = entries.find(
			(e): e is Extract<Entry, { type: "login" }> =>
				e.type === "login" && e.id === placement.entryId,
		);
		if (target) return attachPasskeyTo(target, credential);
	}
	return planPasskeyPlacement(entries, rpId, rpName, credential);
}

/** Create-response details plus our handoff marker: Chrome's completeCreateRequest wants
 *  only the standard shape (the delivery layer strips the marker), while the Firefox
 *  transport reads it to relay to the native authenticator. */
export type CreateCompletion = chrome.webAuthenticationProxy.CreateResponseDetails & {
	nativeFallback?: boolean;
};

/** Get-response details plus the handoff marker, as CreateCompletion. */
export type GetCompletion = chrome.webAuthenticationProxy.GetResponseDetails & {
	nativeFallback?: boolean;
};

/**
 * Orchestrate navigator.credentials.create(). `origin` is the calling page's origin,
 * resolved by the caller from the active tab (the proxy request carries no origin).
 */
export async function handleCreate(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
	origin: string,
): Promise<CreateCompletion> {
	try {
		const opts = parseCreationOptions(requestDetailsJson);
		const { rpId } = resolveRpId(origin, opts.rpId);
		if (!opts.algs.includes(COSE_ES256)) {
			throw new WebAuthnError("NotSupportedError", "only ES256 (-7) is supported");
		}

		const decision = await deps.ceremony({
			kind: "create",
			rpId,
			rpName: opts.rpName,
			userName: opts.userName,
			origin,
		});
		if (!decision.approved) {
			if (decision.nativeFallback) return nativeFallbackCompletion(requestId);
			throw new WebAuthnError("NotAllowedError", decision.detail ?? "user declined");
		}

		const entries = await deps.loadEntries();
		// excludeCredentials lists what the RP already holds FOR THE ACCOUNT BEING ENROLLED, so
		// it does not stop a second account on the same site, nor a second device for the same
		// account (whose credential ids this vault has never seen). It stops exactly one thing:
		// minting a twin of a credential we already store, which the sign-in picker cannot tell
		// apart (both label by userName) and only one of which the RP may still honour.
		//
		// After the ceremony, not before: the spec has the authenticator obtain consent first so
		// the error cannot be used as a silent oracle for what the vault holds.
		const excluded = opts.excludeCredentialsB64Url.map(base64UrlToBase64);
		if (excluded.length && findPasskeys(entries, rpId, excluded).length) {
			throw new WebAuthnError("InvalidStateError", "a passkey for this account is already stored");
		}

		const reg = await deps.crypto.passkeyMakeCredential(rpId, decision.userVerified);
		const credential: PasskeyCredential = {
			credentialId: reg.credentialId,
			rpId,
			rpName: opts.rpName,
			userHandle: base64UrlToBase64(opts.userHandleB64Url),
			userName: opts.userName,
			userDisplayName: opts.userDisplayName,
			alg: COSE_ES256,
			publicKeyCose: reg.publicKeyCose,
			privateKey: reg.privateKey,
			signCount: 0,
			createdAt: deps.now(),
		};
		const plan = resolveCreatePlan(decision, entries, rpId, opts.rpName, credential);
		await deps.savePlacement(plan);
		deps.onSaved?.({
			rpId,
			created: plan.kind === "create",
			loginName:
				plan.kind === "create"
					? plan.data.name
					: (entries.find((e) => e.id === plan.entryId)?.name ?? rpId),
		});

		const clientData = buildClientData("webauthn.create", opts.challenge, origin);
		return {
			requestId,
			responseJson: registrationResponseJSON({
				credentialIdStdB64: reg.credentialId,
				attestationObjectStdB64: reg.attestationObject,
				authenticatorDataStdB64: reg.authenticatorData,
				publicKeyStdB64: reg.publicKey,
				clientDataB64Url: clientData.b64Url,
			}),
		};
	} catch (e) {
		return { requestId, error: toDomException(e) };
	}
}

/**
 * Orchestrate navigator.credentials.get(). `origin` is the calling page's origin,
 * resolved by the caller from the active tab (the proxy request carries no origin).
 */
export async function handleGet(
	deps: PasskeyProxyDeps,
	requestId: number,
	requestDetailsJson: string,
	origin: string,
): Promise<GetCompletion> {
	try {
		const opts = parseRequestOptions(requestDetailsJson);
		const { rpId } = resolveRpId(origin, opts.rpId);
		const allowStd = opts.allowCredentialsB64Url.map(base64UrlToBase64);

		// The ceremony enumerates matching passkeys (for the picker) and returns the chosen
		// credentialId, so it needs the same allow-list narrowing handleGet uses below.
		const decision = await deps.ceremony({
			kind: "get",
			rpId,
			origin,
			allowCredentials: allowStd.length ? allowStd : undefined,
		});
		if (!decision.approved) {
			if (decision.nativeFallback) return nativeFallbackCompletion(requestId);
			throw new WebAuthnError("NotAllowedError", decision.detail ?? "user declined");
		}
		const allow = decision.credentialId
			? [decision.credentialId]
			: allowStd.length
				? allowStd
				: undefined;
		const matches = findPasskeys(await deps.loadEntries(), rpId, allow);
		const chosen =
			matches.find((m) => m.passkey.credentialId === decision.credentialId) ?? matches[0];
		if (!chosen) throw new WebAuthnError("NotAllowedError", "no matching passkey");

		const clientData = buildClientData("webauthn.get", opts.challenge, origin);
		const clientDataHash = await deps.sha256(clientData.bytes);
		// The stored alg travels with the key: 32 bytes alone cannot say whether they are a
		// P-256 scalar or an Ed25519 seed, and the core refuses an alg it can't sign for.
		const assertion = await deps.crypto.passkeyGetAssertion(
			rpId,
			chosen.passkey.privateKey,
			chosen.passkey.alg,
			clientDataHash,
			decision.userVerified,
		);
		return {
			requestId,
			responseJson: authenticationResponseJSON({
				credentialIdStdB64: chosen.passkey.credentialId,
				authenticatorDataStdB64: assertion.authenticatorData,
				signatureStdB64: assertion.signature,
				clientDataB64Url: clientData.b64Url,
				userHandleStdB64: chosen.passkey.userHandle || undefined,
			}),
		};
	} catch (e) {
		return { requestId, error: toDomException(e) };
	}
}

/** The completion for a request handed to the user's other authenticators: the site's
 *  promise still rejects (the delivery layer can't fulfil it; Chrome has no passthrough,
 *  Firefox relays natively from the shim, where this error is never delivered), but with
 *  a message that says why rather than a bare "no matching passkey". */
function nativeFallbackCompletion(requestId: number): CreateCompletion & GetCompletion {
	return {
		requestId,
		error: { name: "NotAllowedError", message: NATIVE_FALLBACK_MESSAGE },
		nativeFallback: true,
	};
}

function toDomException(e: unknown): chrome.webAuthenticationProxy.DOMExceptionDetails {
	if (e instanceof WebAuthnError) return { name: e.domName, message: e.message };
	// Unknown failure: NotAllowedError is the spec's catch-all so we never leak internals.
	return { name: "NotAllowedError", message: e instanceof Error ? e.message : String(e) };
}
