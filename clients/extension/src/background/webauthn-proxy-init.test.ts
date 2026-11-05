import { beforeEach, describe, expect, it, vi } from "vitest";

// The attach/detach state machine behind the passkey provider. Four module-level variables
// (attached, pauseDepth, pausedWhileAttached, listenersRegistered) decide whether Chrome routes
// EVERY WebAuthn call in the browser to us, so a wrong state is not a local bug: it silently
// breaks the user's other authenticators, or silently stops serving ours.
//
// The pause/resume half is PORT-shaped now (F2): the ceremony-holding extension view opens a
// runtime port; connect = pause, disconnect = resume, and the browser GUARANTEES the
// disconnect's delivery, so a popup destroyed mid-ceremony can no longer strand the resume the
// way the old PASSKEY_PROXY_PAUSE/RESUME messages could. The tests below drive both sides of
// that guarantee, plus the request-completion seam (complete first, then act on the
// "use another authenticator" handoff).
//
// vi.resetModules() is the service-worker death simulator: a fresh module graph has all four
// variables back at their initial values, which is exactly what a killed and re-woken worker
// looks like. Nothing persists them.

const PAUSE_PORT = "tp-passkey-pause";
// The origin the module derives from runtime.getURL; makePort's senders must claim it.
// Https-shaped on purpose: Node's URL parses non-special schemes (chrome-extension://)
// to the opaque-origin serialization "null", where browsers give the real origin.
const EXTENSION_ORIGIN = "https://ext.test";

const h = vi.hoisted(() => ({
	attachCalls: 0,
	detachCalls: 0,
	/** What attach() resolves to. A string is Chrome's failure mode, undefined is success. */
	attachResult: undefined as string | undefined,
	/** Firefox has no such namespace at all, which is a branch the module must survive. */
	hasProxy: true,
	/** addListener counts per event, to prove registration happens exactly once. */
	listeners: { create: 0, get: 0, isUvpaa: 0 },
	/** Router handlers the module registers, by message type. */
	handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
	/** The attach/detach hook the module hands to the provider module. */
	applyHook: undefined as ((enabled: boolean) => Promise<void>) | undefined,
	/** The persisted opt-in, which the resume path re-checks before re-attaching. */
	enabled: true,
	/** Completions we sent back to Chrome, in order. */
	completed: [] as { requestId: number; kind: string; error?: string; raw?: unknown }[],
	/** The request listeners themselves, so a test can deliver a request. */
	fire: {} as {
		create?: (r: { requestId: number; requestDetailsJson: string }) => void;
		get?: (r: { requestId: number; requestDetailsJson: string }) => void;
	},
	/** The tab the user is looking at, as tabs.query reports it. */
	activeTab: { id: 1, url: "https://example.com/page" } as { id: number; url: string } | undefined,
	/** Hold the handler mid-ceremony, which is where a real one spends most of its life. */
	holdHandler: false,
	release: undefined as (() => void) | undefined,
	/** Scripted extra fields the mocked handleCreate/handleGet return (e.g. the handoff). */
	handlerExtras: {} as Record<string, unknown>,
	/** runtime.onConnect listeners (the SW side of the pause port). */
	portListeners: [] as Array<(port: unknown) => void>,
	/** Call order across completions and detaches, to pin complete-before-detach. */
	order: [] as string[],
	/** The browser's storage.session: SURVIVES a worker death (only tests clear it). */
	sessionStore: new Map<string, unknown>(),
	/** tabs.onUpdated / onActivated / onRemoved listeners, so a test can fire tab events. */
	tabUpdated: [] as Array<
		(
			tabId: number,
			changeInfo: { status?: string },
			tab?: { url?: string; active?: boolean },
		) => void
	>,
	tabActivated: [] as Array<(info: { tabId: number }) => void>,
	tabRemoved: [] as Array<(tabId: number) => void>,
	/** Scripted paused-site list and remembered sites for the per-site auto-pause. */
	pausedSites: [] as string[],
	remembered: [] as string[],
	/** alarms.onAlarm listeners + the alarms the module created (name + fire time). */
	alarmListeners: [] as Array<(alarm: { name: string }) => void>,
	alarmsCreated: [] as { name: string; info: unknown }[],
	/** Last badge text set on the toolbar action. */
	badge: "",
}));

const proxy = {
	attach: async () => {
		h.attachCalls++;
		return h.attachResult;
	},
	detach: async () => {
		h.detachCalls++;
		h.order.push("detach");
		return undefined;
	},
	completeCreateRequest: async (d: { requestId: number; error?: { message: string } }) => {
		h.completed.push({ requestId: d.requestId, kind: "create", error: d.error?.message, raw: d });
		h.order.push("complete");
	},
	completeGetRequest: async (d: { requestId: number; error?: { message: string } }) => {
		h.completed.push({ requestId: d.requestId, kind: "get", error: d.error?.message, raw: d });
		h.order.push("complete");
	},
	completeIsUvpaaRequest: () => {},
	onCreateRequest: {
		addListener: (cb: (r: { requestId: number; requestDetailsJson: string }) => void) => {
			h.listeners.create++;
			h.fire.create = cb;
		},
	},
	onGetRequest: {
		addListener: (cb: (r: { requestId: number; requestDetailsJson: string }) => void) => {
			h.listeners.get++;
			h.fire.get = cb;
		},
	},
	onIsUvpaaRequest: {
		addListener: () => {
			h.listeners.isUvpaa++;
		},
	},
};

/** A fake runtime port: the browser-side contract is connect -> onConnect, death ->
 *  onDisconnect (guaranteed), postMessage for the pause ack. */
function makePort(name: string, senderOrigin: string = EXTENSION_ORIGIN) {
	const p: {
		name: string;
		sender: { origin: string };
		sent: unknown[];
		disconnectCbs: Array<() => void>;
		messageCbs: Array<(m: unknown) => void>;
		postMessage: (m: unknown) => void;
		onDisconnect: { addListener: (cb: () => void) => void };
		onMessage: { addListener: (cb: (m: unknown) => void) => void };
		/** The other end went away: popup close (explicit) or popup death (guaranteed). */
		close: () => void;
	} = {
		name,
		sender: { origin: senderOrigin },
		sent: [],
		disconnectCbs: [],
		messageCbs: [],
		postMessage: (m) => {
			p.sent.push(m);
		},
		onDisconnect: { addListener: (cb) => p.disconnectCbs.push(cb) },
		onMessage: { addListener: (cb) => p.messageCbs.push(cb) },
		close: () => {
			for (const cb of [...p.disconnectCbs]) cb();
		},
	};
	return p;
}

/** Connect a pause port, as the pauser in shell.ts does. */
function connectPausePort(name = PAUSE_PORT, senderOrigin = EXTENSION_ORIGIN) {
	const port = makePort(name, senderOrigin);
	for (const cb of h.portListeners) cb(port);
	return port;
}

vi.mock("../platform-api", () => ({
	api: {
		// A getter so one test can be Firefox (namespace absent) without a second mock.
		get webAuthenticationProxy() {
			return h.hasProxy ? proxy : undefined;
		},
		tabs: {
			query: async () => (h.activeTab ? [h.activeTab] : []),
			get: async (tabId: number) => (h.activeTab?.id === tabId ? h.activeTab : undefined),
			onUpdated: {
				addListener: (
					cb: (
						tabId: number,
						c: { status?: string },
						tab?: { url?: string; active?: boolean },
					) => void,
				) => h.tabUpdated.push(cb),
			},
			onActivated: {
				addListener: (cb: (info: { tabId: number }) => void) => h.tabActivated.push(cb),
			},
			onRemoved: { addListener: (cb: (tabId: number) => void) => h.tabRemoved.push(cb) },
		},
		runtime: {
			// Must match EXTENSION_ORIGIN above; the pause port accepts only this origin.
			getURL: (p: string) => `https://ext.test/${p}`,
			onConnect: {
				addListener: (cb: (port: unknown) => void) => h.portListeners.push(cb),
			},
		},
		storage: {
			session: {
				get: async (key: string) =>
					h.sessionStore.has(key) ? { [key]: h.sessionStore.get(key) } : {},
				set: async (kv: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(kv)) h.sessionStore.set(k, v);
				},
				remove: async (key: string) => {
					h.sessionStore.delete(key);
				},
			},
		},
		alarms: {
			create: (name: string, info: unknown) => {
				h.alarmsCreated.push({ name, info });
			},
			clear: async (name: string) => {
				const before = h.alarmsCreated.length;
				h.alarmsCreated = h.alarmsCreated.filter((a) => a.name !== name);
				return h.alarmsCreated.length < before;
			},
			onAlarm: {
				addListener: (cb: (alarm: { name: string }) => void) => h.alarmListeners.push(cb),
			},
		},
		action: {
			setBadgeText: async ({ text }: { text: string }) => {
				h.badge = text;
			},
		},
	},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
	// Resolved, or the proxy listeners would hang waiting on hydration.
	whenReady: async () => {},
}));

vi.mock("./prefs", () => ({
	getPasskeyPausedSites: async () => new Set(h.pausedSites),
	rememberPasskeyPausedSite: async (site: string) => {
		h.remembered.push(site);
	},
}));

vi.mock("./webauthn-provider", () => ({
	depsForTab: (tabId: number) => ({ tabId }),
	isProviderEnabled: () => h.enabled,
	setProviderApplyHook: (fn: (enabled: boolean) => Promise<void>) => {
		h.applyHook = fn;
	},
}));

// Echo the requestId back, as the real handlers do; the tests below key on it. `holdHandler`
// parks the handler where a real ceremony sits: awaiting the user, for up to two minutes.
const answer = (requestId: number) => {
	if (!h.holdHandler) {
		return Promise.resolve({ requestId, responseJson: "{}", ...h.handlerExtras });
	}
	return new Promise((resolve) => {
		h.release = () => resolve({ requestId, responseJson: "{}", ...h.handlerExtras });
	});
};

vi.mock("./webauthn-proxy", () => ({
	NOT_ALLOWED: { name: "NotAllowedError", message: "not allowed" },
	NATIVE_FALLBACK_MESSAGE:
		"No Bramble passkey can serve this request. Continue with another authenticator.",
	handleCreate: vi.fn((_deps: unknown, requestId: number) => answer(requestId)),
	handleGet: vi.fn((_deps: unknown, requestId: number) => answer(requestId)),
}));

/** Fresh module state, as a re-woken service worker has. `hasProxy: false` is Firefox, and must
 *  be set before the import now that listener registration happens at module scope. */
async function load({ hasProxy = true } = {}) {
	vi.resetModules();
	h.attachCalls = 0;
	h.detachCalls = 0;
	h.attachResult = undefined;
	h.hasProxy = hasProxy;
	h.listeners = { create: 0, get: 0, isUvpaa: 0 };
	h.handlers.clear();
	h.applyHook = undefined;
	h.enabled = true;
	h.completed = [];
	h.fire = {};
	h.holdHandler = false;
	h.release = undefined;
	h.handlerExtras = {};
	h.portListeners = [];
	h.tabUpdated = [];
	h.tabActivated = [];
	h.tabRemoved = [];
	h.alarmListeners = [];
	h.order = [];
	h.badge = "";
	h.pausedSites = [];
	h.remembered = [];
	h.activeTab = { id: 1, url: "https://example.com/page" };
	return import("./webauthn-proxy-init");
}

/** Let the listener's async body run to the point where it would complete the request. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Fire a tabs.onUpdated event as the browser would. */
const tabNavigated = async (
	tabId: number,
	status = "loading",
	url = "https://example.com/page",
	active = true,
) => {
	for (const cb of [...h.tabUpdated]) cb(tabId, { status }, { url, active });
	await settle();
};

/** Fire a tabs.onActivated event as the browser would. */
const tabActivated = async (tabId: number) => {
	for (const cb of [...h.tabActivated]) cb({ tabId });
	await settle();
};

/** Fire a tabs.onRemoved event as the browser would. */
const tabClosed = async (tabId: number) => {
	for (const cb of [...h.tabRemoved]) cb(tabId);
	await settle();
};

/** Open a handoff request that completes with the native-fallback marker, and settle. */
async function fireHandoff(requestId: number) {
	h.handlerExtras = { nativeFallback: true };
	h.fire.get?.({ requestId, requestDetailsJson: stamped() });
	await settle();
}

beforeEach(() => {
	vi.clearAllMocks();
	h.sessionStore.clear();
	h.alarmsCreated = [];
	vi.useRealTimers();
});

/** A proxied request as Chrome delivers it: stamped with the page that really asked. */
const stamped = (origin = "https://example.com", sameOriginWithAncestors = true) =>
	JSON.stringify({
		challenge: "Y2hhbA",
		extensions: { remoteDesktopClientOverride: { origin, sameOriginWithAncestors } },
	});

describe("initWebauthnProxy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers listeners at import, before anything attaches", async () => {
		// The window this closes: attachment survives worker death, listeners do not, and a
		// request arriving before they exist is lost for good.
		await load();
		expect(h.listeners).toEqual({ create: 1, get: 1, isUvpaa: 1 });
		expect(h.attachCalls).toBe(0);
	});

	it("attaches once and registers each listener exactly once across re-init", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(1);
		expect(h.listeners).toEqual({ create: 1, get: 1, isUvpaa: 1 });
	});

	it("does nothing on a platform without the proxy namespace", async () => {
		const m = await load({ hasProxy: false }); // Firefox
		await expect(m.initWebauthnProxy()).resolves.toBeUndefined();
		expect(h.attachCalls).toBe(0);
		expect(h.listeners).toEqual({ create: 0, get: 0, isUvpaa: 0 });
	});

	it("propagates an attach failure and stays retryable", async () => {
		const m = await load();
		h.attachResult = "another extension is attached";
		await expect(m.initWebauthnProxy()).rejects.toThrow(/another extension is attached/);
		// `attached` was never set, so a later attempt still tries.
		h.attachResult = undefined;
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(2);
	});
});

describe("pause and resume (a runtime port, F2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers the port listener at module scope on every platform (inert without a proxy)", async () => {
		// Chrome: it pauses on connect. Firefox: there is no proxy to pause, but the pauser
		// still connects (platform-key PRF ceremonies run there too), and it must get its
		// ack (otherwise the popup's capped ack wait adds a delay to every unlock).
		const _m = await load();
		expect(h.portListeners).toHaveLength(1);
		const _firefox = await load({ hasProxy: false });
		expect(h.portListeners).toHaveLength(1);
		const port = connectPausePort();
		await settle();
		expect(port.sent).toEqual([{ held: true }]); // the ack still arrives
		expect(h.detachCalls).toBe(0); // ...while the pause itself no-ops
		port.close();
		expect(h.attachCalls).toBe(0);
	});

	it("ignores a port with another name", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		connectPausePort("some-other-port").close();
		await settle();
		expect(h.detachCalls).toBe(0);
	});

	it("rejects a pause connection from a web page's context", async () => {
		// A content script is the context a compromised page reaches through our relay; it
		// must not be able to pause (or strand) the provider by holding the port.
		const m = await load();
		await m.initWebauthnProxy();
		const port = connectPausePort(PAUSE_PORT, "https://evil.example");
		await settle();
		expect(port.sent).toEqual([]); // no ack: nothing was paused
		port.close(); // dropping it must not resume anything either
		expect(h.detachCalls).toBe(0);
		expect(h.attachCalls).toBe(1);
	});

	it("detaches for the ceremony and re-attaches when its port closes", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		const port = connectPausePort();
		await settle();
		expect(h.detachCalls).toBe(1);
		port.close();
		expect(h.attachCalls).toBe(2);
	});

	it("acks the pause over the port, so the caller runs its ceremony only once it landed", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		const port = connectPausePort();
		await settle();
		expect(port.sent).toEqual([{ held: true }]);
	});

	it("re-attaches only at depth zero when pauses nest (one port per ceremony)", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		const a = connectPausePort();
		await settle();
		const b = connectPausePort();
		await settle();
		expect(h.detachCalls).toBe(1); // the second pause adds depth, not another detach
		a.close();
		expect(h.attachCalls).toBe(1); // still inside b's pause
		b.close();
		expect(h.attachCalls).toBe(2);
	});

	it("does not attach on resume when the pause began while detached", async () => {
		await load();
		const port = connectPausePort();
		await settle();
		port.close();
		expect(h.attachCalls).toBe(0);
	});

	it("FIXED (was HOLE): a popup destroyed mid-ceremony cannot strand the pause", async () => {
		// The old RESUME message died with the popup; the depth never returned to zero. The
		// port's disconnect delivery is browser-guaranteed, so the popup "dying" (its end of
		// the port dropping) is itself the resume.
		const m = await load();
		await m.initWebauthnProxy();
		const port = connectPausePort(); // ceremony starts, proxy detaches
		await settle();
		// ...popup is destroyed here. No explicit anything: the port drop is the resume.
		port.close();
		expect(h.detachCalls).toBe(1);
		expect(h.attachCalls).toBe(2); // recovered, not stranded

		// And the next full cycle is unaffected by the wreckage of the last one.
		await settle(); // let the re-attach land (a real second ceremony starts much later)
		const next = connectPausePort();
		await settle();
		next.close();
		expect(h.attachCalls).toBe(3);
	});

	it("FIXED (was HOLE): a worker death mid-pause re-pauses on the popup's reconnect", async () => {
		// Old behaviour: the revived worker had no pause it could observe, so its startup
		// attach re-attached and hijacked the very ceremony the popup was running. Now the
		// popup's port drops on worker death and its reconnect is a pause the new worker sees.
		const m = await load();
		await m.initWebauthnProxy();
		const _port = connectPausePort(); // the popup's ceremony starts...
		await settle();
		expect(h.detachCalls).toBe(1);

		const revived = await load(); // ...and the worker dies under it (counters reset)
		await revived.initWebauthnProxy(); // startup attach (the old hole)
		expect(h.attachCalls).toBe(1);

		// The popup's pauser notices the drop and reconnects: the revived worker pauses.
		const reconnected = connectPausePort();
		await settle();
		expect(h.detachCalls).toBe(1);
		reconnected.close();
		expect(h.attachCalls).toBe(2);
	});

	it("does not resurrect a proxy the user turned off mid-ceremony", async () => {
		// The toggle's own detach is a no-op while we are already paused-detached, so the
		// resume path is the only place left to notice. Without the pref re-check this
		// re-attached with the pref off.
		const m = await load();
		await m.initWebauthnProxy();
		const port = connectPausePort();
		await settle();
		await h.applyHook?.(false);
		h.enabled = false;
		expect(h.detachCalls).toBe(1); // the toggle's detach did nothing; the pause had already detached
		port.close();
		expect(h.attachCalls).toBe(1); // still just the original attach
	});

	it("defers a startup attach that lands during a ceremony", async () => {
		// PAUSE before the startup attach: attaching anyway would intercept our own
		// security-key tap, since the proxy does NOT exempt our extension origin.
		const m = await load();
		const port = connectPausePort();
		await settle();
		await m.initWebauthnProxy();
		expect(h.attachCalls).toBe(0);
		port.close(); // the deferred attach lands when the ceremony ends
		expect(h.attachCalls).toBe(1);
	});
});

describe("in-flight requests during a pause", () => {
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("fails a request the pause is about to kill, with a reason", async () => {
		// Detaching aborts it anyway, but as a bare AbortError with onRequestCanceled never
		// firing, so the site gets no reason and we would not know to stop the ceremony.
		const m = await load();
		await m.initWebauthnProxy();
		h.holdHandler = true;
		h.fire.get?.({ requestId: 42, requestDetailsJson: stamped() });
		await settle(); // the ceremony is now awaiting the user

		connectPausePort();
		await settle();
		expect(h.completed).toEqual([
			{
				requestId: 42,
				kind: "get",
				error: expect.stringContaining("paused passkey handling"),
				raw: expect.anything(),
			},
		]);
	});

	it("does not complete a request twice when the ceremony finishes after the pause", async () => {
		// The second completion throws "Invalid sender", and the user has been walked through a
		// picker for a request that no longer exists.
		const m = await load();
		await m.initWebauthnProxy();
		h.holdHandler = true;
		h.fire.get?.({ requestId: 7, requestDetailsJson: stamped() });
		await settle();
		connectPausePort();
		await settle();
		h.completed = []; // drop the pause's own failure; we care about what comes after
		h.release?.(); // the user finally finishes the ceremony
		await settle();
		expect(h.completed).toEqual([]);
	});

	it("completes normally when no pause interrupts", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 9, requestDetailsJson: stamped() });
		await settle();
		expect(h.completed).toEqual([
			{ requestId: 9, kind: "get", error: undefined, raw: expect.anything() },
		]);
	});
});

describe("the native-fallback bypass window (use another authenticator)", () => {
	const BYPASS_KEY = "passkeyBypassWindow";

	it("completes the request FIRST, then opens the window (detach, badge, session record)", async () => {
		// Detaching an in-flight request aborts it with a bare AbortError, which would eat
		// the handoff message the user just acted on. The order is the contract.
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(11);
		expect(h.order).toEqual(["complete", "detach"]);
		expect(h.badge).toBe("⏸"); // the pause is visible, not silent
		const record = h.sessionStore.get(BYPASS_KEY) as { tabId?: number; until: number };
		expect(record.tabId).toBe(1); // the active tab: the window's triggers key off it
		expect(record.until).toBeGreaterThan(Date.now());
		expect(h.alarmsCreated[0]?.name).toBe("passkey-bypass-window"); // the timeout's durable half
	});

	it("strips the handoff marker before handing Chrome the completion", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.handlerExtras = { nativeFallback: true };
		h.fire.create?.({ requestId: 12, requestDetailsJson: stamped() });
		await settle();
		const raw = h.completed[0]?.raw as Record<string, unknown>;
		expect(raw.nativeFallback).toBeUndefined(); // ours, not Chrome's
	});

	it("a normal completion never opens a window", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 13, requestDetailsJson: stamped() });
		await settle();
		expect(h.detachCalls).toBe(0);
		expect(h.badge).toBe("");
		expect(h.sessionStore.has(BYPASS_KEY)).toBe(false);
	});

	it("fails another in-flight request with the handoff reason before detaching", async () => {
		// The detach is about to abort it bare anyway (measured: AbortError, no cancel
		// event), so complete it with a reason first: the handoff's, not the pause's.
		const m = await load();
		await m.initWebauthnProxy();
		h.holdHandler = true;
		h.fire.get?.({ requestId: 21, requestDetailsJson: stamped() }); // tab A awaits its user
		await settle();
		h.handlerExtras = { nativeFallback: true };
		h.fire.get?.({ requestId: 22, requestDetailsJson: stamped() }); // tab B hands off
		await settle();
		h.release?.(); // release the second holder: request 22 completes with the handoff
		await settle();
		expect(h.completed).toEqual([
			{ requestId: 22, kind: "get", error: undefined, raw: expect.anything() },
			{
				requestId: 21,
				kind: "get",
				error: expect.stringContaining("another authenticator"),
				raw: expect.anything(),
			},
		]);
	});

	it("stays detached while the window is open: a mid-window attach defers", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(14);
		expect(h.detachCalls).toBe(1);
		await m.initWebauthnProxy(); // e.g. a boot attach or a toggle-on mid-window
		expect(h.attachCalls).toBe(1); // deferred: attaching would steal the native retry
	});

	it("re-attaches when the bypassed tab navigates (any destination)", async () => {
		// Login flows redirect after the native ceremony, often same-origin, so the
		// trigger is any committed navigation in the tab, not an origin change.
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(15);
		await tabNavigated(99); // another tab: ignored
		expect(h.attachCalls).toBe(1);
		await tabNavigated(1); // the bypassed tab
		expect(h.attachCalls).toBe(2); // resumed
		expect(h.badge).toBe("");
		expect(h.sessionStore.has(BYPASS_KEY)).toBe(false);
	});

	it("re-attaches when the bypassed tab closes", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(16);
		await tabClosed(1);
		expect(h.attachCalls).toBe(2);
	});

	it("closes an expired window on any tab event (the timeout cannot linger)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(17);
		vi.setSystemTime(Date.now() + 10 * 60_000 + 1); // the safety timeout lapses
		await tabNavigated(99, "complete"); // any tab activity delivers the check
		expect(h.attachCalls).toBe(2);
		expect(h.badge).toBe("");
		vi.useRealTimers();
	});

	it("does not re-attach when the user turned the provider off mid-window", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(18);
		h.enabled = false; // the Settings toggle's flag
		await tabNavigated(1);
		expect(h.attachCalls).toBe(1); // still just the original attach
	});

	it("a pause inside an open window resumes without re-attaching (the window outlives it)", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(19);
		const port = connectPausePort(); // Bramble's own unlock ceremony begins
		await settle();
		expect(h.detachCalls).toBe(1); // already detached by the window: no second detach
		port.close(); // ceremony ends
		await settle();
		expect(h.attachCalls).toBe(1); // resume did NOT re-attach: window still open
	});

	it("an expired window defers its re-attach behind an in-flight pause", async () => {
		// The popup's security-key unlock (a pause) is running when the window lapses;
		// attaching now would hijack that very ceremony.
		vi.useFakeTimers({ toFake: ["Date"] });
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(20);
		const port = connectPausePort();
		await settle();
		vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
		await tabNavigated(99, "complete"); // expiry lands inside the pause
		expect(h.attachCalls).toBe(1); // deferred, not hijacking
		port.close(); // the ceremony ends; the deferred attach lands
		await settle();
		expect(h.attachCalls).toBe(2);
		vi.useRealTimers();
	});

	it("rehydrates an open window across a worker wake, and no boot attach steals it", async () => {
		// The worker naps mid-window (often: it naps ~30s after the handoff). The
		// revived worker must read the record BEFORE attaching, or the boot attach would
		// intercept the native retry the window exists to serve.
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(23);
		expect(m.isBypassOpen()).toBe(true);

		const revived = await load(); // worker death: module state resets, session persists
		await revived.rehydrateBypassWindow();
		expect(revived.isBypassOpen()).toBe(true); // the record survives, deadline intact
		expect(h.badge).toBe("⏸"); // re-armed so the user still sees the pause
		await revived.initWebauthnProxy(); // the boot attach
		expect(h.attachCalls).toBe(0); // deferred by the open window
		await tabNavigated(1); // the bypassed tab navigates
		expect(h.attachCalls).toBe(1); // resumed, once
	});

	it("a window that outlived the worker nap ends at rehydration", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(24);
		vi.setSystemTime(Date.now() + 11 * 60_000); // the nap outlasts the window
		const revived = await load();
		await revived.rehydrateBypassWindow();
		expect(revived.isBypassOpen()).toBe(false);
		expect(h.sessionStore.has(BYPASS_KEY)).toBe(false); // the stale record is cleared
		await revived.initWebauthnProxy(); // the boot attach proceeds
		expect(h.attachCalls).toBe(1);
		vi.useRealTimers();
	});

	it("opens no window on Firefox, where the shim relays per request", async () => {
		const m = await load({ hasProxy: false });
		await m.initWebauthnProxy(); // inert: no proxy namespace
		h.handlerExtras = { nativeFallback: true };
		h.fire.get?.({ requestId: 25, requestDetailsJson: stamped() }); // listeners never registered on Firefox
		await settle();
		expect(h.detachCalls).toBe(0);
		expect(h.sessionStore.has(BYPASS_KEY)).toBe(false);
	});

	it("remembers the site when the card asked to", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.handlerExtras = { nativeFallback: true, rememberSite: "example.com" };
		h.fire.get?.({ requestId: 26, requestDetailsJson: stamped() });
		await settle();
		expect(h.remembered).toEqual(["example.com"]);
		expect(h.badge).toBe("⏸");
	});

	it("auto-pauses when the active tab lands on a remembered site", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.pausedSites = ["example.com"];
		await tabNavigated(1, "loading", "https://example.com/login");
		expect(h.detachCalls).toBe(1);
		expect(h.badge).toBe("⏸");
		const record = h.sessionStore.get(BYPASS_KEY) as { tabId?: number };
		expect(record.tabId).toBe(1);
	});

	it("does not auto-pause a site that is not remembered", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.pausedSites = ["remembered.example"];
		await tabNavigated(1, "loading", "https://other.example/");
		expect(h.detachCalls).toBe(0);
		expect(h.badge).toBe("");
	});

	it("retargets an open window to the active remembered tab", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		await fireHandoff(27); // window starts on tab 1
		h.pausedSites = ["other.example"];
		await tabNavigated(2, "loading", "https://other.example/");
		expect(h.detachCalls).toBe(1); // already detached: retarget, no second detach
		const record = h.sessionStore.get(BYPASS_KEY) as { tabId?: number };
		expect(record.tabId).toBe(2);
	});

	it("auto-pauses when the user switches to an already-loaded remembered tab", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.activeTab = { id: 3, url: "https://paused.example/" };
		h.pausedSites = ["paused.example"];
		await tabActivated(3);
		expect(h.detachCalls).toBe(1);
		expect(h.badge).toBe("⏸");
	});

	it("does not auto-pause while the provider is off", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.enabled = false;
		h.pausedSites = ["example.com"];
		await tabNavigated(1, "loading", "https://example.com/");
		expect(h.detachCalls).toBe(0);
	});
});

describe("binding a request to the page that made it", () => {
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("hands the handler Chrome's stamped origin and the focused tab for the card", async () => {
		const { handleGet } = await import("./webauthn-proxy");
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 3, requestDetailsJson: stamped() });
		await settle();
		expect(vi.mocked(handleGet).mock.calls.at(-1)?.slice(0, 2)).toEqual([{ tabId: 1 }, 3]);
		expect(vi.mocked(handleGet).mock.calls.at(-1)?.[3]).toEqual({
			origin: "https://example.com",
			crossOrigin: false,
		});
	});

	it("refuses a top-level request from a tab the user isn't looking at", async () => {
		// The background tab on a sibling subdomain must not borrow the focused tab's approval.
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.create?.({ requestId: 4, requestDetailsJson: stamped("https://evil.example.com") });
		await settle();
		expect(h.completed).toMatchObject([
			{ requestId: 4, kind: "create", error: expect.any(String) },
		]);
	});

	it("serves a cross-origin iframe, marked as cross-origin", async () => {
		const { handleGet } = await import("./webauthn-proxy");
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 5, requestDetailsJson: stamped("https://pay.example.net", false) });
		await settle();
		expect(vi.mocked(handleGet).mock.calls.at(-1)?.[3]).toEqual({
			origin: "https://pay.example.net",
			crossOrigin: true,
		});
	});

	it("refuses a request the browser didn't stamp with its requester", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 6, requestDetailsJson: JSON.stringify({ challenge: "Y2hhbA" }) });
		await settle();
		expect(h.completed).toMatchObject([{ requestId: 6, kind: "get", error: expect.any(String) }]);
	});
});

describe("the settings toggle hook", () => {
	it("attaches when enabled and detaches when disabled", async () => {
		await load();
		await h.applyHook?.(true);
		expect(h.attachCalls).toBe(1);
		await h.applyHook?.(false);
		expect(h.detachCalls).toBe(1);
	});
});
