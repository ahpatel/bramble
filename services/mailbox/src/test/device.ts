// Test-only: devices that sign requests the way the apps will (an Ed25519 roster key over
// canonicalRequest), and the request helpers every server suite shares. Kept apart from the
// in-memory server so the Worker's tests, which run in workerd, can use them too.

import { randomBytes, type webcrypto } from "node:crypto";
import {
	canonicalRequest,
	HEADERS,
	InboxResponseSchema,
	MembersResponseSchema,
	sha256Hex,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { expect } from "vitest";

export interface RequestOpts {
	time?: number;
	token?: string;
	/** Applied last, over the signed headers. */
	headers?: Record<string, string>;
	/** Sent instead of the signed body, to test a body that does not match its hash. */
	sendBytes?: Uint8Array;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(bytes as ArrayBuffer).toString("base64");

type Send = (path: string, init: RequestInit) => Response | Promise<Response>;

/** A device with its own Ed25519 key, signing with `now` and sending through `send`. */
export async function deviceWith(now: () => number, send: Send) {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as unknown as webcrypto.CryptoKeyPair;
	const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
	if (!(raw instanceof ArrayBuffer)) throw new Error("a raw key export is an ArrayBuffer");
	const sigKey = b64(raw);

	async function headers(method: string, path: string, bytes: Uint8Array, opts: RequestOpts = {}) {
		const time = opts.time ?? now();
		const contentSha256 = await sha256Hex(bytes);
		const message = new TextEncoder().encode(
			canonicalRequest({ method, pathAndQuery: path, time, contentSha256 }),
		);
		const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message));
		const out: Record<string, string> = {
			[HEADERS.key]: sigKey,
			[HEADERS.time]: String(time),
			[HEADERS.contentSha256]: contentSha256,
			[HEADERS.sig]: sig,
		};
		if (opts.token) out[HEADERS.token] = opts.token;
		return out;
	}

	function encode(body: unknown): Uint8Array {
		if (body === undefined) return new Uint8Array();
		if (body instanceof Uint8Array) return body;
		return new TextEncoder().encode(JSON.stringify(body));
	}

	async function request(method: string, path: string, body?: unknown, opts: RequestOpts = {}) {
		const bytes = encode(body);
		const h = await headers(method, path, bytes, opts);
		if (body !== undefined && !(body instanceof Uint8Array)) h["content-type"] = "application/json";
		const sent = opts.sendBytes ?? bytes;
		// fetch sends a length for a known-size body; app.request does not, so set it as fetch would.
		if (body instanceof Uint8Array) h["content-length"] = String(sent.length);
		const init: RequestInit = { method, headers: { ...h, ...opts.headers } };
		if (method !== "GET") init.body = sent as Uint8Array<ArrayBuffer>;
		return send(path, init);
	}

	return { sigKey, headers, request, encode };
}

/** Against a real port, on the real clock. `baseUrl` may be a getter, so one key can follow a
 * restarted server to its new port. fetch sets content-length itself. */
export const makeRemoteDevice = (baseUrl: string | (() => string)) =>
	deviceWith(Date.now, (path, init) => {
		const { "content-length": _, ...headers } = init.headers as Record<string, string>;
		const base = typeof baseUrl === "string" ? baseUrl : baseUrl();
		return fetch(base + path, { ...init, headers });
	});

export type TestDevice = Awaited<ReturnType<typeof deviceWith>>;

export const newMailboxId = () => randomBytes(32).toString("base64url");

/** `owner` creates a mailbox listing itself (active) and `others` (eligible). */
export async function createMailbox(
	owner: TestDevice,
	others: TestDevice[] = [],
	id = newMailboxId(),
	opts: RequestOpts = {},
) {
	const res = await owner.request(
		"POST",
		`/v1/mailboxes/${id}`,
		{ members: [owner.sigKey, ...others.map((d) => d.sigKey)] },
		opts,
	);
	expect(res.status).toBe(200);
	return id;
}

/** `others` activate themselves in `id`. */
export async function activate(id: string, ...others: TestDevice[]) {
	for (const d of others) {
		expect(
			(await d.request("POST", `/v1/mailboxes/${id}/activation`, { active: true })).status,
		).toBe(200);
	}
}

/** Each member's status, keyed by sigKey, as `device` sees it. */
export async function memberStatuses(device: TestDevice, id: string) {
	const res = await device.request("GET", `/v1/mailboxes/${id}/members`);
	expect(res.status).toBe(200);
	const { members } = MembersResponseSchema.parse(await res.json());
	return Object.fromEntries(members.map((m) => [m.sigKey, m.status]));
}

export const newMessageId = () => randomBytes(16).toString("base64url");

/** `from` posts `bytes` (default: 8 random bytes) to mailbox `id`, raw, with `id` and `to` in the query. */
export async function postMessage(
	from: TestDevice,
	id: string,
	opts: { msgId?: string; bytes?: Uint8Array; to?: TestDevice[]; request?: RequestOpts } = {},
) {
	const msgId = opts.msgId ?? newMessageId();
	const bytes = opts.bytes ?? randomBytes(8);
	const to = opts.to ? `&to=${encodeURIComponent(opts.to.map((d) => d.sigKey).join(","))}` : "";
	const res = await from.request(
		"POST",
		`/v1/mailboxes/${id}/messages?id=${msgId}${to}`,
		bytes,
		opts.request,
	);
	return { res, msgId };
}

/** `from` says its snapshot `snapshotId` replaces its earlier `replaces` for the snapshot's recipients. */
export async function replaceMessages(
	from: TestDevice,
	id: string,
	snapshotId: string,
	replaces: string[],
) {
	return from.request("POST", `/v1/mailboxes/${id}/messages/${snapshotId}/replaces`, { replaces });
}

export async function inbox(device: TestDevice, id: string) {
	const res = await device.request("GET", `/v1/mailboxes/${id}/inbox`);
	expect(res.status).toBe(200);
	return InboxResponseSchema.parse(await res.json());
}

export const inboxIds = async (device: TestDevice, id: string) =>
	(await inbox(device, id)).messages.map((m) => m.id).sort();

export async function ack(
	device: TestDevice,
	id: string,
	body: { messages?: string[]; blobs?: string[]; markers?: number[] },
) {
	const res = await device.request("POST", `/v1/mailboxes/${id}/acks`, body);
	expect(res.status).toBe(204);
}

/** `from` uploads `bytes` as a blob, addressed by their SHA-256, for `to`. */
export async function uploadBlob(
	from: TestDevice,
	id: string,
	bytes: Uint8Array,
	{ to, ...opts }: RequestOpts & { to?: TestDevice[] } = {},
) {
	const hash = await sha256Hex(bytes);
	const query = to ? `?to=${encodeURIComponent(to.map((d) => d.sigKey).join(","))}` : "";
	const res = await from.request("PUT", `/v1/mailboxes/${id}/blobs/${hash}${query}`, bytes, opts);
	return { res, hash };
}
