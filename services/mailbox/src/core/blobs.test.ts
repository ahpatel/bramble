import { randomBytes } from "node:crypto";
import {
	INBOX_PAGE,
	InboxResponseSchema,
	MAX_BLOB_BYTES,
	PostResponseSchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { describe, expect, it } from "vitest";
import {
	ack,
	activate,
	createMailbox,
	gatedBodies,
	inbox,
	setup,
	uploadBlob,
} from "../test/harness.ts";
import { ROW_BYTES } from "./messages.ts";
import { blobs } from "./schema.ts";
import { DAY_MS } from "./time.ts";

async function trio(opts: Parameters<typeof setup>[1] = {}) {
	const { server, devices } = await setup(3, opts);
	const [a, b, c] = [devices[0]!, devices[1]!, devices[2]!];
	const id = await createMailbox(a, [b, c]);
	await activate(id, b, c);
	return { server, a, b, c, id };
}

const blobHashes = async (...args: Parameters<typeof inbox>) =>
	(await inbox(...args)).blobs.map((blob) => blob.hash);

async function bodyCount(server: Awaited<ReturnType<typeof trio>>["server"]) {
	let n = 0;
	for await (const _ of server.deps.bodies.keys()) n++;
	return n;
}

describe("blobs", () => {
	it("stores a blob once and delivers it to the members it names", async () => {
		const { a, b, c, id } = await trio();
		const bytes = randomBytes(4096);
		const { res, hash } = await uploadBlob(a, id, bytes, { to: [b, c] });
		expect(PostResponseSchema.parse(await res.json())).toEqual({ stored: true, recipients: 2 });
		expect(await blobHashes(b, id)).toEqual([hash]);
		expect(await blobHashes(c, id)).toEqual([hash]);
		expect(await blobHashes(a, id)).toEqual([]);
		const got = await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array(bytes));
	});

	it("a blob put that names nobody is refused", async () => {
		const { server, a, b, id } = await trio();
		const { res, hash } = await uploadBlob(a, id, randomBytes(32));
		expect(res.status).toBe(400);
		expect(await blobHashes(b, id)).toEqual([]);
		expect((await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
		expect(await bodyCount(server)).toBe(0);
	});

	it("a blob reaches only the members it names", async () => {
		const { a, b, c, id } = await trio();
		const { res, hash } = await uploadBlob(a, id, randomBytes(32), { to: [b] });
		expect(await res.json()).toEqual({ stored: true, recipients: 1 });
		expect(await blobHashes(b, id)).toEqual([hash]);
		expect(await blobHashes(c, id)).toEqual([]);
	});

	it("a member with no delivery cannot fetch a blob", async () => {
		const { a, b, c, id } = await trio();
		const { hash } = await uploadBlob(a, id, randomBytes(32), { to: [b] });
		const path = `/v1/mailboxes/${id}/blobs/${hash}`;
		expect((await b.request("GET", path)).status).toBe(200);
		expect((await c.request("GET", path)).status).toBe(404);
		expect((await a.request("GET", path)).status).toBe(404);
	});

	it("the inbox says who wants a hash, held or not", async () => {
		const { a, b, c, id } = await trio();
		const bytes = randomBytes(32);
		const held = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
		const missing = randomBytes(32).toString("hex");
		const wants = `/v1/mailboxes/${id}/wants`;
		expect((await c.request("PUT", wants, { hashes: [held] })).status).toBe(204);
		await uploadBlob(a, id, bytes, { to: [b] });
		// b holds a delivery for `held`, so only its want for `missing` is news.
		expect((await b.request("PUT", wants, { hashes: [missing, held] })).status).toBe(204);
		const expected = [
			{ hash: held, by: [c.sigKey] },
			{ hash: missing, by: [b.sigKey] },
		].sort((x, y) => x.hash.localeCompare(y.hash));
		expect((await inbox(a, id)).wanted).toEqual(expected);
	});

	it("refuses bytes that do not match the hash, and keeps nothing", async () => {
		const { server, a, b, id } = await trio();
		const { res, hash } = await uploadBlob(a, id, randomBytes(64), {
			to: [b],
			sendBytes: randomBytes(64),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "hash_mismatch" });
		expect((await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
		expect(await bodyCount(server)).toBe(0);
	});

	it("refuses a declared length over MAX_BLOB_BYTES without reading the body", async () => {
		const { a, b, id } = await trio();
		const { res } = await uploadBlob(a, id, randomBytes(16), {
			to: [b],
			headers: { "content-length": String(MAX_BLOB_BYTES + 1) },
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
	});

	it("refuses a path-shaped or upper-case hash", async () => {
		const { a, id } = await trio();
		for (const bad of ["A".repeat(64), "0".repeat(63), "0".repeat(64).replace(/^0/, "/")]) {
			const res = await a.request("GET", `/v1/mailboxes/${id}/blobs/${encodeURIComponent(bad)}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "bad_request" });
		}
		// URL parsing resolves a dot segment before routing, so the path no longer matches what was
		// signed: refused before any route or storage sees it.
		expect((await a.request("GET", `/v1/mailboxes/${id}/blobs/..`)).status).toBe(401);
	});

	it("tells holders what others want, and forgets a want once the blob arrives", async () => {
		const { a, b, id } = await trio();
		const bytes = randomBytes(256);
		const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
		expect((await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: [hash] })).status).toBe(
			204,
		);
		expect((await inbox(a, id)).wanted).toEqual([{ hash, by: [b.sigKey] }]);
		expect((await inbox(b, id)).wanted).toEqual([]);
		await uploadBlob(a, id, bytes, { to: [b] });
		expect((await inbox(a, id)).wanted).toEqual([]);
		expect(await blobHashes(b, id)).toEqual([hash]);
	});

	it("pages what others want apart from what the caller must collect", async () => {
		const { b, c, id } = await trio();
		const hashes = Array.from({ length: INBOX_PAGE + 1 }, () =>
			randomBytes(32).toString("hex"),
		).sort();
		expect((await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes })).status).toBe(204);
		const first = await inbox(c, id);
		expect(first.more).toBe(false);
		expect(first.wanted).toEqual(
			hashes.slice(0, INBOX_PAGE).map((hash) => ({ hash, by: [b.sigKey] })),
		);
		expect(first.wantedMore).toBe(true);
		const res = await c.request(
			"GET",
			`/v1/mailboxes/${id}/inbox?wantedAfter=${first.wanted.at(-1)?.hash}`,
		);
		const next = InboxResponseSchema.parse(await res.json());
		expect(next.wanted).toEqual(hashes.slice(INBOX_PAGE).map((hash) => ({ hash, by: [b.sigKey] })));
		expect(next.wantedMore).toBe(false);
	});

	it("deletes the blob after its last recipient acknowledges it", async () => {
		const { server, a, b, c, id } = await trio();
		const { hash } = await uploadBlob(a, id, randomBytes(128), { to: [b, c] });
		await ack(b, id, { blobs: [hash] });
		expect((await c.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(200);
		await ack(c, id, { blobs: [hash] });
		expect((await c.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
		expect(await bodyCount(server)).toBe(0);
		expect((await inbox(a, id)).usedBytes).toBe(0);
	});

	it("answers a re-upload of a present hash without storing it again", async () => {
		const { server, a, b, c, id } = await trio();
		const bytes = randomBytes(512);
		await uploadBlob(a, id, bytes, { to: [b, c] });
		const { res } = await uploadBlob(b, id, bytes, { to: [a, c] });
		expect(await res.json()).toEqual({ stored: true, recipients: 2 });
		expect(await bodyCount(server)).toBe(1);
	});

	it("stores nothing when no other member is active", async () => {
		const { server, devices } = await setup(1);
		const a = devices[0]!;
		const id = await createMailbox(a);
		const { res } = await uploadBlob(a, id, randomBytes(32), { to: [a] });
		expect(await res.json()).toEqual({ stored: false, recipients: 0 });
		let n = 0;
		for await (const _ of server.deps.bodies.keys()) n++;
		expect(n).toBe(0);
	});

	it("delivers a blob to whoever is active when the upload lands, when a member is removed during it", async () => {
		const gate = gatedBodies();
		const { devices } = await setup(3, { wrapBodies: gate.wrap });
		const [a, b, c] = [devices[0]!, devices[1]!, devices[2]!];
		const id = await createMailbox(a, [b, c]);
		await activate(id, b, c);
		gate.hold();
		const uploading = uploadBlob(a, id, randomBytes(64), { to: [b, c] });
		await gate.entered();
		expect(
			(await a.request("POST", `/v1/mailboxes/${id}/members`, { remove: [c.sigKey] })).status,
		).toBe(200);
		gate.release();
		const { res, hash } = await uploading;
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ stored: true, recipients: 1 });
		expect(await blobHashes(b, id)).toEqual([hash]);
	});

	it("restores deliveries a failed upload never wrote when the blob is uploaded again", async () => {
		const { server, a, b, c, id } = await trio();
		const bytes = randomBytes(64);
		const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
		const now = server.clock.now;
		// What an upload that died after its row and before its deliveries leaves behind.
		await server.deps.bodies.put(`b/${id}/${hash}`, bytes);
		await server.deps.db.insert(blobs).values({
			mailboxId: id,
			hash,
			size: 64,
			uploader: a.sigKey,
			createdAt: now,
			expiresAt: now + DAY_MS,
		});
		const { res } = await uploadBlob(a, id, bytes, { to: [b, c] });
		expect(await res.json()).toEqual({ stored: true, recipients: 2 });
		expect(await blobHashes(b, id)).toEqual([hash]);
		expect(await blobHashes(c, id)).toEqual([hash]);
	});
});

describe("wants and the quota", () => {
	const hashes = (n: number) => Array.from({ length: n }, () => randomBytes(32).toString("hex"));

	it("a collect-only mailbox takes no wants", async () => {
		const { b, id } = await trio({ canPost: false });
		const res = await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: hashes(1) });
		expect(res.status).toBe(402);
		expect(await res.json()).toEqual({ error: "collect_only" });
	});

	it("a collect-only mailbox still lets a member shrink its wants", async () => {
		const opts: { canPost: boolean } = { canPost: true };
		const { b, id } = await trio(opts);
		const two = hashes(2);
		expect((await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: two })).status).toBe(204);
		opts.canPost = false;
		const fewer = await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: two.slice(0, 1) });
		expect(fewer.status).toBe(204);
		const more = await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: hashes(3) });
		expect(more.status).toBe(402);
	});

	it("want rows count against the quota", async () => {
		const { b, id } = await trio({ quotaBytes: 3 * ROW_BYTES });
		const over = await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: hashes(4) });
		expect(over.status).toBe(507);
		expect(await over.json()).toEqual({ error: "quota_exceeded" });
		const fits = await b.request("PUT", `/v1/mailboxes/${id}/wants`, { hashes: hashes(3) });
		expect(fits.status).toBe(204);
	});
});
