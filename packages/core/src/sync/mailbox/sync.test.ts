import { describe, expect, it, vi } from "vitest";
import { ed25519Signer, fakeMailboxCrypto } from "../../test/mailbox-fakes";
import { memoryBlobStore } from "../../test/memory-blob-store";
import type { RosterPayload } from "../roster";
import { type MailboxApi, MailboxApiError } from "./api";
import type { InboxResponse } from "./protocol";
import { freshState } from "./state";
import { mailboxSync } from "./sync";
import type { MailboxVaultPort } from "./vault-port";

const MAILBOX = "M".repeat(43);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const page = (over: Partial<InboxResponse>): InboxResponse => ({
	messages: [],
	blobs: [],
	wanted: [],
	wantedMore: false,
	markers: [],
	more: false,
	retentionDays: 365,
	usedBytes: 0,
	quotaBytes: null,
	serverTime: 0,
	...over,
});

describe("a mailbox round against a server that fabricates rows", () => {
	it("fabricated senders' rows post no snapshot request", async () => {
		const me = await ed25519Signer();
		const roster: RosterPayload = {
			devices: [
				{
					id: "laptop",
					publicKey: "pk",
					label: "laptop",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "laptop" },
					sigKey: me.sigKey,
				},
			],
			revoked: [],
		};
		const vault: MailboxVaultPort = {
			readLocal: async () => ({ entries: { entries: [], tombstones: [] }, roster }),
			previewRoster: async () => roster,
			apply: async () => ({ setAside: false, refused: [] }),
			quarantine: async () => {},
			current: () => true,
		};
		const strangers = Array.from({ length: 100 }, () => btoa(String.fromCharCode(...random(32))));
		let served = false;
		const posts: { to?: string[] }[] = [];
		const api = {
			mailboxId: MAILBOX,
			account: null,
			serverNow: () => Date.now(),
			ack: vi.fn(async () => {}),
			activate: vi.fn(async () => ({ members: [] })),
			members: vi.fn(async () => ({
				members: [{ sigKey: me.sigKey, status: "active", lastCheckedDay: 1 }],
			})),
			changeMembers: vi.fn(async () => ({ members: [] })),
			post: vi.fn(async (_id: string, _body: Uint8Array, to?: string[]) => {
				posts.push({ to });
				return { stored: true, recipients: 0 };
			}),
			inbox: vi.fn(async () => {
				if (served) return page({});
				served = true;
				return page({
					messages: strangers.map((sender, i) => ({
						id: `${i}`.padStart(22, "a"),
						sender,
						size: 1,
						createdAt: 0,
					})),
				});
			}),
			message: vi.fn(async () => null),
			wants: vi.fn(async () => {}),
		} as unknown as MailboxApi;
		const state = freshState(random);
		state.active = true;
		const engine = mailboxSync({
			api,
			crypto: fakeMailboxCrypto(MAILBOX, me),
			vault,
			blobs: {
				store: memoryBlobStore().store,
				mover: {
					upload: async () => ({ stored: true, recipients: 0 }),
					download: async () => "stored",
				},
			},
			groupKeyB64: "G",
			sigKey: me.sigKey,
			state: { load: async () => state, save: async () => {} },
		});
		await engine.sync();
		expect(posts.filter((p) => p.to)).toHaveLength(0);
		expect(posts.filter((p) => !p.to).length).toBeLessThanOrEqual(1);
		expect(state.gaps).toEqual([]);
		expect(Object.keys(state.senders)).toEqual([]);
	});
});

describe("a mailbox round on a collect-only account", () => {
	it("a changed wants list still reads collect_only, not unreachable", async () => {
		const me = await ed25519Signer();
		const roster: RosterPayload = {
			devices: [
				{
					id: "laptop",
					publicKey: "pk",
					label: "laptop",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "laptop" },
					sigKey: me.sigKey,
				},
			],
			revoked: [],
		};
		const vault: MailboxVaultPort = {
			readLocal: async () => ({ entries: { entries: [], tombstones: [] }, roster }),
			previewRoster: async () => roster,
			apply: async () => ({ setAside: false, refused: [] }),
			quarantine: async () => {},
			current: () => true,
		};
		const refuse = async () => {
			throw new MailboxApiError(402, "collect_only");
		};
		const api = {
			mailboxId: MAILBOX,
			account: null,
			serverNow: () => Date.now(),
			ack: vi.fn(async () => {}),
			activate: vi.fn(async () => ({ members: [] })),
			members: vi.fn(async () => ({
				members: [{ sigKey: me.sigKey, status: "active", lastCheckedDay: 1 }],
			})),
			changeMembers: vi.fn(async () => ({ members: [] })),
			post: vi.fn(refuse),
			inbox: vi.fn(async () => page({})),
			message: vi.fn(async () => null),
			wants: vi.fn(refuse),
		} as unknown as MailboxApi;
		const state = freshState(random);
		state.active = true;
		state.wants = ["a".repeat(64)];
		const engine = mailboxSync({
			api,
			crypto: fakeMailboxCrypto(MAILBOX, me),
			vault,
			blobs: {
				store: memoryBlobStore().store,
				mover: {
					upload: async () => ({ stored: true, recipients: 0 }),
					download: async () => "stored",
				},
			},
			groupKeyB64: "G",
			sigKey: me.sigKey,
			state: { load: async () => state, save: async () => {} },
		});
		expect(await engine.sync()).toBe("collect_only");
	});
});

describe("fetching on a collect-only account", () => {
	it("a round that was refused earlier still fetches a blob the mailbox holds", async () => {
		const me = await ed25519Signer();
		const phone = await ed25519Signer();
		const roster: RosterPayload = {
			devices: [
				{
					id: "laptop",
					publicKey: "pk",
					label: "laptop",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "laptop" },
					sigKey: me.sigKey,
				},
				{
					id: "phone",
					publicKey: "pk-phone",
					label: "phone",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "phone" },
					sigKey: phone.sigKey,
				},
			],
			revoked: [],
		};
		const entries = {
			entries: [],
			tombstones: [],
			files: [
				{
					id: "f1",
					hlc: { wall: 1, counter: 0, node: "laptop" },
					hash: "b".repeat(64),
					size: 10,
					wrappedFek: "x",
					fekIv: "x",
					noncePrefix: "x",
					metaBlob: "x",
					metaIv: "x",
				},
			],
		};
		const vault = {
			readLocal: async () => ({ entries, roster }),
			previewRoster: async () => roster,
			apply: async () => ({ setAside: false, refused: [] }),
			quarantine: async () => {},
			current: () => true,
		} as unknown as MailboxVaultPort;
		const refuse = async () => {
			throw new MailboxApiError(402, "collect_only");
		};
		const api = {
			mailboxId: MAILBOX,
			account: null,
			serverNow: () => Date.now(),
			ack: vi.fn(async () => {}),
			activate: vi.fn(async () => ({ members: [] })),
			members: vi.fn(async () => ({
				members: [{ sigKey: me.sigKey, status: "active", lastCheckedDay: 1 }],
			})),
			changeMembers: vi.fn(async () => ({ members: [] })),
			post: vi.fn(refuse),
			inbox: vi.fn(async () => page({})),
			message: vi.fn(async () => null),
			wants: vi.fn(refuse),
			blobRequest: vi.fn(async () => ({ url: "u", headers: {} })),
		} as unknown as MailboxApi;
		const download = vi.fn(async () => "stored" as const);
		const state = freshState(random);
		state.active = true;
		// Refused before the wants step: a device first active after the account lapsed.
		state.catchUp = true;
		const engine = mailboxSync({
			api,
			crypto: fakeMailboxCrypto(MAILBOX, me),
			vault,
			blobs: {
				store: memoryBlobStore().store,
				mover: { upload: async () => ({ stored: true, recipients: 0 }), download },
			},
			groupKeyB64: "G",
			sigKey: me.sigKey,
			state: { load: async () => state, save: async () => {} },
		});
		expect(await engine.sync()).toBe("collect_only");
		expect(download).toHaveBeenCalledTimes(1);
	});
});
