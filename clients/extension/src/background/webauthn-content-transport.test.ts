import { beforeEach, describe, expect, it, vi } from "vitest";
import { senderCaller } from "./webauthn-content-transport";

// The Firefox delivery: the MAIN-world shim forwards a page's navigator.credentials call,
// and this transport answers with passthrough / an error / a response or, since the
// no-match fix, with {fallback: true}, which tells the shim to relay the request to the
// NATIVE authenticator with the page's own options. That last one is what lets a
// provider-enabled browser still reach the user's other registered devices (the Cloudflare
// Access step-up get()), instead of dead-ending the whole browser on a vault miss.

const h = vi.hoisted(() => ({
	/** Router handlers the module registers, by message type. */
	handlers: new Map<string, (m: unknown, sender: unknown) => Promise<unknown>>(),
	/** The provider flag, so a test can pass through like an opted-out user. */
	enabled: true,
	/** depsForTab calls, to pin the silent handoff style. */
	depsCalls: [] as Array<[number | undefined, string | undefined]>,
	/** What the mocked handlers return for the current request. */
	handlerResult: {} as Record<string, unknown>,
	/** Scripted remembered sites and the sites the transport remembered. */
	pausedSites: [] as string[],
	remembered: [] as string[],
}));

vi.mock("../platform-api", () => ({
	// No webAuthenticationProxy namespace: Firefox, where this transport is live.
	api: {},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown, sender: unknown) => Promise<unknown>) =>
		h.handlers.set(type, handler),
}));

vi.mock("./prefs", () => ({
	getPasskeyPausedSites: async () => new Set(h.pausedSites),
	rememberPasskeyPausedSite: async (site: string) => {
		h.remembered.push(site);
	},
}));

vi.mock("./webauthn-provider", () => ({
	isProviderEnabled: () => h.enabled,
	depsForTab: (tabId?: number, nativeFallback?: string) => {
		h.depsCalls.push([tabId, nativeFallback]);
		return { deps: true };
	},
}));

vi.mock("./webauthn-proxy", () => ({
	handleCreate: vi.fn(async () => ({ ...(h.handlerResult as object) })),
	handleGet: vi.fn(async () => ({ ...(h.handlerResult as object) })),
}));

const sender = {
	frameId: 0,
	origin: "https://github.com",
	tab: { id: 5, url: "https://github.com/" },
};

beforeEach(() => {
	h.handlers.clear();
	h.enabled = true;
	h.depsCalls = [];
	h.handlerResult = {};
	h.pausedSites = [];
	h.remembered = [];
	vi.resetModules();
});

/** Import the transport fresh (its handlers register at module scope, guarded to
 *  no-proxy platforms, so the platform-api mock must be in place first). */
async function load() {
	return import("./webauthn-content-transport");
}

describe("the Firefox content transport", () => {
	it("registers only the create/get handlers", async () => {
		await load();
		expect([...h.handlers.keys()].sort()).toEqual(["WEBAUTHN_CREATE", "WEBAUTHN_GET"]);
	});

	it("passes through while the provider is off", async () => {
		await load();
		h.enabled = false;
		const res = (await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender)) as {
			ok: boolean;
			data: unknown;
		};
		expect(res).toEqual({ ok: true, data: { passthrough: true } });
	});

	it("maps the native-fallback marker to {fallback: true}, not to an error", async () => {
		// The vault cannot serve this request: the shim relays it to the native
		// authenticator with the page's own options, so the site never learns Bramble
		// was asked at all.
		await load();
		h.handlerResult = { nativeFallback: true, error: { name: "NotAllowedError", message: "x" } };
		const res = (await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender)) as {
			ok: boolean;
			data: unknown;
		};
		expect(res.data).toEqual({ fallback: true });
	});

	it("maps errors and responses as before", async () => {
		await load();
		h.handlerResult = { error: { name: "NotAllowedError", message: "user declined" } };
		const err = (await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender)) as {
			data: unknown;
		};
		expect(err.data).toEqual({ error: { name: "NotAllowedError", message: "user declined" } });

		h.handlerResult = { responseJson: "{}" };
		const ok = (await h.handlers.get("WEBAUTHN_CREATE")?.({ payload: {} }, sender)) as {
			data: unknown;
		};
		expect(ok.data).toEqual({ responseJson: "{}" });
	});

	it("builds the ceremony deps with the silent handoff style", async () => {
		// Firefox holds the page's own options in the shim, so a vault miss relays natively
		// with no card; the deps must say so, or the ceremony would offer a card the
		// transport then has no way to fulfil.
		await load();
		await h.handlers.get("WEBAUTHN_CREATE")?.({ payload: {} }, sender);
		await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender);
		expect(h.depsCalls).toEqual([
			[5, "silent"],
			[5, "silent"],
		]);
	});

	it("passes a remembered site straight through, before the handler", async () => {
		await load();
		h.pausedSites = ["github.com"];
		h.handlerResult = { responseJson: "{}" };
		const res = (await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender)) as {
			data: unknown;
		};
		expect(res.data).toEqual({ passthrough: true });
		expect(h.depsCalls).toEqual([]); // the handler never ran
	});

	it("remembers the site when the handler asks to", async () => {
		await load();
		h.handlerResult = { nativeFallback: true, rememberSite: "github.com" };
		const res = (await h.handlers.get("WEBAUTHN_GET")?.({ payload: {} }, sender)) as {
			data: unknown;
		};
		expect(res.data).toEqual({ fallback: true });
		expect(h.remembered).toEqual(["github.com"]);
	});
});

describe("senderCaller (which Firefox frames the provider serves)", () => {
	const tab = { id: 4, url: "https://shop.example/checkout" } as chrome.tabs.Tab;

	it("serves the top frame as itself", () => {
		expect(senderCaller({ frameId: 0, origin: "https://shop.example", tab })).toEqual({
			caller: { origin: "https://shop.example", crossOrigin: false },
			tabId: 4,
		});
	});

	it("serves a child frame that is same-origin with the top", () => {
		expect(senderCaller({ frameId: 2, origin: "https://shop.example", tab })?.tabId).toBe(4);
	});

	// A frame can post to the bridge directly, so this is the only gate it can't skip.
	it("passes a cross-origin child frame through to the native authenticator", () => {
		expect(senderCaller({ frameId: 3, origin: "https://ads.example", tab })).toBeNull();
	});

	it("passes through a sender without a tab or a web origin", () => {
		expect(senderCaller({ frameId: 0, origin: "https://shop.example" })).toBeNull();
		expect(senderCaller({ frameId: 0, origin: "moz-extension://abc", tab })).toBeNull();
	});
});
