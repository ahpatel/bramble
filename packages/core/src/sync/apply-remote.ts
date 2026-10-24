// The seam a transport calls when a peer's entries arrive: merge them into the
// local vault and persist, skipping the write when nothing changed. The host
// supplies decrypt/encrypt/persist via VaultSyncPort, so this stays free of
// platform APIs and crypto. See docs/p2p-sync.md.

import type { CryptoAdapter } from "../adapters/crypto";
import type { EntriesBlobStore } from "../vault/entries-blob";
import type { EncryptedEntry } from "../vault-format";
import { causalKey, type Versioned } from "./causal";
import { type EntriesPayload, sanitizeRemoteEntriesPayload } from "./entries-payload";
import { entryVersionKey } from "./entry-version";
import { compareHlc, type Hlc } from "./hlc";
import { mergeEntriesPayload } from "./vault-merge";

/** Host hooks for reading and writing the local entries payload. */
export interface VaultSyncPort {
	/** The local payload (empty for a fresh vault). Always called before writeMerged. */
	readLocal(): Promise<EntriesPayload>;
	/** Advance the local clock past these remote stamps, so future local writes sort
	 * after everything the peer has already seen. Called before writeMerged. */
	witnessRemote(stamps: Hlc[]): Promise<void>;
	/** Persist the merged payload: re-encrypt the outer blob and write it. The
	 * sealed per-entry envelopes are carried verbatim, never re-encrypted. */
	writeMerged(merged: EntriesPayload): Promise<void>;
	/** Whether each entry decrypts under this vault's key; only the verdict leaves the crypto host. */
	openable(entries: EncryptedEntry[]): Promise<boolean[]>;
}

/** Every stamp the remote carries (winners, losers, siblings and histories), for clock witnessing. */
function remoteStamps(remote: EntriesPayload): Hlc[] {
	return [...remote.entries, ...(remote.conflicts ?? []), ...remote.tombstones].flatMap((v) => [
		v.hlc,
		...(v.floor ? [v.floor] : []),
		...Object.values(v.vv ?? {}),
	]);
}

export interface ApplyResult {
	payload: EntriesPayload;
	/** Whether the merge actually changed local state (false = remote was redundant). */
	changed: boolean;
}

function stampMapsEqual(a: Map<string, Hlc>, b: Map<string, Hlc>): boolean {
	if (a.size !== b.size) return false;
	for (const [id, hlc] of a) {
		const other = b.get(id);
		if (!other || compareHlc(hlc, other) !== 0) return false;
	}
	return true;
}

/** Settings as an id->stamp map, so the same comparison covers them. */
function settingsStamps(settings: EntriesPayload["settings"]): Map<string, Hlc> {
	return new Map(Object.entries(settings ?? {}).map(([key, rec]) => [key, rec.hlc]));
}

/** Each version as id + stamp + causal history, so a stripped copy differs from its source. */
function versionKeys(items: readonly ({ id: string } & Versioned)[] | undefined): Set<string> {
	return new Set((items ?? []).map((v) => `${v.id}|${causalKey(v)}`));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every((k) => b.has(k));
}

/**
 * True if both payloads hold the same entries, conflicts and tombstones (by id, stamp and causal
 * history) and the same settings.
 *
 * Settings are part of this or they never propagate: the caller writes and re-broadcasts only
 * when a merge changed something, so a settings-only change judged equivalent would be dropped
 * on the floor and appear to sync only when it rode along with an entry edit. The same goes for
 * conflicts and for history gained under an unchanged stamp.
 */
export function payloadsEquivalent(a: EntriesPayload, b: EntriesPayload): boolean {
	return (
		setsEqual(versionKeys(a.entries), versionKeys(b.entries)) &&
		setsEqual(versionKeys(a.conflicts), versionKeys(b.conflicts)) &&
		setsEqual(versionKeys(a.tombstones), versionKeys(b.tombstones)) &&
		stampMapsEqual(settingsStamps(a.settings), settingsStamps(b.settings))
	);
}

/** Remote versions with one refused version key dropped. */
function withoutRejected(remote: EntriesPayload, rejected: Set<string>): EntriesPayload {
	const keep = (e: EncryptedEntry) => !rejected.has(entryVersionKey(e));
	const out: EntriesPayload = { ...remote, entries: remote.entries.filter(keep) };
	if (remote.conflicts) out.conflicts = remote.conflicts.filter(keep);
	return out;
}

/**
 * Merge, checking every version that would newly land here decrypts under this vault's key, so a
 * peer can't plant another vault's entries. Checks what lands rather than what arrives: a stale
 * version the merge prunes costs nothing. A refusal can change what survives, so it re-merges.
 */
async function admitAndMerge(
	port: VaultSyncPort,
	local: EntriesPayload,
	remote: EntriesPayload,
	rejected: Set<string>,
): Promise<{ admitted: EntriesPayload; merged: EntriesPayload }> {
	const held = new Set([...local.entries, ...(local.conflicts ?? [])].map(entryVersionKey));
	const opened = new Set<string>();
	let admitted = withoutRejected(remote, rejected);
	for (;;) {
		const merged = mergeEntriesPayload(local, admitted);
		const fresh = [...merged.entries, ...(merged.conflicts ?? [])].filter((e) => {
			const key = entryVersionKey(e);
			return !held.has(key) && !opened.has(key);
		});
		if (fresh.length === 0) return { admitted, merged };
		const verdicts = await port.openable(fresh);
		const refused = fresh.filter((_, i) => !verdicts[i]);
		for (const e of fresh.filter((_, i) => verdicts[i])) opened.add(entryVersionKey(e));
		if (refused.length === 0) return { admitted, merged };
		console.warn(`[sync] refused ${refused.length} entries that don't decrypt in this vault`);
		for (const e of refused) rejected.add(entryVersionKey(e));
		admitted = withoutRejected(admitted, rejected);
	}
}

/**
 * Merge an incoming remote payload into the local vault. Writes (and so triggers
 * a re-broadcast in a mesh) only when the merge changed local state, which keeps
 * gossip from looping forever once peers converge. `rejected` remembers refused entry
 * versions across calls, so a peer's rebroadcast isn't re-checked every few seconds.
 */
export async function applyRemotePayload(
	port: VaultSyncPort,
	remote: EntriesPayload,
	{ rejected = new Set<string>() }: { rejected?: Set<string> } = {},
): Promise<ApplyResult> {
	// A peer's payload is untrusted: drop any future-dated (poisoned) stamps before merge or
	// witness, so a member can't pin an un-deletable entry by stamping it years ahead.
	const safe = sanitizeRemoteEntriesPayload(remote);
	const local = await port.readLocal();
	const { admitted, merged } = await admitAndMerge(port, local, safe, rejected);
	const changed = !payloadsEquivalent(local, merged);
	if (changed) {
		// Only admitted stamps: a refused entry must not advance this device's clock.
		await port.witnessRemote(remoteStamps(admitted));
		await port.writeMerged(merged);
	}
	return { payload: merged, changed };
}

/**
 * Build a VaultSyncPort over the shared EntriesBlobStore, so the on-disk entries
 * format has one writer across local mutations and sync merges. The host supplies
 * clock witnessing and an optional post-write notification (e.g. refresh the UI).
 */
export function createVaultSyncPort(deps: {
	store: EntriesBlobStore;
	crypto: Pick<CryptoAdapter, "decryptEntries">;
	witnessRemote: (stamps: Hlc[]) => Promise<void>;
	onChanged?: () => void | Promise<void>;
}): VaultSyncPort {
	return {
		readLocal: () => deps.store.readEntriesPayload(),
		witnessRemote: deps.witnessRemote,
		async writeMerged(merged) {
			await deps.store.writeEntriesBlob(merged);
			await deps.onChanged?.();
		},
		openable: async (entries) =>
			(
				await deps.crypto.decryptEntries(
					entries.map(({ ciphertext, iv, wrappedDek, dekIv }) => ({
						ciphertext,
						iv,
						wrappedDek,
						dekIv,
					})),
				)
			).map((p) => p != null),
	};
}
