import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { withPartStamps } from "../vault/parts";
import type { EncryptedEntry } from "../vault-format";
import { isAncestor, nextCausal, type Versioned } from "./causal";
import {
	type CombineCrypto,
	type Combined,
	combinePayload,
	combineSiblings,
	type Sibling,
} from "./combine";
import type { Hlc } from "./hlc";

const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });

function envelope(id: string, version: Versioned): EncryptedEntry {
	return {
		id,
		wrappedDek: "w",
		dekIv: "d",
		ciphertext: "c",
		iv: "i",
		...version,
	} as EncryptedEntry;
}

/** A first version written by a build that records histories and part stamps. */
function created(data: EntryData, stamp: Hlc): Sibling {
	const causal = nextCausal({ hlc: stamp, bases: [], held: [] });
	const withStamps = withPartStamps({ id: "e", ...data } as Entry, undefined, stamp);
	return { envelope: envelope("e", { hlc: stamp, ...causal }), data: withStamps };
}

/** A version an older build wrote: no history, no part stamps. */
function legacy(data: EntryData, stamp: Hlc): Sibling {
	return { envelope: envelope("e", { hlc: stamp }), data: { ...data } };
}

/** An edit of `prev` at `stamp`, the way EntryMutations writes one. */
function edit(prev: Sibling, changes: Record<string, unknown>, stamp: Hlc): Sibling {
	const causal = nextCausal({ hlc: stamp, bases: [prev.envelope], held: [prev.envelope] });
	const next = { ...prev.data, ...changes } as Entry;
	for (const [k, v] of Object.entries(changes)) if (v === undefined) delete (next as never)[k];
	const data = withPartStamps(
		{ ...next, id: "e" },
		{ data: prev.data, version: prev.envelope },
		stamp,
	);
	return { envelope: envelope("e", { hlc: stamp, ...causal }), data };
}

const login = (over: Record<string, unknown> = {}): EntryData =>
	({ type: "login", name: "GitHub", urls: [], username: "u", password: "p", ...over }) as EntryData;
const as = (c: Combined | null) => c?.data as Record<string, unknown> | undefined;

describe("combineSiblings", () => {
	const base = created(login({ notes: "n0" }), at(10, "a"));

	it("password on one side, notes on the other: combines", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const c = await combineSiblings([x, y]);
		expect(as(c)).toMatchObject({ password: "px", notes: "ny", username: "u" });
		expect(c!.replaces).toEqual([y.envelope, x.envelope]);
		expect(c!.data.partStampsAt).toEqual(c!.hlc);
	});

	it("both changed the password: no combine", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { password: "py" }, at(30, "b"));
		expect(await combineSiblings([x, y])).toBeNull();
	});

	it("username on one, password on the other: no combine", async () => {
		const x = edit(base, { username: "ux" }, at(20, "a"));
		const y = edit(base, { password: "py" }, at(30, "b"));
		expect(await combineSiblings([x, y])).toBeNull();
	});

	it("archive on one, edit on the other: combines archived", async () => {
		const x = edit(base, { archivedAt: 20 }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))).toMatchObject({ archivedAt: 20, notes: "ny" });
	});

	it("both add the same tag in different case: one tag, the higher stamp's spelling", async () => {
		const x = edit(base, { tags: ["work"] }, at(20, "a"));
		const y = edit(base, { tags: ["Work"] }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))?.tags).toEqual(["Work"]);
	});

	it("a removal the other side saw wins; an addition it never saw doesn't lose", async () => {
		const tagged = edit(base, { tags: ["a", "b"] }, at(15, "a"));
		const x = edit(tagged, { tags: ["b"] }, at(20, "a"));
		const y = edit(tagged, { tags: ["a", "b", "c"] }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))?.tags).toEqual(["b", "c"]);
	});

	it("a re-added item survives a concurrent removal", async () => {
		const tagged = edit(base, { tags: ["a"] }, at(15, "a"));
		const x = edit(tagged, { tags: undefined }, at(20, "a"));
		const removed = edit(tagged, { tags: undefined }, at(25, "b"));
		const y = edit(removed, { tags: ["a"] }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))?.tags).toEqual(["a"]);
	});

	it("both edit custom fields: no combine", async () => {
		const x = edit(base, { customFields: [{ key: "PIN", value: "1" }] }, at(20, "a"));
		const y = edit(base, { customFields: [{ key: "PIN", value: "2" }] }, at(30, "b"));
		expect(await combineSiblings([x, y])).toBeNull();
	});

	// The builder-check scenario: an older build's notes edit, stamped later, can't count as having
	// seen a passkey a newer build added.
	it("an older build's edit can't drop a passkey a newer build added", async () => {
		const old = legacy(login({ notes: "n0" }), at(5, "o0"));
		const withKey = edit(old, { passkeys: [{ credentialId: "k1" }] }, at(10, "a"));
		const newer = edit(withKey, { tags: ["t"] }, at(30, "a"));
		const olderEdit = legacy(login({ notes: "older" }), at(20, "o1"));
		const c = await combineSiblings([newer, olderEdit]);
		expect(as(c)).toMatchObject({
			notes: "older",
			tags: ["t"],
			passkeys: [{ credentialId: "k1" }],
		});
	});

	it("an older build's edit against a newer build's password change: no combine", async () => {
		const old = legacy(login({ notes: "n0" }), at(5, "o0"));
		const newer = edit(old, { password: "new" }, at(10, "a"));
		const olderEdit = legacy(login({ notes: "older" }), at(20, "o1"));
		expect(await combineSiblings([newer, olderEdit])).toBeNull();
	});

	it("card, SSH key and note entries combine by their own parts", async () => {
		const card = created(
			{
				type: "card",
				name: "Visa",
				cardholderName: "A",
				number: "4111",
				expMonth: "01",
				expYear: "30",
				cvv: "123",
			},
			at(10, "a"),
		);
		expect(
			as(
				await combineSiblings([
					edit(card, { number: "5555" }, at(20, "a")),
					edit(card, { name: "Mine" }, at(30, "b")),
				]),
			),
		).toMatchObject({ number: "5555", name: "Mine", cvv: "123" });
		const key = created(
			{ type: "ssh-key", name: "k", publicKey: "pub", privateKey: "priv" },
			at(10, "a"),
		);
		expect(
			as(
				await combineSiblings([
					edit(key, { passphrase: "pp" }, at(20, "a")),
					edit(key, { notes: "n" }, at(30, "b")),
				]),
			),
		).toMatchObject({ passphrase: "pp", notes: "n" });
		const note = created({ type: "note", name: "N", notes: "x" }, at(10, "a"));
		expect(
			as(
				await combineSiblings([
					edit(note, { notes: "y" }, at(20, "a")),
					edit(note, { name: "M" }, at(30, "b")),
				]),
			),
		).toMatchObject({ notes: "y", name: "M" });
	});

	it("different types: no combine", async () => {
		const x = edit(base, { notes: "x" }, at(20, "a"));
		const y = edit(base, { type: "note" }, at(30, "b"));
		expect(await combineSiblings([x, y])).toBeNull();
	});

	it("three siblings, two combinable: two fold, the third is left out", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const z = edit(base, { password: "pz" }, at(40, "c"));
		const c = await combineSiblings([x, y, z]);
		expect(c!.replaces).toEqual([z.envelope, y.envelope]);
		expect(as(c)).toMatchObject({ password: "pz", notes: "ny" });
	});

	it("the combined stamp is deterministic and sorts after every input", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const one = await combineSiblings([x, y]);
		const two = await combineSiblings([y, x]);
		expect(two).toEqual(one);
		expect(one!.hlc).toMatchObject({ wall: 30, counter: 1 });
		expect(one!.hlc.node.startsWith("~merge:")).toBe(true);
		const version = { hlc: one!.hlc, ...one!.causal };
		expect(isAncestor(x.envelope, version)).toBe(true);
		expect(isAncestor(y.envelope, version)).toBe(true);
	});

	it("a higher rules version's result descends from a lower one's", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const v1 = (await combineSiblings([x, y], 1))!;
		const v2 = (await combineSiblings([x, y], 2))!;
		expect(isAncestor({ hlc: v1.hlc, ...v1.causal }, { hlc: v2.hlc, ...v2.causal })).toBe(true);
	});

	it("password history keeps every superseded password", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const c = await combineSiblings([x, y]);
		expect(as(c)?.passwordChangelog).toEqual([{ value: "p", changedAt: 30 }]);
	});

	it("a stripped copy of a combined version is still an ancestor of its descendants", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const c = (await combineSiblings([x, y]))!;
		const combined: Sibling = {
			envelope: envelope("e", { hlc: c.hlc, ...c.causal }),
			data: c.data,
		};
		const later = edit(combined, { name: "later" }, at(40, "d"));
		expect(isAncestor({ hlc: c.hlc }, later.envelope)).toBe(true);
	});
});

describe("combinePayload", () => {
	const base = created(login({ notes: "n0" }), at(10, "a"));
	/** Ciphertext is the plaintext, so sealing and opening are visible. */
	const sealed = (sib: Sibling): EncryptedEntry => ({
		...sib.envelope,
		ciphertext: `ct:${JSON.stringify(sib.data)}`,
	});
	const crypto = (): CombineCrypto & { opened: number } => {
		const c = {
			opened: 0,
			decryptEntries: async (ps: { ciphertext: string }[]) => {
				c.opened += ps.length;
				return ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null));
			},
			encryptEntry: async (json: string) => ({
				ciphertext: `ct:${json}`,
				iv: "i",
				wrappedDek: "w",
				dekIv: "d",
			}),
		};
		return c;
	};

	it("a payload with no siblings is returned as is without decrypting", async () => {
		const c = crypto();
		const payload = { entries: [sealed(base)], tombstones: [] };
		const out = await combinePayload(payload, c);
		expect(out.payload).toBe(payload);
		expect(out.stamps).toEqual([]);
		expect(c.opened).toBe(0);
	});

	it("combinePayload leaves ids outside `only` unopened", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const c = crypto();
		const payload = { entries: [sealed(y)], tombstones: [], conflicts: [sealed(x)] };
		const out = await combinePayload(payload, c, new Set(["other"]));
		expect(out.payload).toBe(payload);
		expect(c.opened).toBe(0);
	});

	it("combinePayload replaces combinable siblings with one sealed version", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const out = await combinePayload(
			{ entries: [sealed(y)], tombstones: [], conflicts: [sealed(x)] },
			crypto(),
		);
		expect(out.payload.conflicts).toBeUndefined();
		expect(out.payload.entries).toHaveLength(1);
		const [only] = out.payload.entries;
		expect(only!.hlc.node.startsWith("~merge:")).toBe(true);
		expect(JSON.parse(only!.ciphertext.slice(3))).toMatchObject({ password: "px", notes: "ny" });
		expect(out.stamps).toEqual([only!.hlc]);
	});
});
