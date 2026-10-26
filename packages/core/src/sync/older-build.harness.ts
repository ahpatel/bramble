// Test-only: a faithful build from before docs/sync-conflicts.md Phase A. It strips the fields it
// doesn't know on read and merges last-writer-wins per entry, exactly as those builds do.

import type { EncryptedEntry } from "../vault-format";
import type { EntriesPayload, SyncedSettings } from "./entries-payload";
import { compareHlc } from "./hlc";
import { liveRecords, mergeReplicas, type ReplicaState, replicaFrom } from "./merge";

/** What an older build keeps of a payload after parsing it. */
export function stripForOlderBuild(p: EntriesPayload): EntriesPayload {
	const entries = p.entries.map(({ id, wrappedDek, dekIv, ciphertext, iv, hlc }) => ({
		id,
		wrappedDek,
		dekIv,
		ciphertext,
		iv,
		hlc,
	}));
	const tombstones = p.tombstones.map(({ id, hlc }) => ({ id, hlc }));
	return p.settings ? { entries, tombstones, settings: p.settings } : { entries, tombstones };
}

function toReplica(p: EntriesPayload): ReplicaState<EncryptedEntry> {
	return replicaFrom(
		p.entries,
		p.tombstones.map((t) => [t.id, t.hlc] as const),
	);
}

function mergeSettings(
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

/** An older build's merge: both sides stripped, then last-writer-wins per entry. */
export function olderBuildMerge(a: EntriesPayload, b: EntriesPayload): EntriesPayload {
	const sa = stripForOlderBuild(a);
	const sb = stripForOlderBuild(b);
	const merged = mergeReplicas(toReplica(sa), toReplica(sb));
	const out: EntriesPayload = {
		entries: liveRecords(merged),
		tombstones: [...merged.tombstones].map(([id, hlc]) => ({ id, hlc })),
	};
	const settings = mergeSettings(sa.settings, sb.settings);
	return settings ? { ...out, settings } : out;
}
