import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The JS half of the native transport. What is under test is the marshalling and the platform
// choice, because both fail quietly: a mis-encoded body reaches the provider as garbage, and a
// wrong platform answer puts the request back inside the WebView, where the hosts this exists
// for cannot be reached at all.

const native = vi.hoisted(() => ({
	send: vi.fn(),
}));

// Mutable so one file can exercise a device and the dev browser.
const platform = vi.hoisted(() => ({ isNative: true }));

vi.mock("@capacitor/core", () => ({
	registerPlugin: () => native,
	Capacitor: { isNativePlatform: () => platform.isNative },
}));

const { mobileHttp } = await import("./http");

beforeEach(() => {
	platform.isNative = true;
	native.send.mockReset();
	native.send.mockResolvedValue({ status: 200, body: "" });
});

afterEach(() => vi.unstubAllGlobals());

const b64 = (s: string) => btoa(s);

describe("mobileHttp on a device", () => {
	it("sends the request natively with a base64 body", async () => {
		await mobileHttp.send({
			method: "POST",
			url: "https://p.example/x",
			headers: { Authorization: "Bearer k" },
			body: new TextEncoder().encode('{"a":1}'),
		});
		expect(native.send).toHaveBeenCalledWith({
			method: "POST",
			url: "https://p.example/x",
			headers: { Authorization: "Bearer k" },
			body: b64('{"a":1}'),
		});
	});

	// Absent rather than empty, so the native side can tell "no body" from "zero bytes" and pick
	// what the method actually needs.
	it("omits the body key entirely when there is none", async () => {
		await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		const [args] = native.send.mock.calls[0] as [Record<string, unknown>];
		expect("body" in args).toBe(false);
		expect(args.headers).toEqual({});
	});

	it("decodes the reply back to bytes", async () => {
		native.send.mockResolvedValue({ status: 200, body: b64('{"email":"a@b.c"}') });
		const res = await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(res.body).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(res.body)).toBe('{"email":"a@b.c"}');
	});

	it("survives an empty reply body", async () => {
		native.send.mockResolvedValue({ status: 204, body: "" });
		const res = await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(res.body).toEqual(new Uint8Array());
	});

	// A refused redirect comes back as the real 3xx, not as an opaque 0, and must not read as
	// success. `ok` is derived here because the native side reports only the status.
	it.each([
		[200, true],
		[204, true],
		[302, false],
		[401, false],
	])("derives ok=%s from status %i", async (status, ok) => {
		native.send.mockResolvedValue({ status, body: "" });
		const res = await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(res.status).toBe(status);
		expect(res.ok).toBe(ok);
	});
});

describe("mobileHttp in the dev browser", () => {
	it("falls back to fetch, and does not call the native plugin", async () => {
		platform.isNative = false;
		const fetchSpy = vi.fn(async () => new Response("hi", { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		const res = await mobileHttp.send({ method: "GET", url: "https://p.example/x" });

		expect(native.send).not.toHaveBeenCalled();
		expect(new TextDecoder().decode(res.body)).toBe("hi");
		// The rules still hold on this path: it is the same fetchTransport core uses everywhere.
		const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.credentials).toBe("omit");
		expect(init.redirect).toBe("manual");
	});

	// The bridge is injected asynchronously and answers "web" until it lands, so the choice has
	// to be made per call rather than frozen when the module loaded.
	it("re-reads the platform on every call rather than caching it", async () => {
		platform.isNative = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 200 })),
		);
		await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(native.send).not.toHaveBeenCalled();

		platform.isNative = true;
		await mobileHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(native.send).toHaveBeenCalledTimes(1);
	});
});
