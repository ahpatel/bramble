// Conflict collection tests (ADR-0006): sealed losers kept, never decrypted,
// deduped across repeated merges, and dropped once resolved by a newer edit.

import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import { dedupeConflicts, mergeWithConflicts, resolveConflict } from "./conflicts";
import type { EntriesPayload } from "./entries-payload";
import { HlcSchema } from "./hlc";

const hlc = (wall: number, counter: number, node: string) =>
	HlcSchema.parse({ wall, counter, node });

function envelope(id: string, wall: number, counter: number, node: string): EncryptedEntry {
	return {
		id,
		ciphertext: `ct-${node}`,
		iv: `iv-${node}`,
		wrappedDek: `wd-${node}`,
		dekIv: `di-${node}`,
		hlc: hlc(wall, counter, node),
	};
}

function payload(entries: EncryptedEntry[]): EntriesPayload {
	return { entries, tombstones: [] };
}

describe("mergeWithConflicts", () => {
	it("keeps the losing sealed envelope when two devices wrote the same entry", () => {
		const a = payload([envelope("e1", 100, 1, "device-a")]);
		const b = payload([envelope("e1", 100, 2, "device-b")]);
		const merged = mergeWithConflicts(a, b);
		// The winner is the max stamp, as the plain merge would pick.
		expect(merged.entries[0]!.hlc).toEqual(hlc(100, 2, "device-b"));
		// The loser is kept, sealed.
		expect(merged.conflicts).toHaveLength(1);
		const conflict = merged.conflicts![0]!;
		expect(conflict.entryId).toBe("e1");
		expect(conflict.envelope.hlc).toEqual(hlc(100, 1, "device-a"));
		expect(conflict.envelope.ciphertext).toBe("ct-device-a");
		expect(conflict.winnerHlc).toEqual(hlc(100, 2, "device-b"));
	});

	it("records no conflict when both sides hold the same version", () => {
		const same = payload([envelope("e1", 100, 1, "device-a")]);
		const merged = mergeWithConflicts(same, same);
		expect(merged.conflicts ?? []).toHaveLength(0);
	});

	it("keeps conflicts from both sides and dedupes repeated merges", () => {
		const a = payload([envelope("e1", 100, 1, "device-a")]);
		const b = payload([envelope("e1", 100, 2, "device-b")]);
		const first = mergeWithConflicts(a, b);
		// Merging the result with the same inputs again (pairwise gossip repeats)
		// must not pile up duplicate records.
		const second = mergeWithConflicts(first, b);
		expect(second.conflicts).toHaveLength(1);
	});
});

describe("dedupeConflicts", () => {
	it("drops a loser that a newer live edit has already superseded", () => {
		const p: EntriesPayload = {
			entries: [envelope("e1", 300, 1, "device-a")], // user edited past the conflict
			tombstones: [],
			conflicts: [
				{
					entryId: "e1",
					envelope: envelope("e1", 100, 2, "device-b"),
					winnerHlc: hlc(100, 2, "device-b"),
				},
			],
		};
		const deduped = dedupeConflicts(p);
		expect(deduped.conflicts ?? []).toHaveLength(0);
	});
});

describe("resolveConflict", () => {
	it("drops the conflict records for the resolved entry only", () => {
		const p: EntriesPayload = {
			entries: [envelope("e1", 100, 2, "device-b"), envelope("e2", 100, 1, "device-a")],
			tombstones: [],
			conflicts: [
				{
					entryId: "e1",
					envelope: envelope("e1", 100, 1, "device-a"),
					winnerHlc: hlc(100, 2, "device-b"),
				},
				{
					entryId: "e2",
					envelope: envelope("e2", 100, 2, "device-b"),
					winnerHlc: hlc(100, 2, "device-b"),
				},
			],
		};
		const resolved = resolveConflict(p, "e1", "winner");
		expect(resolved.conflicts).toHaveLength(1);
		expect(resolved.conflicts![0]!.entryId).toBe("e2");
		// Entries untouched: the caller re-stamps via the normal edit path.
		expect(resolved.entries).toHaveLength(2);
	});

	it("is a no-op for an entry with no conflict", () => {
		const p = payload([envelope("e1", 100, 1, "device-a")]);
		expect(resolveConflict(p, "e1", "winner")).toEqual(p);
	});
});
