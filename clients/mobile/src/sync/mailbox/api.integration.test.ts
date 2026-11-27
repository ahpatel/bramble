import { randomBytes } from "node:crypto";
import { fetchTransport, type HttpRequest, type HttpTransport } from "@core/adapters/http";
import { type MailboxSigner, mailboxApi, storeBlobMover } from "@core/sync/mailbox/api";
import { sha256Hex } from "@core/sync/mailbox/protocol";
import { ed25519Signer } from "@core/test/mailbox-fakes";
import { memoryBlobStore } from "@core/test/memory-blob-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

const newId = (bytes: number) => randomBytes(bytes).toString("base64url");
const apiFor = (signer: MailboxSigner, mailboxId: string) =>
	mailboxApi({ http: fetchTransport, server: { url: box.url }, signer, mailboxId });

describe("mailbox client against the real server", () => {
	it("creates, activates, posts, collects and acknowledges, correcting its clock", async () => {
		const a = await ed25519Signer();
		const b = await ed25519Signer();
		const mailboxId = newId(32);
		const apiA = apiFor(a, mailboxId);
		const apiB = apiFor(b, mailboxId);
		await apiA.create({ members: [a.sigKey, b.sigKey] });
		await apiB.activate(true);

		const first = newId(16);
		const body = new Uint8Array([1, 2, 3]);
		expect(await apiA.post(first, body)).toEqual({ stored: true, recipients: 1 });
		const second = newId(16);
		expect(await apiA.post(second, body, [b.sigKey])).toEqual({ stored: true, recipients: 1 });

		expect((await apiB.inbox()).messages.map((m) => m.id).sort()).toEqual([first, second].sort());
		expect(await apiB.message(first)).toEqual(body);
		await apiB.ack({ messages: [first, second] });
		expect((await apiB.inbox()).messages).toEqual([]);
	});

	it("moves a blob through the store mover", async () => {
		const a = await ed25519Signer();
		const b = await ed25519Signer();
		const mailboxId = newId(32);
		const apiA = apiFor(a, mailboxId);
		const apiB = apiFor(b, mailboxId);
		await apiA.create({ members: [a.sigKey, b.sigKey] });
		await apiB.activate(true);

		const bytes = new Uint8Array([9, 8, 7, 6]);
		const hash = await sha256Hex(bytes);
		const storeA = memoryBlobStore().store;
		const storeB = memoryBlobStore().store;
		await storeA.put(hash, bytes);
		const moverA = storeBlobMover(fetchTransport, storeA);
		const moverB = storeBlobMover(fetchTransport, storeB);
		expect(await moverA.upload(hash, await apiA.blobRequest("PUT", hash, [b.sigKey]))).toEqual({
			stored: true,
			recipients: 1,
		});
		expect(await moverB.download(hash, await apiB.blobRequest("GET", hash))).toBe("stored");
		expect(await storeB.read(hash)).toEqual(bytes);
		const unknown = "0".repeat(64);
		expect(await moverB.download(unknown, await apiB.blobRequest("GET", unknown))).toBe("missing");
	});
});

const ACCOUNT_A = "11111 22222 33333 44444 55555";
const ACCOUNT_B = "66666 77777 88888 99999 00000";
const STATUS_A = {
	paidThrough: 1_900_000_000_000,
	frozen: false,
	usedBytes: 0,
	quotaBytes: 1_000_000_000,
};
const STATUS_B = { paidThrough: 0, frozen: false, usedBytes: 0, quotaBytes: 1_000_000_000 };
const digits = (number: string) => number.replace(/ /g, "");

describe("mailbox client against a hosted server", () => {
	let hosted: TestMailbox;
	beforeAll(async () => {
		hosted = await startTestMailbox({
			ACCOUNTS: JSON.stringify({ [digits(ACCOUNT_A)]: STATUS_A, [digits(ACCOUNT_B)]: STATUS_B }),
		});
	});
	afterAll(() => hosted.close());
	const hostedApi = (
		signer: MailboxSigner,
		mailboxId: string,
		account?: string,
		http: HttpTransport = fetchTransport,
	) =>
		mailboxApi({
			http,
			server: { url: hosted.url, ...(account ? { account } : {}) },
			signer,
			mailboxId,
		});

	it("creates a hosted mailbox under the account it names", async () => {
		const a = await ed25519Signer();
		const id = newId(32);
		await hostedApi(a, id, ACCOUNT_A).create({ members: [a.sigKey] });
		expect(await hosted.accountOf(id)).toBe(`acct_${digits(ACCOUNT_A)}`);
	});

	it("refuses a hosted mailbox with no account, or an unknown one", async () => {
		const a = await ed25519Signer();
		const id = newId(32);
		await expect(hostedApi(a, id).create({ members: [a.sigKey] })).rejects.toMatchObject({
			code: "account_required",
			status: 402,
		});
		await expect(
			hostedApi(a, id, "12345 12345 12345 12345 12345").create({ members: [a.sigKey] }),
		).rejects.toMatchObject({ code: "account_unknown", status: 403 });
	});

	it("attach moves the mailbox to another account", async () => {
		const a = await ed25519Signer();
		const id = newId(32);
		await hostedApi(a, id, ACCOUNT_A).create({ members: [a.sigKey] });
		await hostedApi(a, id, ACCOUNT_B).attach();
		expect(await hosted.accountOf(id)).toBe(`acct_${digits(ACCOUNT_B)}`);
	});

	it("reads its account's status", async () => {
		const a = await ed25519Signer();
		expect(await hostedApi(a, newId(32), ACCOUNT_A).accountStatus()).toEqual(STATUS_A);
	});

	it("only create, attach and status carry the account number", async () => {
		const sent: HttpRequest[] = [];
		const http: HttpTransport = {
			...fetchTransport,
			send: (req) => {
				sent.push(req);
				return fetchTransport.send(req);
			},
		};
		const a = await ed25519Signer();
		const id = newId(32);
		const api = hostedApi(a, id, ACCOUNT_A, http);
		await api.create({ members: [a.sigKey] });
		await api.members();
		await api.inbox();
		await api.attach();
		await api.accountStatus();
		// A route, once however often it was sent: the first request may be retried on stale_time.
		const carrying = new Set(
			sent
				.filter((req) => req.headers?.["x-bramble-account"])
				.map((req) => `${req.method} ${new URL(req.url).pathname}`),
		);
		expect([...carrying]).toEqual([
			`POST /v1/mailboxes/${id}`,
			`PUT /v1/mailboxes/${id}/account`,
			"GET /v1/accounts/status",
		]);
		expect(sent.some((req) => req.url.includes(digits(ACCOUNT_A)))).toBe(false);
	});
});
