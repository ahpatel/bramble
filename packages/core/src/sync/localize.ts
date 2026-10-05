// Member-aware sync convergence (ticket: shared-entry convergence).
//
// The merge itself is DEK-agnostic — envelopes are compared and adopted by id
// and stamp, carried verbatim. What changes for a sharing-enabled vault is
// what happens AROUND the merge:
//
// 1. FILTER (members only): a member never adopts ciphertext it cannot open.
//    The owner's broadcast contains every envelope VEK-wrapped; a member keeps
//    only the envelopes a wrapper record covers (or that it already holds).
//    This is ADR-0003's promise at sync time: members hold ciphertext only for
//    entries shared with them. The owner adopts everything — including
//    locally-locked member-private envelopes, which it holds as opaque bytes
//    so member-to-member content can flow through it.
// 2. LOCALIZE (both roles): after the merge, every envelope the device should
//    be able to open gets its DEK re-wrapped under the device's own key (the
//    vault key for the owner, the member master key for a member), using the
//    wrapper records where the adopted envelope's DEK is wrapped for someone
//    else. Envelopes that stay locked are kept verbatim — locally locked, not
//    corrupted.
//
// A vault with no sharing layer (null view) does neither: byte-for-byte the
// old behavior.

import { bytesToBase64 } from "../util/bytes";
import {
	decryptWithKey,
	openMemberSeal,
	type SealedKey,
	tryDecryptWithKey,
} from "../vault/sharing-crypto";
import type { SharingRegion } from "../vault-format";
import { isMemberVault, type Vlt2Blob } from "../vault-format";
import type { EntriesPayload } from "./entries-payload";
/** What the local device knows about the sharing layer, for sync filtering. */
export interface SyncSharingView {
	role: "owner" | "member";
	/** The decrypted region (wrapper records + collection membership). */
	region: SharingRegion;
	/** Collection keys this device holds, by collection id. */
	collectionKeys: Record<string, string>;
}

export interface LocalizeDeps {
	/** Unwrap an envelope's DEK with the device's local key (the loaded vault
	 * key or member master key). Null when the key can't open it. */
	tryUnwrapLocal(envelope: { dekIv: string; wrappedDek: string }): Promise<string | null>;
	/** Re-wrap a DEK under the device's local key. */
	wrapLocal(dekB64: string): Promise<{ dekIv: string; wrappedDek: string }>;
	/** Unwrap a DEK with an explicit collection key. Null on failure. */
	tryUnwrapWithKey(
		keyB64: string,
		envelope: { dekIv: string; wrappedDek: string },
	): Promise<string | null>;
}

/** The wrapper records a device can actually open, as entryId → unlock info. */
export function openableWrappers(
	view: SyncSharingView,
): Map<string, { keyB64: string; dekIv: string; wrappedDek: string }> {
	const out = new Map<string, { keyB64: string; dekIv: string; wrappedDek: string }>();
	for (const wrapper of view.region.wrappers) {
		const key = view.collectionKeys[wrapper.collectionId];
		if (!key) continue;
		out.set(wrapper.entryId, { keyB64: key, dekIv: wrapper.dekIv, wrappedDek: wrapper.wrappedDek });
	}
	return out;
}

/** FILTER (member role): drop remote envelopes this member cannot open — no
 * wrapper record covers them and it doesn't already hold the id. Index,
 * tombstones, and settings pass through untouched (the merge needs them). */
export function filterRemoteForView(
	view: SyncSharingView,
	remote: EntriesPayload,
	local: EntriesPayload,
): EntriesPayload {
	if (view.role === "owner") return remote;
	const wrappers = openableWrappers(view);
	const held = new Set(local.entries.map((e) => e.id));
	return {
		...remote,
		entries: remote.entries.filter((e) => wrappers.has(e.id) || held.has(e.id)),
	};
}

/** LOCALIZE: ensure every envelope in the payload is openable with the local
 * key where the sharing layer allows it. Returns the payload unchanged when
 * nothing needed re-wrapping, so the caller's equivalence checks stay honest. */
export async function localizePayload(
	deps: LocalizeDeps,
	view: SyncSharingView,
	payload: EntriesPayload,
): Promise<EntriesPayload> {
	const wrappers = openableWrappers(view);
	let changed = false;
	const entries = await Promise.all(
		payload.entries.map(async (envelope) => {
			// Already openable with the local key: keep verbatim.
			if ((await deps.tryUnwrapLocal(envelope)) !== null) return envelope;
			// Openable through a wrapper record: unwrap via the collection key,
			// re-wrap under the local key.
			const wrapper = wrappers.get(envelope.id);
			if (wrapper) {
				const dekB64 = await deps.tryUnwrapWithKey(wrapper.keyB64, wrapper);
				if (dekB64 !== null) {
					const wrapped = await deps.wrapLocal(dekB64);
					changed = true;
					return { ...envelope, dekIv: wrapped.dekIv, wrappedDek: wrapped.wrappedDek };
				}
			}
			// Locally locked: keep verbatim (owner holding member-private bytes).
			return envelope;
		}),
	);
	return changed ? { ...payload, entries } : payload;
}

// --- building the view from the device's blob --------------------------------

/** The loaded-key crypto ops the view builder needs (the vault key on an owner
 * device, the member master key on a member device — whatever is loaded). */
export interface SyncViewCrypto {
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;
	encryptWithVek(plaintext: string): Promise<{ iv: string; ciphertext: string }>;
}

/** Build the device's sync sharing view from its decoded VLT2 blob, using the
 * loaded key. Null for a vault without a sharing layer (the caller passes a
 * tagged decode, so VLT1 never reaches here). */
export async function buildSyncSharingView(
	crypto: SyncViewCrypto,
	blob: Vlt2Blob,
): Promise<SyncSharingView> {
	if (isMemberVault(blob)) {
		// Member path: the loaded key is the member master key; it decrypts the
		// member secrets (member id + X25519 private key), which open the SHK
		// seal and the collection key seals.
		if (!blob.memberSecretsIv || !blob.memberSecretsCiphertext) {
			throw new Error("member vault without member secrets");
		}
		const secrets = JSON.parse(
			await crypto.decryptWithVek(
				bytesToBase64(blob.memberSecretsIv),
				bytesToBase64(blob.memberSecretsCiphertext),
			),
		) as { memberId: string; memberPrivateKey: string };
		const wrap = blob.sharingWraps.find((w) => w.kind === 2 && w.memberId === secrets.memberId);
		if (wrap?.kind !== 2) throw new Error("no sharing key seal for this member");
		const shkB64 = await openMemberSeal(secrets.memberPrivateKey, {
			ephemeralPub: bytesToBase64(wrap.ephemeralPub),
			iv: bytesToBase64(wrap.iv),
			ciphertext: bytesToBase64(wrap.wrappedShk),
		} satisfies SealedKey);
		const region = JSON.parse(
			await decryptWithKey(
				shkB64,
				bytesToBase64(blob.regionIv),
				bytesToBase64(blob.regionCiphertext),
			),
		) as SyncSharingView["region"];
		const collectionKeys: Record<string, string> = {};
		for (const collection of region.collections) {
			if (!collection.memberIds.includes(secrets.memberId)) continue;
			const seal = collection.keyWraps.find(
				(w) => w.target === "member" && w.memberId === secrets.memberId,
			);
			if (seal?.target !== "member") continue;
			collectionKeys[collection.id] = await openMemberSeal(secrets.memberPrivateKey, seal);
		}
		return { role: "member", region, collectionKeys };
	}

	// Owner path: the loaded key is the vault key; it opens the owner wrap and
	// every collection's owner wrap.
	const ownerWrap = blob.sharingWraps.find((w) => w.kind === 1);
	if (ownerWrap?.kind !== 1) throw new Error("no owner sharing-key wrap");
	const shkB64 = await crypto.decryptWithVek(
		bytesToBase64(ownerWrap.iv),
		bytesToBase64(ownerWrap.wrappedShk),
	);
	const region = JSON.parse(
		await decryptWithKey(
			shkB64,
			bytesToBase64(blob.regionIv),
			bytesToBase64(blob.regionCiphertext),
		),
	) as SyncSharingView["region"];
	const collectionKeys: Record<string, string> = {};
	for (const collection of region.collections) {
		const wrap = collection.keyWraps.find((w) => w.target === "owner");
		if (wrap?.target !== "owner") continue;
		collectionKeys[collection.id] = await crypto.decryptWithVek(wrap.iv, wrap.ciphertext);
	}
	return { role: "owner", region, collectionKeys };
}

/** The localization crypto, over the loaded key plus the pure TS collection-key
 * unwrap. Pair with buildSyncSharingView. */
export function localizeDepsFromCrypto(crypto: SyncViewCrypto): LocalizeDeps {
	return {
		tryUnwrapLocal: async (envelope) => {
			try {
				return await crypto.decryptWithVek(envelope.dekIv, envelope.wrappedDek);
			} catch {
				return null;
			}
		},
		wrapLocal: async (dek) => {
			const w = await crypto.encryptWithVek(dek);
			return { dekIv: w.iv, wrappedDek: w.ciphertext };
		},
		tryUnwrapWithKey: tryDecryptWithKey,
	};
}
