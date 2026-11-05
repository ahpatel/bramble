/// <reference types="chrome" />

// Chrome delivery for the passkey provider: chrome.webAuthenticationProxy. Registers the
// create/get/isUvpaa listeners, attaches the proxy on opt-in, and binds each request to the page
// that made it. The transport-free deps it drives (ceremony, vault IO, crypto, enabled flag) live
// in ./webauthn-provider, shared with the Firefox content-script transport. See
// docs/passkey-provider.md.

import { api } from "../platform-api";
import { getPasskeyPausedSites, rememberPasskeyPausedSite } from "./prefs";
import { whenReady } from "./router";
import { isRegistrableSuffix, proxyCaller, type RequestCaller } from "./webauthn-json";
import { depsForTab, isProviderEnabled, setProviderApplyHook } from "./webauthn-provider";
import {
	type CreateCompletion,
	type GetCompletion,
	handleCreate,
	handleGet,
	NATIVE_FALLBACK_MESSAGE,
	NOT_ALLOWED,
} from "./webauthn-proxy";

/** The tab the user is looking at: where the card shows, and its origin when readable. */
async function focusedTab(): Promise<{ id: number; origin: string | null } | null> {
	try {
		const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
		if (tab?.id === undefined) return null;
		let origin: string | null = null;
		try {
			origin = tab.url ? new URL(tab.url).origin : null;
		} catch {}
		return { id: tab.id, origin };
	} catch {
		return null;
	}
}

/**
 * The requester (Chrome's stamp) and the tab its card goes to, or null to refuse. WebAuthn needs a
 * focused page but Chrome skips that check on the proxy path, so a top-level request must come
 * from the focused tab: otherwise a background tab on a sibling subdomain could borrow this tab's
 * approval. A cross-origin iframe can't be matched to a tab; its card names it instead.
 */
async function bindRequest(json: string): Promise<{ caller: RequestCaller; tabId: number } | null> {
	const caller = proxyCaller(json);
	const tab = await focusedTab();
	if (!caller || !tab) return null;
	if (!caller.crossOrigin && caller.origin !== tab.origin) return null;
	return { caller, tabId: tab.id };
}

// ---- the native-fallback bypass window ----
//
// Chrome's proxy has NO per-request passthrough: while attached, every WebAuthn call in
// the browser comes to us, and completing a request with an error never falls through
// to the platform authenticator. The only way a request reaches Touch ID / iCloud
// Keychain / a YubiKey is for us to be detached. So the card's "use another
// authenticator" opens a WINDOW instead of flipping Settings:
//
//   complete the request with the handoff message -> detach -> the site's retry goes
//   native -> re-attach when the initiating tab navigates or closes, or after the
//   safety timeout. The badge reads "⏸" the whole time; the Settings pref is never
//   touched (the toggle stays its only writer), so this is a pause, not a config change.
//
// The window state lives in storage.session (survives worker death, dies with the
// browser) and is rehydrated at startup from background.ts's `hydrated` chain, so a
// worker napped mid-window neither re-attaches on boot nor forgets the deadline. The
// one-shot alarm is the timeout's durable half: tab events are checked when any wake
// delivers them, the alarm guarantees one wake at the deadline itself.

/** How long a forgotten window can hold the proxy detached. Navigation/close is the
 *  expected trigger; this is the fallback, generous enough that a step-up MFA flow
 *  (retry, key tap, enrollment) never re-attaches mid-ceremony. */
const BYPASS_WINDOW_MS = 10 * 60_000;
/** storage.session key; matches nothing else in the session area. */
const BYPASS_STATE_KEY = "passkeyBypassWindow";
/** One-shot alarm that wakes the worker to close an expired window. */
const BYPASS_ALARM_NAME = "passkey-bypass-window";

let bypassUntil = 0; // epoch ms; 0 = no window
let bypassTabId: number | undefined;

export function isBypassOpen(): boolean {
	return bypassUntil !== 0 && Date.now() < bypassUntil;
}

/** Open the window: fail any other in-flight request with the handoff reason (the
 *  detach is about to abort them bare), detach, then record state + badge. Called by
 *  the Chrome delivery layer AFTER completing the request with the handoff message:
 *  the order is load-bearing, as with the pause. */
async function openBypassWindow(tabId: number | undefined): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined") return; // Firefox relays; no window
	await failInFlightRequests(NATIVE_FALLBACK_MESSAGE);
	try {
		await detachWebauthnProxy();
	} catch (e) {
		// Stay attached and serve the retry ourselves: a half-open window (recorded as
		// detached, actually attached) would block re-attach and dead-end the user worse
		// than a bypass that never opened.
		console.error("[passkey] bypass-window detach failed; window stays closed", e);
		return;
	}
	bypassUntil = Date.now() + BYPASS_WINDOW_MS;
	bypassTabId = tabId;
	try {
		await api.storage.session.set({ [BYPASS_STATE_KEY]: { tabId, until: bypassUntil } });
	} catch {}
	try {
		await api.alarms.create(BYPASS_ALARM_NAME, { when: bypassUntil });
	} catch {}
	try {
		await api.action.setBadgeText({ text: "⏸" });
	} catch {}
}

/** Close the window and re-attach if the user still wants the provider. Every trigger
 *  (navigation, tab close, expiry) funnels through here; the attached-guard inside
 *  initWebauthnProxy makes repeats harmless, and a worker death mid-window is fine
 *  because rehydrateBypassWindow restores the deadline before any trigger checks it. */
async function resumeAfterBypass(): Promise<void> {
	if (bypassUntil === 0) return;
	bypassUntil = 0;
	bypassTabId = undefined;
	try {
		await api.storage.session.remove(BYPASS_STATE_KEY);
	} catch {}
	try {
		await api.alarms.clear(BYPASS_ALARM_NAME);
	} catch {}
	try {
		await api.action.setBadgeText({ text: "" });
	} catch {}
	// The pref is the durable state and was never written; re-check it (the user can
	// have toggled off mid-window) and let initWebauthnProxy defer if our own unlock
	// ceremony holds a pause at this moment.
	if (isProviderEnabled()) await initWebauthnProxy();
}

/** Close a window whose time is up. Rides on every wake the window's listeners see
 *  (any tab event, the deadline alarm). */
async function checkBypassExpiry(): Promise<void> {
	if (bypassUntil !== 0 && Date.now() >= bypassUntil) await resumeAfterBypass();
}

/** Restore an open window's in-memory state after a worker wake, before any attach
 *  path runs (background.ts folds this into `hydrated`). A window that outlived the
 *  nap ends now: the record is cleared, and the boot attach proceeds. */
export async function rehydrateBypassWindow(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined") return;
	try {
		const stored = (await api.storage.session.get(BYPASS_STATE_KEY))[BYPASS_STATE_KEY] as
			| { tabId?: number; until: number }
			| undefined;
		if (!stored?.until) return;
		if (stored.until > Date.now()) {
			bypassUntil = stored.until;
			bypassTabId = stored.tabId;
			try {
				await api.action.setBadgeText({ text: "⏸" });
			} catch {}
		} else {
			try {
				await api.storage.session.remove(BYPASS_STATE_KEY);
			} catch {}
		}
	} catch {}
}

/** Keep an open window pointed at the tab the user is actually on. A pause is global
 *  while it lasts, so following the active paused tab is the closest the API allows to a
 *  per-site exclusion. */
async function retargetBypassWindow(tabId: number): Promise<void> {
	if (bypassUntil === 0) return;
	bypassTabId = tabId;
	try {
		await api.storage.session.set({ [BYPASS_STATE_KEY]: { tabId, until: bypassUntil } });
	} catch {}
}

/** Whether `hostname` belongs to a site the user chose to always bypass. */
async function isPausedSite(hostname: string): Promise<boolean> {
	const sites = await getPasskeyPausedSites();
	for (const site of sites) {
		if (isRegistrableSuffix(hostname, site)) return true;
	}
	return false;
}

/** Auto-pause for a remembered site: when the active tab is on one, detach before its
 *  first WebAuthn call instead of showing a card. Chrome's proxy is browser-wide, so
 *  this is a site-scoped pause; Firefox passes the request through per origin instead
 *  (webauthn-content-transport). */
async function autoPauseForTab(tabId: number, url: string | undefined): Promise<void> {
	if (!url || !isProviderEnabled() || pauseDepth > 0) return;
	let hostname: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
		hostname = parsed.hostname;
	} catch {
		return;
	}
	if (!(await isPausedSite(hostname))) return;
	if (isBypassOpen()) {
		if (bypassTabId !== tabId) await retargetBypassWindow(tabId);
		return;
	}
	await openBypassWindow(tabId);
}

// Re-attach triggers, registered at module scope like the request listeners: MV3
// listeners do not outlive the worker, so every wake re-registers them. tabs.onUpdated
// needs no permission for what we use (tabId and changeInfo.status are unredacted; the
// URL is read only to match the user's remembered sites), and any tab activity is also
// the wake the expiry check rides on. whenReady first: on a fresh wake these listeners
// can be the first thing to run, and the state they read exists only after rehydration
// lands.
api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	void (async () => {
		await whenReady();
		await checkBypassExpiry();
		// Any committed navigation in the bypassed tab ends the window: login flows
		// redirect after the native ceremony (often same-origin), and the retry has
		// already gone native.
		if (bypassTabId === tabId && changeInfo.status === "loading") await resumeAfterBypass();
		if (changeInfo.status === "loading" && tab?.active) await autoPauseForTab(tabId, tab.url);
	})().catch(() => {});
});
api.tabs.onActivated.addListener(({ tabId }) => {
	void (async () => {
		await whenReady();
		await checkBypassExpiry();
		const tab = await api.tabs.get(tabId).catch(() => undefined);
		await autoPauseForTab(tabId, tab?.url);
	})().catch(() => {});
});
api.tabs.onRemoved.addListener((tabId) => {
	void (async () => {
		await whenReady();
		if (bypassTabId === tabId) await resumeAfterBypass();
	})().catch(() => {});
});
api.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === BYPASS_ALARM_NAME) {
		void (async () => {
			await whenReady();
			await checkBypassExpiry();
		})().catch(() => {});
	}
});

// Pause the proxy while Bramble runs its OWN WebAuthn (security-key PRF) ceremony, so
// attach()'s browser-wide interception doesn't hijack our unlock. The popup/options send
// PAUSE before navigator.credentials and RESUME after (see webauthn-ceremony pauser).
// Depth-counted, but nothing nests today: createPrfCredential's create() and its fallback
// get() are SEQUENTIAL, each with its own pause cycle (webauthn-ceremony.ts), so the depth
// never exceeds 1. Firefox never fires this (security keys disabled there,
// and the override doesn't touch the extension's own moz-extension origin). See
// docs/passkey-provider.md.
let pauseDepth = 0;
let pausedWhileAttached = false;

// Requests Chrome has handed us and we have not answered yet. Detaching kills them: measured,
// the page gets a bare `AbortError` and onRequestCanceled never fires, so we would not otherwise
// know. Answering first gives the site a reason, and clearing the map stops the ceremony from
// walking the user through a picker for a request that no longer exists.
type Kind = "create" | "get";
const inFlight = new Map<number, Kind>();

// Create and get answers share one shape.
function complete(
	kind: Kind,
	details: chrome.webAuthenticationProxy.CreateResponseDetails,
): Promise<void> {
	return kind === "create"
		? api.webAuthenticationProxy.completeCreateRequest(details)
		: api.webAuthenticationProxy.completeGetRequest(details);
}

/**
 * Complete a request through the proxy. When the ceremony handed the request to the
 * user's other authenticators (`nativeFallback`, set by the "use another authenticator"
 * card action), open the bypass window AFTER completing. The order is load-bearing:
 * detaching an in-flight request aborts it with a bare AbortError (measured,
 * docs/passkey-provider.md), which would eat the handoff message the user just acted on.
 * The marker is stripped before the call: complete* validates the W3C response shape,
 * and the marker is ours, not Chrome's.
 */
async function completeViaProxy(
	kind: Kind,
	details: (CreateCompletion | GetCompletion) & { nativeFallback?: boolean },
	tabId: number | undefined,
): Promise<void> {
	const handoff = details.nativeFallback === true;
	const rememberSite = details.rememberSite;
	delete details.nativeFallback;
	delete details.rememberSite;
	try {
		await complete(kind, details);
	} catch (e) {
		// A malformed responseJson rejects here; error the request so the page's call fails
		// fast instead of hanging forever ("nothing happens").
		console.error(`[passkey] completing a ${kind} request failed`, e);
		await complete(kind, { requestId: details.requestId, error: NOT_ALLOWED }).catch(() => {});
	}
	// Chrome's proxy has no passthrough, so the handoff opens the bypass window:
	// detached until the initiating tab is left, the site's retry reaches the platform
	// authenticator (Touch ID, iCloud Keychain, a YubiKey), which is the Cloudflare
	// Access step-up case from the filing.
	if (handoff) {
		if (rememberSite) await rememberPasskeyPausedSite(rememberSite);
		await openBypassWindow(tabId);
	}
}

async function failInFlightRequests(reason: string): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined" || inFlight.size === 0) return;
	const pending = [...inFlight];
	inFlight.clear();
	for (const [requestId, kind] of pending) {
		const error = { name: "NotAllowedError", message: reason };
		await complete(kind, { requestId, error }).catch(() => {});
	}
}

const HANDLERS = { create: handleCreate, get: handleGet } as const;

// Answer one proxied request: bind it to its page, run the ceremony, complete it once.
function serve(kind: Kind, req: { requestId: number; requestDetailsJson: string }): void {
	inFlight.set(req.requestId, kind);
	void (async () => {
		// These listeners bypass the message router, so await hydration ourselves: on a
		// fresh SW wake the session VEK is restored asynchronously, and reading lock state
		// before it lands would wrongly prompt to unlock an already-unlocked vault.
		await whenReady();
		const bound = await bindRequest(req.requestDetailsJson);
		const details = bound
			? await HANDLERS[kind](
					depsForTab(bound.tabId),
					req.requestId,
					req.requestDetailsJson,
					bound.caller,
				)
			: { requestId: req.requestId, error: NOT_ALLOWED };
		// Gone means a pause already failed it; completing again throws "Invalid sender".
		if (!inFlight.delete(req.requestId)) return;
		await completeViaProxy(kind, details, bound?.tabId);
	})();
}

/** The pause port's name. Must match the pauser in shell.ts (extension-view side). */
export const PASSKEY_PAUSE_PORT = "tp-passkey-pause";

async function pauseForCeremony(): Promise<void> {
	if (pauseDepth === 0 && attached) {
		pausedWhileAttached = true;
		await failInFlightRequests(
			"Bramble paused passkey handling to unlock its own vault. Try again.",
		);
		await detachWebauthnProxy();
	}
	pauseDepth++;
}

async function resumeAfterCeremony(): Promise<void> {
	if (pauseDepth > 0) pauseDepth--;
	if (pauseDepth === 0 && pausedWhileAttached) {
		pausedWhileAttached = false;
		// Re-check the pref: the user can toggle the provider off mid-ceremony, and the toggle's
		// own detach is a no-op while we are already paused-detached. A bypass window open
		// since the pause began also stays detached: its own triggers re-attach.
		if (isProviderEnabled() && !isBypassOpen()) await initWebauthnProxy();
	}
}

// The extension pages' origin; only connections from here may hold the pause port.
const EXTENSION_ORIGIN = new URL(api.runtime.getURL("")).origin;

api.runtime.onConnect.addListener((port) => {
	if (port.name !== PASSKEY_PAUSE_PORT) return;
	// Only extension views (popup/options) may hold the pause: a content script is the
	// context a web page reaches through our own relay, so it must not be able to pause
	// or strand the provider. Fails closed: a rejected connection holds nothing.
	if (port.sender?.origin !== EXTENSION_ORIGIN) return;
	void (async () => {
		await pauseForCeremony();
		// The pauser awaits this ack before its own navigator.credentials call, so the pause
		// has landed (in-flight requests failed with a reason, proxy detached) before any
		// WebAuthn event the call can produce.
		port.postMessage({ held: true });
	})().catch(() => {});
	port.onDisconnect.addListener(() => {
		void resumeAfterCeremony();
	});
});

let listenersRegistered = false;
let attached = false;

// Register the create/get/isUvpaa listeners exactly once. detach() does not remove
// them (it only stops events firing), so re-attach must NOT re-add them.
function registerListeners(): void {
	// Firefox has no chrome.webAuthenticationProxy; addListener on an undefined
	// namespace would throw. The Settings toggle is hidden there (shell
	// supportsPasskeyProvider), but guard here too in case the pref is set directly.
	if (listenersRegistered || typeof api.webAuthenticationProxy === "undefined") return;
	listenersRegistered = true;
	api.webAuthenticationProxy.onIsUvpaaRequest.addListener((req) => {
		api.webAuthenticationProxy.completeIsUvpaaRequest({
			requestId: req.requestId,
			isUvpaa: true,
		});
	});
	api.webAuthenticationProxy.onCreateRequest.addListener((req) => serve("create", req));
	api.webAuthenticationProxy.onGetRequest.addListener((req) => serve("get", req));
}

// Registered at module scope rather than from the attach path, and this is load-bearing: the
// ATTACHMENT outlives the service worker but these listeners do not, and a request that arrives
// before they exist is dropped permanently (not queued, and no fallback to the platform
// authenticator), so the page hangs until its own timeout. Reaching registration only after an
// async pref read left that window open on every worker wake. Listeners without an attach are
// inert, so registering unconditionally costs nothing. See docs/passkey-provider.md.
registerListeners();

/**
 * Attach the proxy. Gated behind a Settings pref (default off): attach() intercepts ALL browser
 * WebAuthn, including Bramble's own security-key unlock, which is why we pause around our own
 * ceremonies. Idempotent in Chrome (a redundant attach returns no error). Needs a real Chrome
 * end-to-end.
 */
export async function initWebauthnProxy(): Promise<void> {
	if (typeof api.webAuthenticationProxy === "undefined") return; // Firefox: no proxy API
	// A bypass window is open: the user handed a request to their other authenticators,
	// and attaching now would steal the very retry the window exists to serve. The
	// window's triggers call us back when it closes.
	if (isBypassOpen()) return;
	// A ceremony is mid-flight (startup racing a PAUSE, or the toggle flipped on during one):
	// attaching now would intercept our own security-key tap. Defer to the matching RESUME.
	if (pauseDepth > 0) {
		pausedWhileAttached = true;
		return;
	}
	if (attached) return;
	const err = await api.webAuthenticationProxy.attach();
	if (err) throw new Error(`webAuthenticationProxy.attach failed: ${err}`);
	attached = true;
}

async function detachWebauthnProxy(): Promise<void> {
	if (!attached) return;
	await api.webAuthenticationProxy.detach();
	attached = false;
}

// The toggle's live effect on Chrome is attach/detach; the shared flag it also sets gates
// the request path. On Firefox this hook stays the default no-op (no attach step).
setProviderApplyHook(async (enabled) => {
	if (enabled) await initWebauthnProxy();
	else await detachWebauthnProxy();
});
