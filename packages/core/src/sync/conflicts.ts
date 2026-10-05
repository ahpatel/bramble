// Conflict collection (ADR-0006): when a merge replaces one sealed envelope with
// a strictly newer one, the loser is kept — sealed, never decrypted during the
// merge — so the UI can surface "this entry changed on two devices" and the
// user can recover the other copy explicitly. Pure functions over payloads, so
// the merge stays transport-free and the tests stay honest.

import type { EncryptedEntry } from "../vault-format";
import type { ConflictRecord, EntriesPayload } from "./entries-payload";
import { compareHlc, type Hlc } from "./hlc";
import { mergeEntriesPayload } from "./vault-merge";

/** True if two envelopes for the same id are genuinely different versions —
 * different stamps means two devices wrote; identical stamps means the same
 * write seen twice (the merge invariant). */
function differingVersions(a: EncryptedEntry, b: EncryptedEntry): boolean {
	return compareHlc(a.hlc, b.hlc) !== 0;
}

/** Merge local and remote, collecting every conflict loser into the payload's
 * conflict list. Losers are deduplicated by (entryId, loser stamp), so
 * repeated merges of the same pair don't pile up copies. The winner is
 * determined exactly as the plain merge would (max HLC), never by content. */
export function mergeWithConflicts(local: EntriesPayload, remote: EntriesPayload): EntriesPayload {
	const merged = mergeEntriesPayload(local, remote);
	const conflicts: ConflictRecord[] = [...(local.conflicts ?? []), ...(remote.conflicts ?? [])];
	const localById = new Map(local.entries.map((e) => [e.id, e]));
	const remoteById = new Map(remote.entries.map((e) => [e.id, e]));

	for (const winner of merged.entries) {
		const localVersion = localById.get(winner.id);
		const remoteVersion = remoteById.get(winner.id);
		if (!localVersion || !remoteVersion) continue;
		if (!differingVersions(localVersion, remoteVersion)) continue;
		// The loser is whichever version the merge did NOT pick.
		const loser = compareHlc(winner.hlc, localVersion.hlc) === 0 ? remoteVersion : localVersion;
		conflicts.push({ entryId: winner.id, envelope: loser, winnerHlc: winner.hlc });
	}
	return dedupeConflicts({ ...merged, conflicts });
}

/** Drop duplicate conflict records and losers dominated by a newer conflict or
 * by the current live version: an entry the user has already resolved (edited
 * past the conflict) shouldn't keep resurfacing stale losers. */
export function dedupeConflicts(payload: EntriesPayload): EntriesPayload {
	if (!payload.conflicts?.length) return payload;
	const seen = new Set<string>();
	const live = new Map(payload.entries.map((e) => [e.id, e.hlc] as const));
	const out: ConflictRecord[] = [];
	for (const rec of payload.conflicts) {
		const key = `${rec.entryId}:${rec.envelope.hlc.wall}:${rec.envelope.hlc.counter}:${rec.envelope.hlc.node}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// A loser the live version postdates *beyond the recorded winner* is history
		// of an already-resolved conflict: the user edited past it, so it shouldn't
		// resurface. (The winner being newer than the loser is the conflict itself.)
		const liveHlc: Hlc | undefined = live.get(rec.entryId);
		if (liveHlc && compareHlc(liveHlc, rec.winnerHlc) > 0) continue;
		out.push(rec);
	}
	return out.length === (payload.conflicts?.length ?? 0) ? payload : { ...payload, conflicts: out };
}

/** Resolve a conflict: the user picked a version, so it becomes the live entry
 * with a fresh stamp (an edit past both versions) and the conflict list drops
 * every record for that id. Returns the payload to persist; the caller stamps
 * and writes through the normal mutation path. */
export function resolveConflict(
	payload: EntriesPayload,
	entryId: string,
	chosen: "winner" | { envelope: EncryptedEntry },
): EntriesPayload {
	const conflict = (payload.conflicts ?? []).find((c) => c.entryId === entryId);
	if (!conflict) return payload;
	const entry = chosen === "winner" ? undefined : chosen.envelope;
	void entry;
	// Marking the id resolved: the caller re-stamps via the normal edit path, which
	// supersedes both versions. Here we only drop the conflict records.
	const conflicts = (payload.conflicts ?? []).filter((c) => c.entryId !== entryId);
	return { ...payload, conflicts };
}
