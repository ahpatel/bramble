// The engine end to end against the real server: devices that are never online together, each
// syncing in turn. The spec's Phasing scenarios plus the plan's Review Focus.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildCryptoAdapter } from "@core/adapters/crypto-wasm";
import type { MailboxSigner } from "@core/sync/mailbox/api";
import { openMessage } from "@core/sync/mailbox/envelope";
import { decodePlaintext } from "@core/sync/mailbox/plaintext";
import { accountKeyOf } from "@core/sync/mailbox/protocol";
import { mailboxSync } from "@core/sync/mailbox/sync";
import { addDevice, type RosterEntry, revokeDevice } from "@core/sync/roster";
import type { VaultCrypto } from "@core/wasm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	activeGroup,
	addLogin,
	attachFile,
	type GroupKeys,
	inboxKinds,
	names,
	type TestDevice,
	testGroup,
	useAccount,
} from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

function engine(d: TestDevice) {
	return mailboxSync({
		...d.ctx,
		state: {
			load: async () => d.state,
			save: async (s) => {
				d.state = s;
			},
		},
	});
}

async function statuses(d: TestDevice): Promise<Record<string, string>> {
	const { members } = await d.ctx.api.members();
	return Object.fromEntries(members.map((m) => [m.sigKey, m.status]));
}

/** Sync each device in turn, `rounds` times. */
async function rounds(n: number, ...engines: ReturnType<typeof engine>[]) {
	for (let i = 0; i < n; i++) for (const e of engines) await e.sync();
}

/** Take `id` out of `d`'s roster; its entry, to add back later. */
function without(d: TestDevice, id: string): RosterEntry {
	const entry = d.roster.current.devices.find((e) => e.id === id) as RosterEntry;
	d.roster.current.devices = d.roster.current.devices.filter((e) => e.id !== id);
	return entry;
}

/** `d`'s roster check turns `id` away, as one does a device it can't verify, until `value` is set. */
function refusing(d: TestDevice, id: string): { value: boolean } {
	const trust = { value: false };
	const vault = d.ctx.vault;
	d.ctx = {
		...d.ctx,
		vault: {
			...vault,
			previewRoster: async (remote) => {
				const merged = await vault.previewRoster(remote);
				if (trust.value) return merged;
				return { ...merged, devices: merged.devices.filter((e) => e.id !== id) };
			},
		},
	};
	return trust;
}

const hour = 3_600_000;
const day = 24 * hour;

describe("mailbox sync end to end", () => {
	it("two devices that are never online together converge on entries and files", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([1, 2, 3]));
		expect(await A.sync()).toBe("synced");
		await rounds(3, B, A);
		expect(await names(b)).toEqual(["Passport"]);
		expect(await b.blobs.has(hash)).toBe(true);

		await addLogin(b, "Bank");
		await rounds(1, B, A);
		expect(await names(a)).toEqual(["Bank", "Passport"]);
	});

	it("a late activation catches up from the others' snapshots", async () => {
		const [a, b, c] = (await testGroup(box, ["a", "b", "c"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		const [A, B, C] = [engine(a), engine(b), engine(c)];
		await addLogin(a, "One");
		await addLogin(b, "Two");
		await rounds(3, A, B);
		expect(await names(c)).toEqual([]);
		await rounds(2, C, A, B);
		expect(await names(c)).toEqual(["One", "Two"]);
	});

	it("a member this device learns after posting is sent a snapshot", async () => {
		const [a, b, c] = (await activeGroup(box, ["a", "b", "c"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		const joined = without(b, "c");
		// a listed c and is away from now on; b's daily reconcile isn't due, so c stays listed.
		b.state.reconciled = { roster: [a.sigKey, b.sigKey].sort().join(","), at: Date.now() };
		const trust = refusing(b, "c");
		c.state.catchUp = true;
		const [B, C] = [engine(b), engine(c)];
		await C.sync();
		await addLogin(b, "Two");
		await B.sync();
		trust.value = true;
		b.roster.current = addDevice(b.roster.current, joined);
		await rounds(2, B, C);
		expect(await names(c)).toEqual(["Two"]);
	});

	it("a device that has never posted sends no snapshot to the members it starts with", async () => {
		const [a, b] = (await activeGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const A = engine(a);
		await addLogin(a, "One");
		await A.sync();
		// What a state saved by a build without the record loads as.
		a.state.addressed = null;
		await addLogin(a, "Two");
		await rounds(2, A);
		expect(await inboxKinds(b)).not.toContain("snapshot");
	});

	it("a sender refused earlier is asked for a snapshot once the roster holds it", async () => {
		const [b, c] = (await activeGroup(box, ["b", "c"])) as [TestDevice, TestDevice];
		const joined = without(b, "c");
		b.state.reconciled = { roster: b.sigKey, at: Date.now() };
		const trust = refusing(b, "c");
		const [B, C] = [engine(b), engine(c)];
		await addLogin(c, "Three");
		await C.sync();
		await B.sync();
		expect(await names(b)).toEqual([]);
		trust.value = true;
		b.roster.current = addDevice(b.roster.current, joined);
		await rounds(2, B, C);
		await B.sync();
		expect(await names(b)).toEqual(["Three"]);
	});

	it("a catch-up answered within the hour is not sent twice", async () => {
		const [b, c] = (await activeGroup(box, ["b", "c"])) as [TestDevice, TestDevice];
		const joined = without(b, "c");
		b.state.reconciled = { roster: b.sigKey, at: Date.now() };
		const [B, C] = [engine(b), engine(c)];
		await addLogin(b, "One");
		await B.sync();
		b.roster.current = addDevice(b.roster.current, joined);
		c.state.catchUp = true;
		await C.sync();
		await rounds(2, B);
		expect((await inboxKinds(c)).filter((k) => k === "snapshot")).toHaveLength(1);
	});

	it("a future-dated message is retried, not lost", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"], { now: () => Date.now() + hour })) as [
			TestDevice,
			TestDevice,
		];
		const [A, B] = [engine(a), engine(b)];
		await addLogin(a, "Passport");
		await rounds(2, A, B);
		expect(await names(b)).toEqual([]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 2 * hour);
			await B.sync();
		} finally {
			vi.useRealTimers();
		}
		expect(await names(b)).toEqual(["Passport"]);
	});

	it("a lost message is healed by a snapshot", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await rounds(2, A, B);
		for (const n of ["One", "Two", "Three"]) {
			await addLogin(a, n);
			await A.sync();
		}
		// The server loses seq 2 for B: acknowledged without being merged.
		for (const m of (await b.ctx.api.inbox()).messages) {
			const body = (await b.ctx.api.message(m.id)) as Uint8Array;
			const text = await openMessage(b.ctx.crypto, {
				groupKeyB64: b.ctx.groupKeyB64,
				mailboxId: b.ctx.api.mailboxId,
				messageId: m.id,
				sender: m.sender,
				body,
			});
			const decoded = decodePlaintext(text);
			if (decoded.ok && decoded.message.kind === "delta" && decoded.message.seq === 2) {
				await b.ctx.api.ack({ messages: [m.id] });
			}
		}
		await rounds(2, B, A);
		await B.sync();
		expect(await names(b)).toEqual(["One", "Three", "Two"]);
		expect(b.state.senders[a.sigKey]?.above).toEqual([]);
	});

	it("a revoked device's posts are quarantined, and reconciliation removes it", async () => {
		const [a, b, c] = (await testGroup(box, ["a", "b", "c"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		const [A, B, C] = [engine(a), engine(b), engine(c)];
		await rounds(2, A, B, C);
		const stamp = { wall: Date.now(), counter: 0, node: "a" };
		a.roster.current = revokeDevice(a.roster.current, "c", stamp);
		b.roster.current = revokeDevice(b.roster.current, "c", stamp);
		await addLogin(c, "Planted");
		await C.sync();
		await B.sync();
		expect(await names(b)).toEqual([]);
		expect(await b.quarantined()).toContainEqual(
			expect.objectContaining({ sender: c.sigKey, reason: "revoked_sender" }),
		);
		expect(c.sigKey in (await statuses(a))).toBe(false);
	});

	it("a full quota and collect-only keep collecting", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await rounds(2, A, B);
		await addLogin(a, "Passport");
		await A.sync();
		await addLogin(b, "Bank");
		await box.setCanPost(false);
		try {
			expect(await B.sync()).toBe("collect_only");
			expect(await names(b)).toEqual(["Bank", "Passport"]);
		} finally {
			await box.setCanPost(true);
		}
		expect(await B.sync()).toBe("synced");
		await A.sync();
		expect(await names(a)).toEqual(["Bank", "Passport"]);

		// 4,000 bytes of bodies, plus the server's 4 KiB charge for each of two rows.
		const small = await startTestMailbox({ QUOTA_BYTES: String(4000 + 2 * 4096) });
		try {
			const [x, y] = (await testGroup(small, ["x", "y"])) as [TestDevice, TestDevice];
			const [X, Y] = [engine(x), engine(y)];
			await rounds(2, X, Y);
			for (let i = 0; i < 40; i++) await addLogin(x, `Login number ${i}`);
			expect(await X.sync()).toBe("quota_exceeded");
			expect(await Y.sync()).toBe("synced");
		} finally {
			await small.close();
		}
	});

	it("a stale roster does not evict a newly paired device", async () => {
		const [a, b, c] = (await testGroup(box, ["a", "b", "c"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		const paired = a.roster.current.devices.find((d) => d.id === "c") as RosterEntry;
		for (const d of [a, b]) {
			d.roster.current = {
				...d.roster.current,
				devices: d.roster.current.devices.filter((x) => x.id !== "c"),
			};
		}
		const [A, B, C] = [engine(a), engine(b), engine(c)];
		await rounds(2, A, B);
		a.roster.current = addDevice(a.roster.current, paired);
		await A.sync();
		await C.sync();
		// B's daily reconcile comes due while its roster still lacks C.
		b.state.reconciled = null;
		await B.sync();
		expect((await statuses(a))[c.sigKey]).toBe("active");
	});

	it("a device revoked this round is removed before anything is posted", async () => {
		const [a, b, d] = (await testGroup(box, ["a", "b", "d"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		await rounds(2, engine(a), engine(b), engine(d));
		b.roster.current = revokeDevice(b.roster.current, "d", {
			wall: Date.now(),
			counter: 0,
			node: "b",
		});
		await addLogin(b, "After");
		const calls: string[] = [];
		const api = b.ctx.api;
		b.ctx.api = {
			...api,
			changeMembers: (body) => {
				calls.push(`members:-${body.remove.length}`);
				return api.changeMembers(body);
			},
			post: (id, body, to) => {
				calls.push("post");
				return api.post(id, body, to);
			},
		};
		await engine(b).sync();
		expect(calls.indexOf("members:-1")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("members:-1")).toBeLessThan(calls.indexOf("post"));
	});

	it("a replayed deactivation is undone on the next sync", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await rounds(1, A, B);
		await b.ctx.api.activate(false);
		await B.sync();
		expect((await statuses(a))[b.sigKey]).toBe("active");
	});

	it("the same flow converges with the real core's crypto", async () => {
		const dir = `${process.cwd()}/../extension/public/wasm`;
		if (!existsSync(`${dir}/vault_crypto.js`))
			throw new Error(`no WASM at ${dir}: pnpm run wasm:build`);
		const mod = await import(`${dir}/vault_crypto.js`);
		await mod.default({ module_or_path: readFileSync(`${dir}/vault_crypto_bg.wasm`) });
		const wasm = mod as unknown as VaultCrypto & {
			roster_sig_generate_key(): { secretKey: string; publicKey: string };
			roster_sign(secretB64: string, message: string): string;
			roster_verify(publicB64: string, message: string, sigB64: string): boolean;
		};
		const core = buildCryptoAdapter(async () => wasm);
		await core.generateVek();
		const groupKeyB64 = randomBytes(32).toString("base64");
		const signers: MailboxSigner[] = [0, 1].map(() => {
			const key = wasm.roster_sig_generate_key();
			return { sigKey: key.publicKey, sign: async (m) => wasm.roster_sign(key.secretKey, m) };
		});
		const keys: GroupKeys = {
			mailboxId: await (core.mailboxId as (g: string) => Promise<string>)(groupKeyB64),
			groupKeyB64,
			signers,
			crypto: (signer) => ({
				mailboxId: (g) => (core.mailboxId as (g: string) => Promise<string>)(g),
				mailboxSeal: (g, aad, p) =>
					(core.mailboxSeal as (g: string, a: string, p: string) => Promise<string>)(g, aad, p),
				mailboxOpen: (g, aad, s) =>
					(core.mailboxOpen as (g: string, a: string, s: string) => Promise<string>)(g, aad, s),
				sign: (m) => signer.sign(m),
				verify: async (k, m, s) => wasm.roster_verify(k, m, s),
			}),
		};
		const [a, b] = (await testGroup(box, ["a", "b"], { keys })) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await addLogin(a, "Passport");
		await rounds(3, A, B);
		expect(await names(b)).toEqual(["Passport"]);
	});

	// The last two move the shared server's clock on.
	it("compaction keeps an absent member's backlog to one snapshot", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"], { limits: { compactCount: 3 } })) as [
			TestDevice,
			TestDevice,
		];
		const [A, B] = [engine(a), engine(b)];
		await rounds(1, A, B);
		await box.advance(day);
		for (const n of ["One", "Two", "Three"]) {
			await addLogin(a, n);
			await A.sync();
		}
		expect(await inboxKinds(b)).toEqual(["snapshot"]);
		await B.sync();
		expect(await names(b)).toEqual(["One", "Three", "Two"]);
	});

	it("an expired message becomes a marker, and the returning device heals", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await rounds(2, A, B);
		await addLogin(a, "Lost");
		await A.sync();
		await box.advance(200 * day);
		await A.sync();
		await box.advance(166 * day);
		await box.sweep();
		expect((await b.ctx.api.inbox()).markers).toHaveLength(1);
		await rounds(2, B, A);
		await B.sync();
		expect(await names(b)).toEqual(["Lost"]);
	});

	it("a mailbox deleted as abandoned is created again", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		const [A, B] = [engine(a), engine(b)];
		await rounds(1, A, B);
		await box.advance(400 * day);
		await box.sweep();
		await A.sync();
		expect((await statuses(a))[a.sigKey]).toBe("active");
	});
});

describe("a group on the hosted mailbox", () => {
	const A = "11111 22222 33333 44444 55555";
	const B = "66666 77777 88888 99999 00000";
	const paid = { paidThrough: 1_900_000_000_000, frozen: false, usedBytes: 0, quotaBytes: 1e9 };
	const idOf = (number: string) => `acct_${number.replace(/ /g, "")}`;
	let hosted: TestMailbox;
	beforeAll(async () => {
		hosted = await startTestMailbox({
			ACCOUNTS: JSON.stringify({ [A.replace(/ /g, "")]: paid, [B.replace(/ /g, "")]: paid }),
		});
	});
	afterAll(() => hosted.close());

	it("the first device creates the mailbox under the group's account", async () => {
		const [a] = (await testGroup(hosted, ["a", "b"], { account: A })) as [TestDevice];
		expect(await engine(a).sync()).toBe("synced");
		expect(await hosted.accountOf(a.ctx.api.mailboxId)).toBe(idOf(A));
	});

	it("with no number and no mailbox yet, a round asks for one", async () => {
		const [a] = (await testGroup(hosted, ["a"])) as [TestDevice];
		const e = engine(a);
		expect(await e.sync()).toBe("account_required");
		expect(await e.sync()).toBe("account_required");
	});

	it("an unknown number is reported, not retried", async () => {
		const [a] = (await testGroup(hosted, ["a"], {
			account: "12345 12345 12345 12345 12345",
		})) as [TestDevice];
		expect(await engine(a).sync()).toBe("account_unknown");
	});

	it("a new number moves the mailbox on the next round", async () => {
		const [a, b] = (await testGroup(hosted, ["a", "b"], { account: A })) as [
			TestDevice,
			TestDevice,
		];
		await rounds(1, engine(a), engine(b));
		useAccount(a, hosted, B);
		useAccount(b, hosted, B);
		expect(await engine(a).sync()).toBe("synced");
		expect(await engine(b).sync()).toBe("synced");
		expect(await hosted.accountOf(a.ctx.api.mailboxId)).toBe(idOf(B));
		expect(a.state.account).toBe(await accountKeyOf(B));
		expect(b.state.account).toBe(await accountKeyOf(B));
	});

	it("a device with no number joins a mailbox that exists", async () => {
		const [a, b] = (await testGroup(hosted, ["a", "b"], { account: A })) as [
			TestDevice,
			TestDevice,
		];
		expect(await engine(a).sync()).toBe("synced");
		useAccount(b, hosted);
		expect(await engine(b).sync()).toBe("synced");
		expect(b.state.active).toBe(true);
	});
});
