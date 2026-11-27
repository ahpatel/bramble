import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../../adapters/http";
import { ed25519Signer, verifyEd25519 } from "../../test/mailbox-fakes";
import { MailboxApiError, mailboxApi, storeBlobMover } from "./api";
import { canonicalRequest, EMPTY_SHA256, HEADERS, sha256Hex } from "./protocol";

const ID = "M".repeat(43);
const URL_BASE = "https://mailbox.example";
const enc = new TextEncoder();
const reply = (status: number, body?: unknown): HttpResponse => ({
	status,
	ok: status >= 200 && status < 300,
	body:
		body === undefined
			? new Uint8Array()
			: enc.encode(typeof body === "string" ? body : JSON.stringify(body)),
});
const MEMBERS = { members: [] };

async function setup(replies: HttpResponse[], opts: { token?: string; now?: () => number } = {}) {
	const signer = await ed25519Signer();
	const sent: HttpRequest[] = [];
	const http = {
		send: async (req: HttpRequest) => {
			sent.push(req);
			return replies.shift() ?? reply(200, MEMBERS);
		},
	};
	const server = { url: URL_BASE, ...(opts.token ? { token: opts.token } : {}) };
	const api = mailboxApi({ http, server, signer, mailboxId: ID, now: opts.now });
	return { api, sent, signer };
}

async function signedOver(req: HttpRequest, sigKey: string, method: string, path: string) {
	const h = req.headers ?? {};
	const text = canonicalRequest({
		method,
		pathAndQuery: path,
		time: Number(h[HEADERS.time]),
		contentSha256: h[HEADERS.contentSha256] as string,
	});
	return h[HEADERS.key] === sigKey && verifyEd25519(sigKey, text, h[HEADERS.sig] as string);
}

describe("mailboxApi", () => {
	it("signs the canonical request with the roster key", async () => {
		const { api, sent, signer } = await setup([reply(200, MEMBERS), reply(200, MEMBERS)], {
			token: "secret-token-1234",
		});
		await api.members();
		const path = `/v1/mailboxes/${ID}/members`;
		expect(sent[0]?.url).toBe(`${URL_BASE}${path}`);
		expect(sent[0]?.headers?.[HEADERS.contentSha256]).toBe(EMPTY_SHA256);
		expect(sent[0]?.headers?.[HEADERS.token]).toBe("secret-token-1234");
		expect(await signedOver(sent[0] as HttpRequest, signer.sigKey, "GET", path)).toBe(true);

		await api.activate(true);
		const json = sent[1] as HttpRequest;
		expect(json.headers?.[HEADERS.contentSha256]).toBe(await sha256Hex('{"active":true}'));
		expect(json.headers?.["content-type"]).toBe("application/json");
		expect(await signedOver(json, signer.sigKey, "POST", `/v1/mailboxes/${ID}/activation`)).toBe(
			true,
		);
	});

	it("sends no token when none is configured", async () => {
		const { api, sent } = await setup([]);
		await api.members();
		expect(sent[0]?.headers?.[HEADERS.token]).toBeUndefined();
	});

	it("retries once on stale_time with the server's clock", async () => {
		const stale = reply(401, { error: "stale_time", serverTime: 5_000_000 });
		const { api, sent } = await setup([stale, reply(200, MEMBERS)], { now: () => 1000 });
		await api.members();
		expect(sent).toHaveLength(2);
		expect(Number(sent[1]?.headers?.[HEADERS.time])).toBe(5_000_000);
		expect(api.serverNow()).toBe(5_000_000);

		const again = await setup([stale, stale], { now: () => 1000 });
		await expect(again.api.members()).rejects.toMatchObject({ status: 401, code: "stale_time" });
	});

	it("maps error bodies", async () => {
		const { api } = await setup([reply(409, { error: "exists" }), reply(500, "oops")]);
		const exists = api.create({ members: ["k"] });
		await expect(exists).rejects.toBeInstanceOf(MailboxApiError);
		await expect(exists).rejects.toMatchObject({ status: 409, code: "exists" });
		await expect(api.members()).rejects.toMatchObject({ status: 500, code: "unexpected" });
	});

	it("returns null for a missing body", async () => {
		const { api } = await setup([reply(404, { error: "not_found" })]);
		expect(await api.message("I".repeat(22))).toBeNull();
	});

	it("signs a blob upload with the blob's hash as its content hash, and who it is for", async () => {
		const { api, signer } = await setup([]);
		const hash = "ab".repeat(32);
		const req = await api.blobRequest("PUT", hash, [signer.sigKey]);
		const path = `/v1/mailboxes/${ID}/blobs/${hash}?to=${encodeURIComponent(signer.sigKey)}`;
		expect(req.url).toBe(`${URL_BASE}${path}`);
		expect(req.headers[HEADERS.contentSha256]).toBe(hash);
		expect(await signedOver({ ...req }, signer.sigKey, "PUT", path)).toBe(true);
	});

	it("refuses a server URL with a path", async () => {
		const signer = await ed25519Signer();
		const http = { send: async () => reply(200) };
		const server = { url: "https://mailbox.example/sync" };
		expect(() => mailboxApi({ http, server, signer, mailboxId: ID })).toThrow(
			"a mailbox server is an origin, with no path",
		);
	});
});

describe("storeBlobMover", () => {
	const HASH = "a".repeat(64);
	const REQUEST = { method: "PUT" as const, url: `${URL_BASE}/v1/blob`, headers: {} };
	const store = { size: async () => 3, read: async () => new Uint8Array([1, 2, 3]) };

	it("hands the transport the blob's own file when the store has one", async () => {
		const sent: HttpRequest[] = [];
		const http = {
			send: async (req: HttpRequest) => {
				sent.push(req);
				return reply(200, { stored: true, recipients: 1 });
			},
		};
		const mover = storeBlobMover(http, store as never, async (hash) => `/blobs/${hash}`);
		expect(await mover.upload(HASH, REQUEST)).toEqual({ stored: true, recipients: 1 });
		expect(sent[0]?.body).toMatchObject({ size: 3, path: `/blobs/${HASH}` });
	});

	it("names no file when the store has none", async () => {
		const sent: HttpRequest[] = [];
		const http = {
			send: async (req: HttpRequest) => {
				sent.push(req);
				return reply(200, { stored: true, recipients: 1 });
			},
		};
		await storeBlobMover(http, store as never).upload(HASH, REQUEST);
		expect(sent[0]?.body).not.toHaveProperty("path");
	});
});
