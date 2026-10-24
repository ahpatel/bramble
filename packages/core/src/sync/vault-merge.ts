// Vault-level merge: a multi-value register per entry over sealed envelopes. Each version carries
// its causal history (sync/causal.ts), so concurrent versions are kept as siblings instead of one
// being dropped. Only stamps and histories are compared, never decrypted content; because every
// device in a group shares one VEK, a kept envelope from any device decrypts locally. See
// docs/sync-conflicts.md, Phase A.

import type { EncryptedEntry } from "../vault-format";
import {
	containsHistory,
	inHistory,
	isAncestor,
	joinCausal,
	type Versioned,
	writerOf,
} from "./causal";
import type { EntriesPayload, SyncedSettings, Tombstone } from "./entries-payload";
import { compareHlc } from "./hlc";

/** What a payload says about one entry beyond its displayed version. */
export interface EntryConflict {
	/** Live versions held that aren't the displayed one. */
	versions: number;
	/** Deleted on another device concurrently with an edit that is still shown. */
	deleted: boolean;
}

/** Same-stamp copies are one version: keep the one that has a history, else the first seen. */
function collapse(versions: readonly EncryptedEntry[]): EncryptedEntry[] {
	const byStamp = new Map<string, EncryptedEntry>();
	for (const v of versions) {
		const key = `${v.hlc.wall}:${v.hlc.counter}:${v.hlc.node}`;
		const cur = byStamp.get(key);
		if (!cur || (!cur.vv && v.vv)) byStamp.set(key, v);
	}
	return [...byStamp.values()];
}

/** One tombstone per id: the union of every delete's history. */
function mergeTombstones(
	x: Tombstone | undefined,
	y: Tombstone | undefined,
): Tombstone | undefined {
	if (!x) return y;
	if (!y) return x;
	// A legacy tombstone at the other's stamp, or already inside it, is a stripped copy of a known
	// delete; its LWW claim would kill every delete-conflicted edit stamped below it. Two with
	// histories always join, even at one stamp: a joined tombstone carries its newest delete's.
	if (compareHlc(x.hlc, y.hlc) === 0 && !(x.vv && y.vv)) return x.vv ? x : y;
	if (!x.vv && inHistory(writerOf(x), x.hlc, y)) return y;
	if (!y.vv && inHistory(writerOf(y), y.hlc, x)) return x;
	const hlc = compareHlc(x.hlc, y.hlc) >= 0 ? x.hlc : y.hlc;
	const { vv, floor } = joinCausal([x, y]);
	if (Object.keys(vv).length === 0 && floor && compareHlc(floor, hlc) === 0)
		return { id: x.id, hlc };
	return floor ? { id: x.id, hlc, vv, floor } : { id: x.id, hlc, vv };
}

/** The surviving live versions of one entry, highest stamp first. */
function survivors(live: readonly EncryptedEntry[], tomb: Tombstone | undefined): EncryptedEntry[] {
	const kept: EncryptedEntry[] = [];
	// Top-down, so a stale copy pruned under a newer version never gets to prune anything itself.
	for (const v of [...collapse(live)].sort((p, q) => compareHlc(q.hlc, p.hlc))) {
		if (tomb && isAncestor(v, tomb)) continue;
		if (kept.some((k) => isAncestor(v, k))) continue;
		kept.push(v);
	}
	return kept;
}

/**
 * Merge two entries payloads into one. Commutative, associative, and idempotent over histories
 * built by the rules in docs/sync-conflicts.md, so pairwise gossip across devices converges.
 * Per entry: the highest-stamp surviving version is displayed (`entries`), the other survivors
 * are kept sealed in `conflicts`, and deletes join into one tombstone kept forever. Envelopes are
 * carried verbatim.
 */
export function mergeEntriesPayload(a: EntriesPayload, b: EntriesPayload): EntriesPayload {
	const order: string[] = [];
	const live = new Map<string, EncryptedEntry[]>();
	const note = (e: EncryptedEntry) => {
		const list = live.get(e.id);
		if (list) list.push(e);
		else {
			live.set(e.id, [e]);
			order.push(e.id);
		}
	};
	// Ids keep their first-seen order, displayed entries before siblings, as the LWW merge did.
	for (const e of a.entries) note(e);
	for (const e of b.entries) note(e);
	for (const e of a.conflicts ?? []) note(e);
	for (const e of b.conflicts ?? []) note(e);

	const tombs = new Map<string, Tombstone>();
	for (const t of [...a.tombstones, ...b.tombstones]) {
		const merged = mergeTombstones(tombs.get(t.id), t);
		if (merged) tombs.set(t.id, merged);
	}

	const entries: EncryptedEntry[] = [];
	const conflicts: EncryptedEntry[] = [];
	for (const id of order) {
		const [shown, ...rest] = survivors(live.get(id) ?? [], tombs.get(id));
		if (shown) entries.push(shown);
		conflicts.push(...rest);
	}
	const out: EntriesPayload = { entries, tombstones: [...tombs.values()] };
	if (conflicts.length > 0) out.conflicts = conflicts;
	const settings = mergeSyncedSettings(a.settings, b.settings);
	return settings ? { ...out, settings } : out;
}

/** The displayed version, its siblings and its tombstone, for building a write's history. */
export function heldVersions(payload: EntriesPayload, id: string): Versioned[] {
	return [
		...payload.entries.filter((e) => e.id === id),
		...(payload.conflicts ?? []).filter((e) => e.id === id),
		...payload.tombstones.filter((t) => t.id === id),
	];
}

/** Every displayed entry that has siblings or a concurrent delete. */
export function entryConflicts(payload: EntriesPayload): Map<string, EntryConflict> {
	const siblings = new Map<string, EncryptedEntry[]>();
	for (const e of payload.conflicts ?? []) siblings.set(e.id, [...(siblings.get(e.id) ?? []), e]);
	const tombs = new Map(payload.tombstones.map((t) => [t.id, t]));
	const out = new Map<string, EntryConflict>();
	for (const shown of payload.entries) {
		const others = siblings.get(shown.id) ?? [];
		const tomb = tombs.get(shown.id);
		const deleted = !!tomb && ![shown, ...others].some((e) => containsHistory(e, tomb));
		if (others.length > 0 || deleted) out.set(shown.id, { versions: others.length, deleted });
	}
	return out;
}

/**
 * Merge the vault-scoped settings map: per key, the higher stamp wins.
 *
 * Per KEY rather than per map, so two devices that changed two different settings both keep
 * theirs. And a key present on one side only is kept, never treated as a deletion: a client that
 * predates this map strips it and writes the payload back without it, so "the other side said
 * nothing" has to mean exactly that. Clearing is a `value: null` record with its own stamp.
 * See docs/synced-settings.md.
 */
function mergeSyncedSettings(
	a: SyncedSettings | undefined,
	b: SyncedSettings | undefined,
): SyncedSettings | undefined {
	if (!a) return b;
	if (!b) return a;
	const out: SyncedSettings = { ...a };
	for (const [key, rec] of Object.entries(b)) {
		const cur = out[key];
		if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) out[key] = rec;
	}
	return out;
}
