import { describe, expect, it } from "vitest";
import { MESSAGE_ID_RE } from "./protocol";
import { forgetStrangers, freshState, metaStateStore, retryRefused } from "./state";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function meta(initial?: unknown) {
	const values = new Map<string, unknown>(initial === undefined ? [] : [["k", initial]]);
	return {
		getMeta: async <T>(key: string) => values.get(key) as T | undefined,
		setMeta: async <T>(key: string, value: T) => {
			values.set(key, value);
		},
	};
}

describe("mailbox state", () => {
	it("a missing or unparsable state loads fresh, with an epoch of message-id shape", async () => {
		for (const initial of [undefined, { nextSeq: "seven" }]) {
			const state = await metaStateStore(meta(initial), "k", random).load();
			expect(MESSAGE_ID_RE.test(state.epoch)).toBe(true);
			expect(state).toMatchObject({ nextSeq: 1, active: false, posted: {}, log: [] });
		}
	});

	it("a saved state loads back", async () => {
		const store = metaStateStore(meta(), "k", random);
		const state = {
			...freshState(random),
			nextSeq: 7,
			active: true,
			gaps: [btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))],
		};
		await store.save(state);
		expect(await store.load()).toEqual(state);
	});

	it("a stored state from before these fields still loads", async () => {
		const {
			addressed: _a,
			refused: _r,
			...older
		} = {
			...freshState(random),
			nextSeq: 4,
			addressed: null,
			refused: [],
		};
		const state = await metaStateStore(meta(older), "k", random).load();
		expect(state.nextSeq).toBe(4);
		expect(state.addressed).toBeNull();
		expect(state.refused).toEqual([]);
	});
});

describe("retryRefused", () => {
	it("moves a refused sender the roster now holds to the gaps, and keeps the rest", () => {
		const state = freshState(random);
		state.refused = ["joined", "stranger"];
		retryRefused(state, ["joined", "member"]);
		expect(state.gaps).toEqual(["joined"]);
		expect(state.refused).toEqual(["stranger"]);
	});

	it("forgetting strangers keeps the refused senders", () => {
		const state = freshState(random);
		state.refused = ["stranger"];
		forgetStrangers(state, ["member"]);
		expect(state.refused).toEqual(["stranger"]);
	});
});

describe("forgetStrangers", () => {
	it("drops every trace of a key the roster doesn't hold", () => {
		const state = freshState((n) => new Uint8Array(n));
		const track = { epoch: "e".repeat(22), through: 1, above: [3] };
		const parts = { epoch: "e".repeat(22), seq: 2, parts: 2, got: [1] };
		for (const k of ["member", "stranger"]) {
			state.gaps.push(k);
			state.senders[k] = track;
			state.snapshots[k] = parts;
			state.requested[k] = 1;
			state.answered[`${k}|*`] = 1;
			state.toAnswer[k] = null;
			state.uncovered[k] = 1;
		}
		state.requested["*"] = 1;
		forgetStrangers(state, ["member"]);
		expect(state.gaps).toEqual(["member"]);
		expect(Object.keys(state.senders)).toEqual(["member"]);
		expect(Object.keys(state.snapshots)).toEqual(["member"]);
		expect(Object.keys(state.requested).sort()).toEqual(["*", "member"]);
		expect(Object.keys(state.answered)).toEqual(["member|*"]);
		expect(Object.keys(state.toAnswer)).toEqual(["member"]);
		expect(Object.keys(state.uncovered)).toEqual(["member"]);
	});
});
