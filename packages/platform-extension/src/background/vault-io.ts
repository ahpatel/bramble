/// <reference types="chrome" />

import {
	decodeEntriesPayload,
	type EntriesPayload,
	emptyEntriesPayload,
	encodeEntriesPayload,
} from "@core/sync";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import {
	decodeVault,
	decodeVaultBlob,
	type EncryptedEntry,
	encodeVaultBlob,
	type VaultBlob,
	VLT2,
} from "@core/vault-format";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { witnessStamp } from "./sync-clock";

// Re-exported so existing background importers keep their import site.
export { base64ToBytes, bytesToBase64 };

/** Read + decode a vault's outer blob. `vaultId` targets the active vault for sync; omitted falls
 * back to the primary (existing single-vault callers). */
export async function readAndDecodeVault(vaultId?: string): Promise<VaultBlob> {
	return decodeVaultBlob(await extensionStorage.readVaultBlob(vaultId));
}

/** The raw blob bytes, for sharing-aware code that needs a format-tagged decode. */
export async function readVaultBytes(vaultId?: string): Promise<Uint8Array> {
	return extensionStorage.readVaultBlob(vaultId);
}

/** Persist a vault's blob (`vaultId` targets the active vault; omitted = primary). chrome.storage.local
 * is always writable headless, so the write always goes straight through. */
export async function writeVault(blob: Uint8Array, vaultId?: string): Promise<void> {
	await extensionStorage.writeVaultBlob(blob, vaultId);
}

/** Re-write a vault's outer entries blob with new ciphertext, preserving the on-disk
 * format. A sharing-enabled (VLT2) vault keeps its sharing layer (wraps, member
 * secrets, region) — re-encoding as plain VLT1 here silently stripped it and broke
 * member sync. The base fields (slots, sharing) come from the bytes on disk, so a
 * concurrent writer's other changes are carried forward, not reverted. */
export async function writeVaultEntries(
	entriesIv: Uint8Array,
	entriesCiphertext: Uint8Array,
	vaultId?: string,
): Promise<void> {
	const bytes = await readVaultBytes(vaultId);
	const decoded = decodeVault(bytes);
	if (decoded.format === "vlt2") {
		await writeVault(
			VLT2.encode({
				...decoded.blob,
				entriesIv,
				entriesCiphertext,
			}),
			vaultId,
		);
	} else {
		await writeVault(
			encodeVaultBlob({
				slots: decoded.blob.slots,
				entriesIv,
				entriesCiphertext,
			}),
			vaultId,
		);
	}
}

/** Decrypt, mutate, re-encrypt the outer entry list via offscreen so plaintext never leaves it.
 * `vaultId` tags the outer crypto ops so they use that vault's VEK (matching the blob read/write);
 * omitted resolves to the active vault. */
export async function reencryptOuterWithEntryChange(
	currentBlob: VaultBlob,
	mutate: (entries: EncryptedEntry[]) => Promise<EncryptedEntry[]>,
	vaultId?: string,
): Promise<{ entriesIv: Uint8Array; entriesCiphertext: Uint8Array; entryCount: number }> {
	let payload: EntriesPayload;
	if (currentBlob.entriesCiphertext.length === 0) {
		payload = emptyEntriesPayload();
	} else {
		const decrypted = await sendToOffscreen({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId,
			payload: {
				iv: bytesToBase64(currentBlob.entriesIv),
				ciphertext: bytesToBase64(currentBlob.entriesCiphertext),
			},
		});
		if (!decrypted.ok || typeof decrypted.data !== "string") {
			throw new Error(`outer decrypt failed: ${decrypted.error ?? "no data"}`);
		}
		payload = decodeEntriesPayload(decrypted.data);
	}
	// Keep the background clock ahead of every stamp already on disk.
	for (const e of payload.entries) await witnessStamp(e.hlc);
	for (const t of payload.tombstones) await witnessStamp(t.hlc);
	const mutated = await mutate(payload.entries);
	// Spread the payload rather than naming its fields: the mutate callbacks only add and
	// replace entries, so everything else has to survive verbatim. Naming them dropped
	// `settings` on every background write, so a corner-prompt save or a passkey create erased
	// the vault's synced settings, and the next field added here would have gone the same way.
	const json = encodeEntriesPayload({ ...payload, entries: mutated });
	const encrypted = await sendToOffscreen({
		type: "CRYPTO_ENCRYPT_OUTER",
		vaultId,
		payload: { plaintext: json },
	});
	if (!encrypted.ok || !encrypted.data || typeof encrypted.data !== "object") {
		throw new Error(`outer encrypt failed: ${encrypted.error ?? "no data"}`);
	}
	const { iv, ciphertext } = encrypted.data as { iv: string; ciphertext: string };
	return {
		entriesIv: base64ToBytes(iv),
		entriesCiphertext: base64ToBytes(ciphertext),
		entryCount: mutated.length,
	};
}

/** Notify any open popup that the vault changed so it can re-decrypt. */
export async function broadcastVaultChanged(): Promise<void> {
	try {
		await api.runtime.sendMessage({ type: "VAULT_CHANGED_EXTERNAL" });
	} catch {}
}
