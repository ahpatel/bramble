// The structure inside `entriesCiphertext` (decrypted under the VEK). See
// docs/p2p-sync.md. Replaces the bare `EncryptedEntry[]` with a wrapper that
// also carries deletion tombstones, so deletes survive a merge instead of being
// silently re-added by a stale peer. Lives in the encrypted payload, so the
// VLT1 binary container in vault-format.ts is unchanged.

import { z } from "zod";
import { EncryptedEntrySchema } from "../vault-format";
import { HlcSchema, isFutureStamp } from "./hlc";

/** A deletion record: the deleted id and the stamp at which it was deleted. */
export const TombstoneSchema = z.object({
	id: z.string(),
	hlc: HlcSchema,
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

/**
 * One synced setting: a stamped value, keyed by the pref's own meta key.
 *
 * `value: null` means the user explicitly cleared it. That is deliberately NOT the same as the
 * key being absent, because absence is what a client predating this map produces when it strips
 * and rewrites the payload. Absent means "no opinion"; null means "turned off". See
 * docs/synced-settings.md.
 */
export const SyncedSettingSchema = z.object({
	hlc: HlcSchema,
	value: z.unknown(),
});

/** Settings that belong to the vault rather than the device, merged like any replicated state. */
export const SyncedSettingsSchema = z.record(z.string(), SyncedSettingSchema);
export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>;

/** A sealed conflict loser (ADR-0006): when two devices edit the same entry, the
 * losing envelope is kept here verbatim — never decrypted during the merge — so
 * the UI can surface "this entry changed on two devices" and the user can
 * recover the other copy. Optional so payloads written before it existed parse. */
export const ConflictRecordSchema = z.object({
	entryId: z.string(),
	/** The loser's sealed envelope, carried as bytes. */
	envelope: EncryptedEntrySchema,
	/** The stamp of the winning version at the time the conflict was recorded,
	 * so the UI can tell which side the user is looking at. */
	winnerHlc: HlcSchema,
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

/** The decrypted entries payload: live entries, the deletion graveyard, any vault-scoped
 * settings, and any sealed conflict losers. `settings` and `conflicts` are optional so
 * payloads written before they existed still parse. */
export const EntriesPayloadSchema = z.object({
	entries: z.array(EncryptedEntrySchema),
	tombstones: z.array(TombstoneSchema),
	settings: SyncedSettingsSchema.optional(),
	conflicts: z.array(ConflictRecordSchema).optional(),
});
export type EntriesPayload = z.infer<typeof EntriesPayloadSchema>;

/** An empty payload, for a fresh vault. */
export function emptyEntriesPayload(): EntriesPayload {
	return { entries: [], tombstones: [] };
}

/** Serialize a payload to the JSON that gets encrypted under the VEK. */
export function encodeEntriesPayload(payload: EntriesPayload): string {
	return JSON.stringify(EntriesPayloadSchema.parse(payload));
}

/** Parse and validate a decrypted payload. Throws on the legacy bare-array shape. */
export function decodeEntriesPayload(json: string): EntriesPayload {
	return EntriesPayloadSchema.parse(JSON.parse(json));
}

/** Drop entries and tombstones stamped implausibly far in the future before merging a
 * REMOTELY-received payload, so a member can't pin an un-deletable entry by stamping it years
 * ahead (mirrors the roster guard). Honest payloads carry near-present stamps. */
export function sanitizeRemoteEntriesPayload(
	payload: EntriesPayload,
	now: number = Date.now(),
): EntriesPayload {
	const settings = payload.settings
		? Object.fromEntries(
				Object.entries(payload.settings).filter(([, rec]) => !isFutureStamp(rec.hlc, now)),
			)
		: undefined;
	return {
		entries: payload.entries.filter((e) => !isFutureStamp(e.hlc, now)),
		tombstones: payload.tombstones.filter((t) => !isFutureStamp(t.hlc, now)),
		...(settings ? { settings } : {}),
	};
}
