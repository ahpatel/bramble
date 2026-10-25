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
import { mergeEntriesPayload } from "./vault-merge";

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

/** A Phase A build's edit: it keeps a history but copies the part-stamp fields verbatim (stale). */
function phaseAEdit(prev: Sibling, changes: Record<string, unknown>, stamp: Hlc): Sibling {
	const causal = nextCausal({ hlc: stamp, bases: [prev.envelope], held: [prev.envelope] });
	const data = { ...prev.data, ...changes } as Record<string, unknown>;
	for (const [k, v] of Object.entries(changes)) if (v === undefined) delete data[k];
	return { envelope: envelope("e", { hlc: stamp, ...causal }), data: data as unknown as EntryData };
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

/** A "keep" resolution of `kept` over `dropped`, the way EntryMutations.resolve writes one. */
function resolveKeep(kept: Sibling, dropped: Sibling[], stamp: Hlc): Sibling {
	const bases = [kept.envelope, ...dropped.map((d) => d.envelope)];
	const causal = nextCausal({ hlc: stamp, bases, held: bases });
	const data = withPartStamps(
		{ ...kept.data, id: "e" } as Entry,
		{ data: kept.data, version: kept.envelope },
		stamp,
		dropped.map((d) => d.data),
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

	// The user kept one version over another; an edit of the dropped one that never saw the
	// resolution must not bring the dropped value back.
	it("a resolution's choice survives a combine with an edit of the version it dropped", async () => {
		const dropped = edit(base, { notes: "nx" }, at(20, "a"));
		const kept = edit(base, { password: "py" }, at(30, "b"));
		const resolved = resolveKeep(kept, [dropped], at(40, "b"));
		const later = edit(dropped, { name: "nz" }, at(50, "a"));
		expect(as(await combineSiblings([resolved, later]))).toMatchObject({
			notes: "n0",
			password: "py",
			name: "nz",
		});
	});

	it("a tag a resolution kept survives a combine with an edit of the version that removed it", async () => {
		const tagged = edit(base, { tags: ["a"] }, at(15, "a"));
		const dropped = edit(tagged, { tags: undefined }, at(20, "a"));
		const kept = edit(tagged, { password: "py" }, at(30, "b"));
		const resolved = resolveKeep(kept, [dropped], at(40, "b"));
		const later = edit(dropped, { name: "nz" }, at(50, "a"));
		expect(as(await combineSiblings([resolved, later]))?.tags).toEqual(["a"]);
	});

	// Each side's stamp for the part is in the other's history, yet the values differ: only a write
	// that kept a value without restamping it gets here, and the higher stamp isn't the answer.
	it("both sides saw each other's change to a part yet differ: no combine", async () => {
		const named = created(login({ name: "n1" }), at(10, "laptop"));
		const renamed = edit(named, { name: "n3" }, at(20, "laptop"));
		const later = edit(renamed, { notes: "tab" }, at(30, "tablet"));
		const renamedAgain = edit(renamed, { name: "n6" }, at(40, "laptop"));
		const tomb = {
			hlc: at(50, "laptop"),
			...nextCausal({
				hlc: at(50, "laptop"),
				bases: [renamedAgain.envelope],
				held: [renamedAgain.envelope],
			}),
		};
		const phone = edit(named, { password: "p9" }, at(45, "phone"));
		// Kept over the delete without restamping what it kept.
		const kHlc = at(60, "laptop");
		const kept: Sibling = {
			envelope: envelope("e", {
				hlc: kHlc,
				...nextCausal({ hlc: kHlc, bases: [phone.envelope, tomb], held: [phone.envelope, tomb] }),
			}),
			data: withPartStamps(
				{ ...phone.data, id: "e" } as Entry,
				{ data: phone.data, version: phone.envelope },
				kHlc,
			),
		};
		expect(await combineSiblings([kept, later])).toBeNull();
	});

	it("a value an older build cleared stays cleared under a newer build's edit", async () => {
		const withNotes = created(login({ notes: "recovery codes" }), at(10, "laptop"));
		const cleared = phaseAEdit(withNotes, { notes: undefined }, at(20, "tablet"));
		const renamed = edit(cleared, { name: "renamed" }, at(30, "laptop"));
		const other = edit(withNotes, { urls: ["https://example.com"] }, at(25, "phone"));
		const c = await combineSiblings([renamed, other]);
		expect(as(c)?.notes).toBeUndefined();
		expect(as(c)).toMatchObject({ name: "renamed", urls: ["https://example.com"] });
	});

	// An older build's item can't be told apart from one the other side removed: it carries no
	// stamp of its own.
	it("an older build's version holding an item the other side lacks: no combine", async () => {
		const both = created(
			login({ urls: ["https://old.example", "https://new.example"] }),
			at(10, "a"),
		);
		const removed = edit(both, { urls: ["https://new.example"] }, at(20, "a"));
		const older = phaseAEdit(both, { name: "renamed" }, at(30, "b"));
		expect(await combineSiblings([removed, older])).toBeNull();
		const keys = created(
			login({ passkeys: [{ credentialId: "K1" }, { credentialId: "K2" }] }),
			at(10, "a"),
		);
		const dropped = edit(keys, { passkeys: [{ credentialId: "K2" }] }, at(20, "a"));
		const olderNotes = phaseAEdit(keys, { notes: "nB" }, at(30, "b"));
		expect(await combineSiblings([dropped, olderNotes])).toBeNull();
	});

	// An older build's copy claims every item as added at its own stamp; a combine must not pass
	// that claim on as the real add, or a removal that saw the real add no longer applies.
	it("an older build's claim on an item doesn't outlive the combine", async () => {
		const tagged = created(login({ tags: ["t0"] }), at(10, "a"));
		const older = phaseAEdit(tagged, { notes: "older" }, at(40, "tablet"));
		const withUrl = edit(tagged, { urls: ["https://x.example"] }, at(20, "b"));
		const removed = edit(tagged, { tags: undefined }, at(30, "c"));
		const c = (await combineSiblings([older, withUrl]))!;
		expect(as(c)).toMatchObject({ notes: "older", tags: ["t0"], urls: ["https://x.example"] });
		const combined: Sibling = {
			envelope: envelope("e", { hlc: c.hlc, ...c.causal }),
			data: c.data,
		};
		expect(as(await combineSiblings([combined, removed]))?.tags).toBeUndefined();
	});

	it("two versions an older build wrote don't combine, even when they agree", async () => {
		const both = created(login({ notes: "n0", tags: ["t0"] }), at(10, "a"));
		const x = phaseAEdit(both, { notes: "same" }, at(20, "tablet"));
		const y = phaseAEdit(both, { notes: "same" }, at(30, "tablet2"));
		expect(await combineSiblings([x, y])).toBeNull();
	});

	// An old relay strips a version's history; its part stamps are still a newer build's, so an
	// older build's last-writer-wins floor on the other side can't count as having seen them.
	it("a copy stripped of its history keeps its stamps' seen restriction", async () => {
		const bNotes = edit(base, { notes: "nb" }, at(15, "b"));
		const x = edit(bNotes, { name: "na" }, at(20, "a"));
		const stripped: Sibling = { envelope: envelope("e", { hlc: x.envelope.hlc }), data: x.data };
		const older = legacy(login({ notes: "n0" }), at(17, "o"));
		const v = edit(older, { notes: "nv" }, at(25, "n"));
		expect(await combineSiblings([stripped, v])).toBeNull();
	});

	it("a combined login with no URLs keeps its urls list", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))?.urls).toEqual([]);
	});

	// A field named like a group (a future field called `credential`) is a part of its own.
	it("a field named like a group doesn't take the group's place", async () => {
		const withField = created(login({ credential: "f0" }), at(10, "a"));
		const x = edit(withField, { credential: "f1" }, at(20, "a"));
		const y = edit(withField, { password: "py" }, at(30, "b"));
		expect(as(await combineSiblings([x, y]))).toMatchObject({ credential: "f1", password: "py" });
	});

	it("two items under one key: no combine", async () => {
		const dup = created(login({ urls: ["https://x.example", "https://x.example"] }), at(10, "a"));
		const x = edit(dup, { notes: "nx" }, at(20, "a"));
		const y = edit(dup, { name: "ny" }, at(30, "b"));
		expect(await combineSiblings([x, y])).toBeNull();
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
		// Dated when px replaced it (x's change at 20), not when the versions were combined.
		expect(as(c)?.passwordChangelog).toEqual([{ value: "p", changedAt: 20 }]);
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

	it("one entry that can't be combined doesn't stop the others", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const broken = (sib: Sibling): EncryptedEntry => ({
			...sib.envelope,
			id: "f",
			ciphertext: `ct:${JSON.stringify({ ...sib.data, tags: [5] })}`,
		});
		const out = await combinePayload(
			{
				entries: [sealed(y), broken(y)],
				tombstones: [],
				conflicts: [sealed(x), broken(x)],
			},
			crypto(),
		);
		expect(out.stamps).toHaveLength(1);
		expect(out.payload.conflicts?.map((e) => e.id)).toEqual(["f"]);
	});

	// Sealing under a key that has since changed (mobile's one global key) must not replace
	// readable versions with an unreadable one.
	it("a combined version that doesn't open again isn't written", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const payload = { entries: [sealed(y)], tombstones: [], conflicts: [sealed(x)] };
		const c = crypto();
		c.encryptEntry = async (json: string) => ({
			ciphertext: `other-key:${json}`,
			iv: "i",
			wrappedDek: "w",
			dekIv: "d",
		});
		const out = await combinePayload(payload, c);
		expect(out.payload).toBe(payload);
		expect(out.stamps).toEqual([]);
	});

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

	// A combined version is a pure function of its inputs: whoever saw them all has seen it.
	it("a delete that saw every input of a combined version deletes it", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const both = mergeEntriesPayload(
			{ entries: [sealed(x)], tombstones: [] },
			{ entries: [sealed(y)], tombstones: [] },
		);
		const combined = await combinePayload(both, crypto());
		expect(combined.stamps).toHaveLength(1);
		const tHlc = at(40, "z");
		const inputs = [x.envelope, y.envelope];
		const tomb = { id: "e", hlc: tHlc, ...nextCausal({ hlc: tHlc, bases: inputs, held: inputs }) };
		const merged = mergeEntriesPayload(combined.payload, { entries: [], tombstones: [tomb] });
		expect(merged.entries).toEqual([]);
		expect(merged.conflicts).toBeUndefined();
	});

	it("a version that saw only some inputs doesn't supersede the combined one", async () => {
		const x = edit(base, { password: "px" }, at(20, "a"));
		const y = edit(base, { notes: "ny" }, at(30, "b"));
		const c = (await combineSiblings([x, y]))!;
		const combined = { hlc: c.hlc, ...c.causal };
		const sawX = edit(x, { name: "later" }, at(40, "a"));
		expect(isAncestor(combined, sawX.envelope)).toBe(false);
		const r = at(50, "z");
		const sawBoth = {
			hlc: r,
			...nextCausal({ hlc: r, bases: [x.envelope, y.envelope], held: [] }),
		};
		expect(isAncestor(combined, sawBoth)).toBe(true);
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
