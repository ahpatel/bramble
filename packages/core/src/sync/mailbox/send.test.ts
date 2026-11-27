import { describe, expect, it, vi } from "vitest";
import { ed25519Signer, fakeMailboxCrypto } from "../../test/mailbox-fakes";
import type { MailboxApi } from "./api";
import type { MailboxContext } from "./context";
import { LIMITS } from "./limits";
import { MAX_MEMBERS } from "./protocol";
import { postChanges, postSnapshot, requestSnapshot } from "./send";
import { freshState } from "./state";

const MAILBOX = "M".repeat(43);
const E = "e".repeat(22);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const gone = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

async function setup(now: { at: number }) {
	const me = await ed25519Signer();
	const base = fakeMailboxCrypto(MAILBOX, me);
	const sealed: Record<string, unknown>[] = [];
	const post = vi.fn(async () => ({ stored: true, recipients: 1 }));
	const ctx = {
		api: { mailboxId: MAILBOX, serverNow: () => now.at, post } as unknown as MailboxApi,
		crypto: {
			...base,
			mailboxSeal: async (group: string, aad: string, plaintext: string) => {
				sealed.push(JSON.parse(plaintext));
				return base.mailboxSeal(group, aad, plaintext);
			},
		},
		groupKeyB64: "G",
		sigKey: me.sigKey,
		now: () => now.at,
		random,
	} as unknown as MailboxContext;
	return { ctx, sealed, post, state: freshState(random) };
}

const keyOf = (i: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(i)));
const rosterOf = (sigKeys: string[]) => ({
	devices: sigKeys.map((sigKey, i) => ({
		id: `d${i}`,
		publicKey: `pk-${i}`,
		label: `d${i}`,
		addedAt: 1,
		hlc: { wall: 1, counter: 0, node: `d${i}` },
		sigKey,
	})),
	revoked: [],
});
const emptyEntries = { entries: [], tombstones: [] };

describe("who a post is for", () => {
	it("a device alone in its roster sends nothing", async () => {
		const s = await setup({ at: 1000 });
		const local = { entries: emptyEntries, roster: rosterOf([s.ctx.sigKey]) };
		expect(await postChanges(s.ctx, s.state, local)).toBe("posted");
		expect(s.post).not.toHaveBeenCalled();
	});

	it("a roster longer than the server's limit is addressed in parts of one message", async () => {
		const s = await setup({ at: 1000 });
		const others = Array.from({ length: MAX_MEMBERS + 6 }, (_, i) => keyOf(i + 1));
		const local = { entries: emptyEntries, roster: rosterOf([s.ctx.sigKey, ...others]) };
		await postChanges(s.ctx, s.state, local);
		const calls = s.post.mock.calls as unknown as [string, Uint8Array, string[]][];
		expect(calls.map(([, , to]) => to.length)).toEqual([MAX_MEMBERS, 6]);
		expect(new Set(calls.map(([id]) => id)).size).toBe(1);
		expect(calls.flatMap(([, , to]) => to).sort()).toEqual([...others].sort());
	});
});

describe("answering and asking about a gap", () => {
	it("an answer carries this device's track for the sender it answers", async () => {
		const s = await setup({ at: 1000 });
		s.state.senders[gone] = { epoch: E, through: 4, above: [6] };
		await postSnapshot(
			s.ctx,
			s.state,
			{ entries: { entries: [], tombstones: [] }, roster: { devices: [], revoked: [] } },
			[gone],
			gone,
		);
		expect(s.sealed[0]).toMatchObject({ answers: gone, covers: { epoch: E, through: 4 } });
	});

	it("an uncovered gap is asked about again only after uncoveredRetryMs", async () => {
		const now = { at: 1000 };
		const s = await setup(now);
		s.state.uncovered[gone] = 1000;
		now.at = 1000 + LIMITS.requestEveryMs + 1;
		await requestSnapshot(s.ctx, s.state, gone, rosterOf([]));
		expect(s.post).not.toHaveBeenCalled();
		now.at = 1000 + LIMITS.uncoveredRetryMs + 1;
		await requestSnapshot(s.ctx, s.state, gone, rosterOf([]));
		expect(s.post).toHaveBeenCalledTimes(1);
	});
});
