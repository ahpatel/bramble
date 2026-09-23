import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpTransport } from "../adapters/http";
import { signingTransport } from "./index";
import type { S3Config, WebdavConfig } from "./types";

// Who authenticates and who sends are separate questions, and mobile is the platform that
// answers them differently from both others: it holds the credentials (unwrapped from the open
// vault) but cannot reach a provider from the webview, so it signs here and sends natively.
// What matters is that splitting them did not move the auth out of the signed request.

/** A sender that records what it was handed and answers 200. */
function recorder(): { sent: HttpRequest[]; http: HttpTransport } {
	const sent: HttpRequest[] = [];
	return {
		sent,
		http: {
			send: async (req) => {
				sent.push(req);
				return { status: 200, ok: true, body: new Uint8Array() };
			},
		},
	};
}

const S3: S3Config = {
	kind: "s3",
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "b",
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const WEBDAV: WebdavConfig = {
	kind: "webdav",
	serverUrl: "https://dav.example.com/remote.php/dav/files/me/",
	username: "me",
	password: "hunter2",
};

describe("signingTransport", () => {
	it("signs an S3 request here and hands the signed headers to the sender", async () => {
		const r = recorder();
		const t = signingTransport(S3, r.http);
		await t?.send({ method: "PUT", url: "https://s3.example.com/b/x", body: new Uint8Array() });

		const [req] = r.sent;
		if (!req) throw new Error("the sender was never called");
		expect(req.method).toBe("PUT");
		// The whole point: the auth is on the request the sender receives, not added later.
		expect(req.headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
		expect(req.headers?.["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it("authenticates a WebDAV request here and hands the header to the sender", async () => {
		const r = recorder();
		const t = signingTransport(WEBDAV, r.http);
		await t?.send({ method: "GET", url: "https://dav.example.com/x" });

		const [req] = r.sent;
		if (!req) throw new Error("the sender was never called");
		expect(req.headers?.Authorization).toBe(`Basic ${btoa("me:hunter2")}`);
	});

	// The credential must never reach the network any way but through the sender it was given.
	it.each([
		["s3", S3],
		["webdav", WEBDAV],
	])("never calls fetch itself (%s)", async (_kind, cfg) => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const r = recorder();
		await signingTransport(cfg, r.http)?.send({ method: "GET", url: "https://x.example/y" });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(r.sent).toHaveLength(1);
		vi.unstubAllGlobals();
	});

	// Dropbox's OAuth connect is extension-only, so a platform that needs this can never have one
	// configured. Undefined rather than a throw: the caller falls back to the default transport.
	it("has nothing to offer for Dropbox", () => {
		const t = signingTransport({ kind: "dropbox", refreshToken: "r" }, recorder().http);
		expect(t).toBeUndefined();
	});

	it("passes the reply back untouched", async () => {
		const http: HttpTransport = {
			send: async () => ({ status: 404, ok: false, body: new TextEncoder().encode("nope") }),
		};
		const res = await signingTransport(S3, http)?.send({ method: "GET", url: "https://x/y" });
		expect(res?.status).toBe(404);
		expect(res?.ok).toBe(false);
		expect(new TextDecoder().decode(res?.body)).toBe("nope");
	});
});
