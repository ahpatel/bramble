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
		create?: (r: { requestId: number }) => void;
		get?: (r: { requestId: number }) => void;
	},
	/** Hold the handler mid-ceremony, which is where a real one spends most of its life. */
	holdHandler: false,
	release: undefined as (() => void) | undefined,
	/** Scripted extra fields the mocked handleCreate/handleGet return (e.g. the handoff). */
	handlerExtras: {} as Record<string, unknown>,
	/** runtime.onConnect listeners (the SW side of the pause port). */
	portListeners: [] as Array<(port: unknown) => void>,
	/** Call order across completions and the handoff disable, to pin complete-before-disable. */
	order: [] as string[],
	disableCalls: 0,
}));

const proxy = {
	attach: async () => {
		h.attachCalls++;
		return h.attachResult;
	},
	detach: async () => {
		h.detachCalls++;
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
		addListener: (cb: (r: { requestId: number }) => void) => {
			h.listeners.create++;
			h.fire.create = cb;
		},
	},
	onGetRequest: {
		addListener: (cb: (r: { requestId: number }) => void) => {
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
function makePort(name: string) {
	const p: {
		name: string;
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
function connectPausePort(name = PAUSE_PORT) {
	const port = makePort(name);
	for (const cb of h.portListeners) cb(port);
	return port;
}

vi.mock("../platform-api", () => ({
	api: {
		// A getter so one test can be Firefox (namespace absent) without a second mock.
		get webAuthenticationProxy() {
			return h.hasProxy ? proxy : undefined;
		},
		tabs: { query: async () => [{ id: 1, url: "https://example.com/page" }] },
		runtime: {
			onConnect: {
				addListener: (cb: (port: unknown) => void) => h.portListeners.push(cb),
			},
		},
	},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
	// Resolved, or the proxy listeners would hang waiting on hydration.
	whenReady: async () => {},
}));

vi.mock("./webauthn-provider", () => ({
	productionDeps: {},
	isProviderEnabled: () => h.enabled,
	setProviderApplyHook: (fn: (enabled: boolean) => Promise<void>) => {
		h.applyHook = fn;
	},
	disableProviderForNativeFallback: async () => {
		h.disableCalls++;
		h.order.push("disable");
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
	h.order = [];
	h.disableCalls = 0;
	return import("./webauthn-proxy-init");
}

/** Let the listener's async body run to the point where it would complete the request. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
		h.fire.get?.({ requestId: 42 });
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
		h.fire.get?.({ requestId: 7 });
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
		h.fire.get?.({ requestId: 9 });
		await settle();
		expect(h.completed).toEqual([
			{ requestId: 9, kind: "get", error: undefined, raw: expect.anything() },
		]);
	});
});

describe("the native-fallback handoff (use another authenticator)", () => {
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("completes the request FIRST, then turns the provider off", async () => {
		// Detaching an in-flight request aborts it with a bare AbortError, which would eat
		// the handoff message the user just acted on. The order is the contract.
		const m = await load();
		await m.initWebauthnProxy();
		h.handlerExtras = { nativeFallback: true };
		h.fire.get?.({ requestId: 11 });
		await settle();
		expect(h.order).toEqual(["complete", "disable"]);
		expect(h.disableCalls).toBe(1);
	});

	it("strips the handoff marker before handing Chrome the completion", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.handlerExtras = { nativeFallback: true };
		h.fire.create?.({ requestId: 12 });
		await settle();
		const raw = h.completed[0]?.raw as Record<string, unknown>;
		expect(raw.nativeFallback).toBeUndefined(); // ours, not Chrome's
	});

	it("a normal completion never touches the provider state", async () => {
		const m = await load();
		await m.initWebauthnProxy();
		h.fire.get?.({ requestId: 13 });
		await settle();
		expect(h.disableCalls).toBe(0);
		expect(h.detachCalls).toBe(0);
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
