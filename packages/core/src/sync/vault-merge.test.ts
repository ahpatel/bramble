import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import { nextCausal, type VersionVector } from "./causal";
import type { EntriesPayload, Tombstone } from "./entries-payload";
import type { Hlc } from "./hlc";
import { entryConflicts, heldVersions, mergeEntriesPayload } from "./vault-merge";

const hlc = (wall: number, node: string, counter = 0): Hlc => ({ wall, counter, node });

/** A sealed envelope whose ciphertext is tagged so we can tell which side won. */
const env = (id: string, ct: string, stamp: Hlc): EncryptedEntry => ({
	id,
	wrappedDek: `wd-${ct}`,
	dekIv: `di-${ct}`,
	ciphertext: ct,
	iv: `iv-${ct}`,
	hlc: stamp,
});

const payload = (
	entries: EncryptedEntry[],
	tombstones: { id: string; hlc: Hlc }[] = [],
): EntriesPayload => ({ entries, tombstones });

/** Live entries as id -> ciphertext, order-independent. */
function live(p: EntriesPayload): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of p.entries) out[e.id] = e.ciphertext;
	return out;
}

describe("mergeEntriesPayload", () => {
	it("carries the winning side's sealed envelope verbatim", () => {
		const a = payload([env("github", "ct-laptop", hlc(1500, "laptop"))]);
		const b = payload([env("github", "ct-phone", hlc(1700, "phone"))]);
		const merged = mergeEntriesPayload(a, b);
		const winner = merged.entries.find((e) => e.id === "github");
		expect(winner).toEqual(env("github", "ct-phone", hlc(1700, "phone")));
	});

	it("unions distinct entries from both sides", () => {
		const a = payload([env("1", "a1", hlc(100, "a"))]);
		const b = payload([env("2", "b2", hlc(200, "b"))]);
		expect(live(mergeEntriesPayload(a, b))).toEqual({ "1": "a1", "2": "b2" });
	});

	it("a tombstone removes an entry a stale peer still holds", () => {
		const deleted = payload([], [{ id: "x", hlc: hlc(300, "a") }]);
		const stale = payload([env("x", "old", hlc(100, "a"))]);
		expect(live(mergeEntriesPayload(deleted, stale))).toEqual({});
		expect(live(mergeEntriesPayload(stale, deleted))).toEqual({});
	});

	it("an edit stamped after a delete resurrects the entry", () => {
		const deleted = payload([], [{ id: "x", hlc: hlc(300, "a") }]);
		const edited = payload([env("x", "fresh", hlc(400, "b"))]);
		expect(live(mergeEntriesPayload(deleted, edited))).toEqual({ x: "fresh" });
	});

	it("keeps the merged tombstone graveyard", () => {
		const a = payload([env("keep", "k", hlc(10, "a"))], [{ id: "gone", hlc: hlc(20, "a") }]);
		const b = payload([env("keep", "k", hlc(10, "a"))]);
		const merged = mergeEntriesPayload(a, b);
		expect(merged.tombstones).toEqual([{ id: "gone", hlc: hlc(20, "a") }]);
	});

	it("is commutative and idempotent over the live set", () => {
		const a = payload(
			[env("1", "a1", hlc(100, "a")), env("2", "a2", hlc(400, "a"))],
			[{ id: "3", hlc: hlc(50, "a") }],
		);
		const b = payload(
			[env("1", "b1", hlc(200, "b")), env("3", "b3", hlc(300, "b"))],
			[{ id: "2", hlc: hlc(500, "b") }],
		);
		const ab = mergeEntriesPayload(a, b);
		const ba = mergeEntriesPayload(b, a);
		expect(live(ab)).toEqual(live(ba));
		// id 1 -> b (200>100); id 2 deleted at 500 > 400; id 3 -> b3 (300>50).
		expect(live(ab)).toEqual({ "1": "b1", "3": "b3" });
		expect(live(mergeEntriesPayload(ab, ab))).toEqual(live(ab));
	});
});

/** A version with causal history, ciphertext tagged by `ct`. */
const ver = (
	id: string,
	ct: string,
	stamp: Hlc,
	vv: VersionVector,
	floor?: Hlc,
): EncryptedEntry => ({
	...env(id, ct, stamp),
	vv,
	...(floor ? { floor } : {}),
});
const tomb = (id: string, stamp: Hlc, vv?: VersionVector, floor?: Hlc): Tombstone => ({
	id,
	hlc: stamp,
	...(vv ? { vv } : {}),
	...(floor ? { floor } : {}),
});
const strip = (e: EncryptedEntry): EncryptedEntry => env(e.id, e.ciphertext, e.hlc);
const withConflicts = (p: EntriesPayload, conflicts: EncryptedEntry[]): EntriesPayload => ({
	...p,
	conflicts,
});
const cts = (es: readonly EncryptedEntry[] | undefined) => (es ?? []).map((e) => e.ciphertext);

describe("mergeEntriesPayload siblings", () => {
	it("two all-legacy payloads merge exactly as before", () => {
		const a = payload(
			[env("x", "x-laptop", hlc(1500, "laptop")), env("y", "y", hlc(100, "laptop"))],
			[{ id: "z", hlc: hlc(50, "laptop") }],
		);
		const b = payload(
			[env("x", "x-phone", hlc(1700, "phone")), env("w", "w", hlc(10, "phone"))],
			[{ id: "y", hlc: hlc(200, "phone") }],
		);
		const merged = mergeEntriesPayload(a, b);
		expect(merged).toEqual({
			entries: [env("x", "x-phone", hlc(1700, "phone")), env("w", "w", hlc(10, "phone"))],
			tombstones: [
				{ id: "z", hlc: hlc(50, "laptop") },
				{ id: "y", hlc: hlc(200, "phone") },
			],
		});
		const json = JSON.stringify(merged);
		expect(json).not.toContain('"vv"');
		expect(json).not.toContain('"floor"');
		expect(json).not.toContain('"conflicts"');
	});

	it("a descendant replaces its ancestor with no conflict", () => {
		const s1 = ver("e", "s1", hlc(1, "a"), { a: hlc(1, "a") });
		const s3 = ver("e", "s3", hlc(3, "c"), { a: hlc(1, "a"), b: hlc(2, "b"), c: hlc(3, "c") });
		const merged = mergeEntriesPayload(payload([s1]), payload([s3]));
		expect(cts(merged.entries)).toEqual(["s3"]);
		expect(merged.conflicts).toBeUndefined();
		expect(entryConflicts(merged).size).toBe(0);
	});

	it("concurrent edits keep both and display the higher stamp", () => {
		const x = ver("e", "x", hlc(2, "a"), { a: hlc(2, "a") });
		const y = ver("e", "y", hlc(3, "b"), { a: hlc(1, "a"), b: hlc(3, "b") });
		for (const merged of [
			mergeEntriesPayload(payload([x]), payload([y])),
			mergeEntriesPayload(payload([y]), payload([x])),
		]) {
			expect(cts(merged.entries)).toEqual(["y"]);
			expect(cts(merged.conflicts)).toEqual(["x"]);
			expect(entryConflicts(merged).get("e")).toEqual({ versions: 1, deleted: false });
		}
	});

	it("a resolution supersedes every sibling", () => {
		const x = ver("e", "x", hlc(2, "a"), { a: hlc(2, "a") });
		const y = ver("e", "y", hlc(3, "b"), { a: hlc(1, "a"), b: hlc(3, "b") });
		const r = ver("e", "r", hlc(4, "a"), { a: hlc(4, "a"), b: hlc(3, "b") });
		const merged = mergeEntriesPayload(withConflicts(payload([y]), [x]), payload([r]));
		expect(cts(merged.entries)).toEqual(["r"]);
		expect(merged.conflicts).toBeUndefined();
	});

	it("a delete that saw the edit removes the entry", () => {
		const x = ver("e", "x", hlc(2, "a"), { a: hlc(2, "a") });
		const t = tomb("e", hlc(3, "b"), { a: hlc(2, "a"), b: hlc(3, "b") });
		const merged = mergeEntriesPayload(payload([x]), payload([], [t]));
		expect(merged.entries).toEqual([]);
		expect(merged.tombstones).toEqual([t]);
		expect(entryConflicts(merged).size).toBe(0);
	});

	it("a delete concurrent with an edit keeps the entry and flags it deleted", () => {
		const cases = [
			// The delete is newer.
			[
				ver("e", "edit", hlc(2, "a"), { a: hlc(2, "a") }),
				tomb("e", hlc(3, "b"), { a: hlc(1, "a"), b: hlc(3, "b") }),
			],
			// The edit is newer.
			[
				ver("e", "edit", hlc(5, "a"), { a: hlc(5, "a") }),
				tomb("e", hlc(3, "b"), { a: hlc(1, "a"), b: hlc(3, "b") }),
			],
		] as const;
		for (const [edit, del] of cases) {
			for (const merged of [
				mergeEntriesPayload(payload([edit]), payload([], [del])),
				mergeEntriesPayload(payload([], [del]), payload([edit])),
			]) {
				expect(cts(merged.entries)).toEqual(["edit"]);
				expect(merged.tombstones).toEqual([del]);
				expect(entryConflicts(merged).get("e")).toEqual({ versions: 0, deleted: true });
			}
		}
	});

	it("keeping an entry after a delete conflict supersedes the tombstone", () => {
		const edit = ver("e", "edit", hlc(2, "a"), { a: hlc(2, "a") });
		const del = tomb("e", hlc(3, "b"), { a: hlc(1, "a"), b: hlc(3, "b") });
		const kept = ver("e", "kept", hlc(4, "a"), { a: hlc(4, "a"), b: hlc(3, "b") });
		const merged = mergeEntriesPayload(payload([edit], [del]), payload([kept]));
		expect(cts(merged.entries)).toEqual(["kept"]);
		expect(merged.tombstones).toEqual([del]);
		expect(entryConflicts(merged).size).toBe(0);
	});

	it("a stripped live copy is the same version", () => {
		const x = ver("e", "x", hlc(2, "a"), { a: hlc(2, "a") });
		expect(mergeEntriesPayload(payload([x]), payload([strip(x)])).entries).toEqual([x]);
		expect(mergeEntriesPayload(payload([strip(x)]), payload([x])).entries).toEqual([x]);
	});

	it("a stale stripped copy of a superseded version does not prune a sibling", () => {
		// X and Y are concurrent; R edited X (the displayed one) elsewhere; an older build still holds X.
		const x = ver("e", "x", hlc(9, "a"), { a: hlc(9, "a") });
		const y = ver("e", "y", hlc(7, "b"), { b: hlc(7, "b") });
		const r = ver("e", "r", hlc(10, "c"), { a: hlc(9, "a"), c: hlc(10, "c") });
		const local = withConflicts(payload([r]), [y]);
		for (const merged of [
			mergeEntriesPayload(local, payload([strip(x)])),
			mergeEntriesPayload(payload([strip(x)]), local),
		]) {
			expect(cts(merged.entries)).toEqual(["r"]);
			expect(cts(merged.conflicts)).toEqual(["y"]);
		}
	});

	it("a stripped copy of an older delete does not kill a delete-conflicted edit", () => {
		// Two concurrent deletes of s1, and an edit concurrent with both.
		const edit = ver("e", "edit", hlc(4, "a"), { a: hlc(4, "a") });
		const d1 = tomb("e", hlc(5, "b"), { a: hlc(1, "a"), b: hlc(5, "b") });
		const joined = tomb("e", hlc(8, "c"), { a: hlc(1, "a"), b: hlc(5, "b"), c: hlc(8, "c") });
		const strippedD1 = tomb("e", d1.hlc);
		const local = payload([edit], [joined]);
		for (const merged of [
			mergeEntriesPayload(local, payload([], [strippedD1])),
			mergeEntriesPayload(payload([], [strippedD1]), local),
		]) {
			expect(cts(merged.entries)).toEqual(["edit"]);
			expect(merged.tombstones).toEqual([joined]);
			expect(entryConflicts(merged).get("e")).toEqual({ versions: 0, deleted: true });
		}
	});

	it("a stripped copy of a tombstone written under a fork key is the same tombstone", () => {
		const edit = ver("e", "edit", hlc(4, "a"), { a: hlc(4, "a") });
		const forked = tomb("e", hlc(8, "c"), { a: hlc(1, "a"), "c~fork": hlc(8, "c") });
		const local = payload([edit], [forked]);
		for (const merged of [
			mergeEntriesPayload(local, payload([], [tomb("e", forked.hlc)])),
			mergeEntriesPayload(payload([], [tomb("e", forked.hlc)]), local),
		]) {
			expect(cts(merged.entries)).toEqual(["edit"]);
			expect(merged.tombstones).toEqual([forked]);
		}
	});

	it("two tombstones at one stamp with different histories join", () => {
		const t1 = tomb("e", hlc(8, "c"), { a: hlc(1, "a"), c: hlc(8, "c") });
		const t2 = tomb("e", hlc(8, "c"), { b: hlc(5, "b"), c: hlc(8, "c") });
		const joined = tomb("e", hlc(8, "c"), { a: hlc(1, "a"), b: hlc(5, "b"), c: hlc(8, "c") });
		expect(mergeEntriesPayload(payload([], [t1]), payload([], [t2])).tombstones).toEqual([joined]);
		expect(mergeEntriesPayload(payload([], [t2]), payload([], [t1])).tombstones).toEqual([joined]);
	});

	it("an older build's genuine edit dominates everything stamped before it", () => {
		const x = ver("e", "x", hlc(3, "a"), { a: hlc(3, "a") });
		const legacy = env("e", "legacy", hlc(5, "old"));
		const merged = mergeEntriesPayload(payload([x]), payload([legacy]));
		expect(cts(merged.entries)).toEqual(["legacy"]);
		expect(merged.conflicts).toBeUndefined();
	});

	it("an edit around an unresolved sibling keeps the sibling", () => {
		const mine = ver("e", "mine", hlc(2, "a"), { a: hlc(2, "a") });
		const theirs = ver("e", "theirs", hlc(3, "b"), { b: hlc(3, "b") });
		const local = withConflicts(payload([theirs]), [mine]);
		const stamp = hlc(4, "a");
		const edit = {
			...env("e", "edit", stamp),
			...nextCausal({ hlc: stamp, bases: [theirs], held: heldVersions(local, "e") }),
		};
		const merged = mergeEntriesPayload(local, payload([edit]));
		expect(cts(merged.entries)).toEqual(["edit"]);
		expect(cts(merged.conflicts)).toEqual(["mine"]);
	});

	it("heldVersions lists the displayed version, its siblings and its tombstone", () => {
		const x = ver("e", "x", hlc(2, "a"), { a: hlc(2, "a") });
		const y = ver("e", "y", hlc(3, "b"), { b: hlc(3, "b") });
		const t = tomb("e", hlc(1, "c"), { c: hlc(1, "c") });
		const held = heldVersions(withConflicts(payload([y], [t]), [x]), "e");
		expect(held).toEqual([y, x, t]);
	});
});
