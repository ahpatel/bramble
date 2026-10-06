import { beforeEach, describe, expect, it, vi } from "vitest";

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
	depsCalls: [] as Array<[number | undefined, { nativeFallback?: string } | undefined]>,
	/** What the mocked handlers return for the current request. */
	handlerResult: {} as Record<string, unknown>,
}));

vi.mock("../platform-api", () => ({
	// No webAuthenticationProxy namespace: Firefox, where this transport is live.
	api: {},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown, sender: unknown) => Promise<unknown>) =>
		h.handlers.set(type, handler),
}));

vi.mock("./webauthn-provider", () => ({
	isProviderEnabled: () => h.enabled,
	depsForTab: (tabId?: number, opts?: { nativeFallback?: string }) => {
		h.depsCalls.push([tabId, opts]);
		return { deps: true };
	},
}));

vi.mock("./webauthn-proxy", () => ({
	handleCreate: vi.fn(async () => ({ ...(h.handlerResult as object) })),
	handleGet: vi.fn(async () => ({ ...(h.handlerResult as object) })),
}));

const sender = {
	origin: "https://github.com",
	tab: { id: 5 },
};

beforeEach(() => {
	h.handlers.clear();
	h.enabled = true;
	h.depsCalls = [];
	h.handlerResult = {};
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
			[5, { nativeFallback: "silent" }],
			[5, { nativeFallback: "silent" }],
		]);
	});
});
