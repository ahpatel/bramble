// The signed client for one mailbox (docs/mailbox-service.md, "API sketch"). Every request carries
// the roster key's signature over canonicalRequest, and a stale clock is corrected from the
// server's answer and retried once. Only status and body are read: the native transports return
// no response headers.

import type { HttpResponse, HttpTransport } from "../../adapters/http";
import type { BlobStore } from "../../vault/blob-store";
import {
	type AccountStatusResponse,
	AccountStatusResponseSchema,
	type AckBody,
	type CreateMailboxBody,
	canonicalRequest,
	EMPTY_SHA256,
	ErrorResponseSchema,
	HEADERS,
	type InboxResponse,
	InboxResponseSchema,
	type MailboxErrorCode,
	type MembersBody,
	type MembersResponse,
	MembersResponseSchema,
	type PostResponse,
	PostResponseSchema,
	sha256Hex,
} from "./protocol";

export interface MailboxSigner {
	readonly sigKey: string;
	sign(message: string): Promise<string>;
}

export interface MailboxServer {
	url: string;
	token?: string;
	/** The hosted service's account number, formatted. Sent only where an account is asked for. */
	account?: string;
}

export class MailboxApiError extends Error {
	readonly status: number;
	readonly code: MailboxErrorCode | "unexpected";
	constructor(status: number, code: MailboxErrorCode | "unexpected") {
		super(`mailbox answered ${status} ${code}`);
		this.name = "MailboxApiError";
		this.status = status;
		this.code = code;
	}
}

export interface SignedRequest {
	method: "GET" | "PUT";
	url: string;
	headers: Record<string, string>;
}

export interface MailboxApi {
	readonly mailboxId: string;
	/** The account number this API was built with, or null. */
	readonly account: string | null;
	/** Now on the server's clock, as corrected by stale_time answers. */
	serverNow(): number;
	create(body: CreateMailboxBody): Promise<MembersResponse>;
	members(): Promise<MembersResponse>;
	changeMembers(body: MembersBody): Promise<MembersResponse>;
	activate(active: boolean): Promise<MembersResponse>;
	setRetention(days: number): Promise<void>;
	post(messageId: string, body: Uint8Array, to?: string[]): Promise<PostResponse>;
	replaces(snapshotId: string, replaced: string[]): Promise<void>;
	inbox(wantedAfter?: string): Promise<InboxResponse>;
	/** `null`: the server has no body for it (404). */
	message(messageId: string): Promise<Uint8Array | null>;
	wants(hashes: string[]): Promise<void>;
	ack(body: Partial<AckBody>): Promise<void>;
	/** A signed blob transfer for a mover to run. A PUT's content hash is the blob's hash, and it
	 * names who the blob is for. */
	blobRequest(method: "GET", hash: string): Promise<SignedRequest>;
	blobRequest(method: "PUT", hash: string, to: string[]): Promise<SignedRequest>;
	/** Pay for this mailbox from the API's account from now on (hosted). */
	attach(): Promise<void>;
	/** The API's account: paid time, frozen, storage. Throws without an account. */
	accountStatus(): Promise<AccountStatusResponse>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const RAW = "application/octet-stream";

function errorOf(res: HttpResponse): { error: MailboxApiError; serverTime?: number } {
	try {
		const parsed = ErrorResponseSchema.safeParse(JSON.parse(dec.decode(res.body)));
		if (parsed.success) {
			return {
				error: new MailboxApiError(res.status, parsed.data.error),
				serverTime: parsed.data.serverTime,
			};
		}
	} catch {}
	return { error: new MailboxApiError(res.status, "unexpected") };
}

const parseJson = <T>(schema: { parse(v: unknown): T }, res: HttpResponse): T =>
	schema.parse(JSON.parse(dec.decode(res.body)));

export function mailboxApi(deps: {
	http: HttpTransport;
	server: MailboxServer;
	signer: MailboxSigner;
	mailboxId: string;
	now?: () => number;
}): MailboxApi {
	const base = new URL(deps.server.url);
	if (!/^https?:$/.test(base.protocol) || base.pathname !== "/" || base.search || base.hash) {
		throw new Error("a mailbox server is an origin, with no path");
	}
	const now = deps.now ?? Date.now;
	const prefix = `/v1/mailboxes/${deps.mailboxId}`;
	let offset = 0;

	const account = deps.server.account ?? null;

	async function signed(method: string, path: string, contentSha256: string) {
		const time = now() + offset;
		const sig = await deps.signer.sign(
			canonicalRequest({ method, pathAndQuery: path, time, contentSha256 }),
		);
		const headers: Record<string, string> = {
			[HEADERS.key]: deps.signer.sigKey,
			[HEADERS.time]: String(time),
			[HEADERS.contentSha256]: contentSha256,
			[HEADERS.sig]: sig,
		};
		if (deps.server.token) headers[HEADERS.token] = deps.server.token;
		return headers;
	}

	async function send(
		method: string,
		path: string,
		body?: { bytes: Uint8Array; type: string },
		withAccount = false,
	): Promise<HttpResponse> {
		const contentSha256 = body ? await sha256Hex(body.bytes) : EMPTY_SHA256;
		for (let attempt = 0; ; attempt++) {
			const headers = await signed(method, path, contentSha256);
			if (body) headers["content-type"] = body.type;
			if (withAccount && account) headers[HEADERS.account] = account;
			const res = await deps.http.send({
				method,
				url: `${base.origin}${path}`,
				headers,
				...(body ? { body: body.bytes } : {}),
			});
			if (res.ok) return res;
			const { error, serverTime } = errorOf(res);
			if (error.code === "stale_time" && serverTime !== undefined && attempt === 0) {
				offset = serverTime - now();
				continue;
			}
			throw error;
		}
	}

	const json = (value: unknown) => ({
		bytes: enc.encode(JSON.stringify(value)),
		type: "application/json",
	});

	return {
		mailboxId: deps.mailboxId,
		account,
		serverNow: () => now() + offset,
		create: async (body) =>
			parseJson(MembersResponseSchema, await send("POST", prefix, json(body), true)),
		members: async () => parseJson(MembersResponseSchema, await send("GET", `${prefix}/members`)),
		changeMembers: async (body) =>
			parseJson(MembersResponseSchema, await send("POST", `${prefix}/members`, json(body))),
		activate: async (active) =>
			parseJson(
				MembersResponseSchema,
				await send("POST", `${prefix}/activation`, json({ active })),
			),
		setRetention: async (days) => {
			await send("PATCH", prefix, json({ retentionDays: days }));
		},
		post: async (messageId, body, to) => {
			const query = to ? `&to=${encodeURIComponent(to.join(","))}` : "";
			const path = `${prefix}/messages?id=${messageId}${query}`;
			return parseJson(PostResponseSchema, await send("POST", path, { bytes: body, type: RAW }));
		},
		replaces: async (snapshotId, replaced) => {
			await send("POST", `${prefix}/messages/${snapshotId}/replaces`, json({ replaces: replaced }));
		},
		inbox: async (wantedAfter) => {
			const path = `${prefix}/inbox${wantedAfter ? `?wantedAfter=${wantedAfter}` : ""}`;
			return parseJson(InboxResponseSchema, await send("GET", path));
		},
		message: async (messageId) => {
			try {
				return (await send("GET", `${prefix}/messages/${messageId}`)).body;
			} catch (err) {
				if (err instanceof MailboxApiError && err.status === 404) return null;
				throw err;
			}
		},
		wants: async (hashes) => {
			await send("PUT", `${prefix}/wants`, json({ hashes }));
		},
		ack: async (body) => {
			await send("POST", `${prefix}/acks`, json({ messages: [], blobs: [], markers: [], ...body }));
		},
		blobRequest: async (method: "GET" | "PUT", hash: string, to?: string[]) => {
			const query = to ? `?to=${encodeURIComponent(to.join(","))}` : "";
			const path = `${prefix}/blobs/${hash}${query}`;
			const headers = await signed(method, path, method === "PUT" ? hash : EMPTY_SHA256);
			if (method === "PUT") headers["content-type"] = RAW;
			return { method, url: `${base.origin}${path}`, headers };
		},
		attach: async () => {
			await send("PUT", `${prefix}/account`, undefined, true);
		},
		accountStatus: async () => {
			if (!account) throw new Error("no account to ask about");
			// Unsigned: the number is the whole credential, in a header so no log can keep it.
			const res = await deps.http.send({
				method: "GET",
				url: `${base.origin}/v1/accounts/status`,
				headers: { [HEADERS.account]: account },
			});
			if (!res.ok) throw errorOf(res).error;
			return parseJson(AccountStatusResponseSchema, res);
		},
	};
}

export interface MailboxBlobMover {
	upload(hash: string, request: SignedRequest): Promise<PostResponse>;
	download(hash: string, request: SignedRequest): Promise<"stored" | "missing">;
}

/** Moves bytes through JS: reads and writes `blobs`, sends through `http`. `pathOf` names a
 * blob's own file where the store keeps one, so a native transport can send it from there. */
export function storeBlobMover(
	http: HttpTransport,
	blobs: BlobStore,
	pathOf?: (hash: string) => Promise<string>,
): MailboxBlobMover {
	return {
		async upload(hash, request) {
			const size = await blobs.size(hash);
			if (size === null) throw new Error("no such blob to upload");
			const res = await http.send({
				...request,
				body: {
					size,
					read: (offset, length) => blobs.read(hash, offset, length),
					...(pathOf ? { path: await pathOf(hash) } : {}),
				},
			});
			if (!res.ok) throw errorOf(res).error;
			return parseJson(PostResponseSchema, res);
		},
		async download(hash, request) {
			const res = await http.send(request);
			if (res.status === 404) return "missing";
			if (!res.ok) throw errorOf(res).error;
			await blobs.put(hash, res.body);
			return "stored";
		},
	};
}
