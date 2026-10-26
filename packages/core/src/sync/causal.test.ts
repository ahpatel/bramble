import { describe, expect, it } from "vitest";
import {
	type Causal,
	causalKey,
	causalOf,
	containsHistory,
	isAncestor,
	isFutureVersion,
	joinCausal,
	nextCausal,
	type Versioned,
	type VersionVector,
	writerOf,
} from "./causal";
import { HLC_MAX_DRIFT_MS, type Hlc } from "./hlc";

const h = (wall: number, node: string, counter = 0): Hlc => ({ wall, counter, node });
const v = (hlc: Hlc, vv?: VersionVector, floor?: Hlc): Versioned => ({
	hlc,
	...(vv ? { vv } : {}),
	...(floor ? { floor } : {}),
});
const at = (hlc: Hlc, c: Causal): Versioned => ({ hlc, ...c });

describe("causal history", () => {
	it("a legacy version claims every event up to its stamp", () => {
		expect(causalOf(v(h(5, "a")))).toEqual({ vv: {}, floor: h(5, "a") });
		expect(writerOf(v(h(5, "a")))).toBe("a");
		expect(isAncestor(v(h(4, "b"), { b: h(4, "b") }), v(h(5, "a")))).toBe(true);
		expect(isAncestor(v(h(6, "b"), { b: h(6, "b") }), v(h(5, "a")))).toBe(false);
	});

	it("a chain is ancestry, concurrent writers are not", () => {
		const s1 = v(h(1, "a"), { a: h(1, "a") });
		const s2 = v(h(2, "b"), { a: h(1, "a"), b: h(2, "b") });
		const c = v(h(3, "c"), { a: h(1, "a"), c: h(3, "c") });
		expect(isAncestor(s1, s2)).toBe(true);
		expect(isAncestor(s2, s1)).toBe(false);
		expect(isAncestor(s2, c)).toBe(false);
		expect(isAncestor(c, s2)).toBe(false);
	});

	it("a floor covers every version stamped at or before it", () => {
		const y = v(h(9, "a"), { a: h(9, "a") }, h(5, "q"));
		expect(isAncestor(v(h(4, "z"), { z: h(4, "z") }), y)).toBe(true);
		expect(isAncestor(v(h(6, "z"), { z: h(6, "z") }), y)).toBe(false);
	});

	it("containsHistory needs the floor and every component covered", () => {
		const t = v(h(3, "b"), { a: h(2, "a"), b: h(3, "b") });
		expect(containsHistory(v(h(4, "c"), { a: h(2, "a"), b: h(3, "b"), c: h(4, "c") }), t)).toBe(
			true,
		);
		expect(containsHistory(v(h(4, "c"), { a: h(2, "a"), c: h(4, "c") }), t)).toBe(false);
		expect(containsHistory(v(h(9, "e"), { e: h(9, "e") }, h(5, "x")), v(h(5, "x")))).toBe(true);
		expect(containsHistory(v(h(9, "a"), { a: h(9, "a") }), v(h(5, "x")))).toBe(false);
		// A component below the outer floor is covered by the floor.
		expect(containsHistory(v(h(9, "e"), { e: h(9, "e") }, h(3, "z")), t)).toBe(true);
	});

	it("joinCausal takes the max of each writer and of the floors", () => {
		expect(joinCausal([])).toEqual({ vv: {} });
		expect(
			joinCausal([
				v(h(2, "a"), { a: h(2, "a"), b: h(1, "b") }),
				v(h(3, "b"), { b: h(3, "b") }, h(1, "z")),
			]),
		).toEqual({ vv: { a: h(2, "a"), b: h(3, "b") }, floor: h(1, "z") });
		expect(joinCausal([v(h(5, "x")), v(h(7, "y"))])).toEqual({ vv: {}, floor: h(7, "y") });
	});

	it("nextCausal on nothing is just its own event", () => {
		expect(nextCausal({ hlc: h(7, "a"), bases: [], held: [] })).toEqual({ vv: { a: h(7, "a") } });
	});

	it("nextCausal inherits a legacy base's claim as its floor", () => {
		expect(nextCausal({ hlc: h(9, "a"), bases: [v(h(5, "b"))], held: [] })).toEqual({
			vv: { a: h(9, "a") },
			floor: h(5, "b"),
		});
	});

	it("an edit around this device's own unresolved sibling forks the writer, and the fork is reused", () => {
		const mine = v(h(2, "a"), { a: h(2, "a") });
		const theirs = v(h(3, "b"), { b: h(3, "b") });
		const first = nextCausal({ hlc: h(4, "a"), bases: [theirs], held: [mine, theirs] });
		const fork = Object.keys(first.vv).find((k) => k.startsWith("a~"))!;
		expect(fork).toBeDefined();
		expect(first.vv.a).toBeUndefined();
		const next = at(h(4, "a"), first);
		expect(writerOf(next)).toBe(fork);
		expect(isAncestor(mine, next)).toBe(false);
		expect(isAncestor(theirs, next)).toBe(true);
		const second = nextCausal({ hlc: h(5, "a"), bases: [next], held: [mine, next] });
		expect(Object.keys(second.vv).filter((k) => k.startsWith("a~"))).toEqual([fork]);
		expect(second.vv[fork]).toEqual(h(5, "a"));
	});

	it("a legacy version of this node counts as its latest event", () => {
		const legacyMine = v(h(6, "a"));
		const c = nextCausal({ hlc: h(8, "a"), bases: [], held: [legacyMine] });
		expect(Object.keys(c.vv)).toHaveLength(1);
		expect(Object.keys(c.vv)[0]!.startsWith("a~")).toBe(true);
		expect(isAncestor(legacyMine, at(h(8, "a"), c))).toBe(false);
	});

	it("no fork when the bases contain this device's latest event", () => {
		const s1 = v(h(1, "a"), { a: h(1, "a") });
		const s2 = v(h(2, "b"), { a: h(1, "a"), b: h(2, "b") });
		const c = nextCausal({ hlc: h(3, "a"), bases: [s2], held: [s1, s2] });
		expect(c).toEqual({ vv: { a: h(3, "a"), b: h(2, "b") } });
	});

	it("isFutureVersion catches a future stamp, floor or vv component", () => {
		const now = 1_000_000;
		const future = h(now + HLC_MAX_DRIFT_MS + 1, "x");
		expect(isFutureVersion(v(h(now, "a"), { a: h(now, "a") }), now)).toBe(false);
		expect(isFutureVersion(v(future), now)).toBe(true);
		expect(isFutureVersion(v(h(now, "a"), { a: h(now, "a"), x: future }), now)).toBe(true);
		expect(isFutureVersion(v(h(now, "a"), { a: h(now, "a") }, future), now)).toBe(true);
	});

	it("causalKey separates a stripped copy from its source and ignores vv key order", () => {
		const full = v(h(5, "a"), { a: h(5, "a"), b: h(3, "b") });
		const reordered = v(h(5, "a"), { b: h(3, "b"), a: h(5, "a") });
		expect(causalKey(v(h(5, "a")))).not.toBe(causalKey(full));
		expect(causalKey(full)).toBe(causalKey(reordered));
		expect(causalKey(v(h(5, "a"), { a: h(5, "a") }, h(1, "z")))).not.toBe(
			causalKey(v(h(5, "a"), { a: h(5, "a") })),
		);
	});
});
