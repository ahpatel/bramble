import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ack, inbox, newMessageId, postMessage, uploadBlob } from "../test/device.ts";
import { pair } from "./test-accounts.ts";

// The hosted mailbox end to end through its own fetch handler, over local D1 and R2: the same
// flows the Node server's suite pins, on the storage the hosted service runs on.

describe("the hosted mailbox", () => {
	it("a message posted, collected and acknowledged leaves no body in R2", async () => {
		const { a, b, id } = await pair();
		const { res, msgId } = await postMessage(a, id, { bytes: new Uint8Array(64).fill(3) });
		expect(res.status).toBe(200);
		expect(await env.BODIES.head(`m/${id}/${msgId}`)).not.toBeNull();
		expect((await inbox(b, id)).messages.map((m) => m.id)).toEqual([msgId]);
		const body = await b.request("GET", `/v1/mailboxes/${id}/messages/${msgId}`);
		expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array(64).fill(3));
		await ack(b, id, { messages: [msgId] });
		expect(await env.BODIES.head(`m/${id}/${msgId}`)).toBeNull();
	});

	it("a blob uploads and downloads", async () => {
		const { a, b, id } = await pair();
		const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
		const { res, hash } = await uploadBlob(a, id, bytes, { to: [b] });
		expect(res.status).toBe(200);
		const got = await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`);
		expect(got.status).toBe(200);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
	});

	it("a blob whose bytes don't match its address is refused, and nothing is kept", async () => {
		const { a, b, id } = await pair();
		const { res, hash } = await uploadBlob(a, id, new Uint8Array(32).fill(1), {
			to: [b],
			sendBytes: new Uint8Array(32).fill(2),
		});
		expect(res.status).toBe(400);
		expect(await env.BODIES.head(`b/${id}/${hash}`)).toBeNull();
	});

	it("acknowledging 150 messages works on D1's 100-parameter cap", async () => {
		const { a, b, id } = await pair();
		const ids = Array.from({ length: 150 }, () => newMessageId());
		for (const msgId of ids) expect((await postMessage(a, id, { msgId })).res.status).toBe(200);
		expect((await inbox(b, id)).messages).toHaveLength(150);
		await ack(b, id, { messages: ids });
		expect((await inbox(b, id)).messages).toEqual([]);
	});

	it("an unknown route is a JSON not_found", async () => {
		const res = await exports.default.fetch(new Request("https://mailbox.test/nope"));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
	});
});
