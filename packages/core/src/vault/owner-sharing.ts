// The owner side of a sharing-enabled vault: enabling sharing (the one-way
// VLT1 -> VLT2 conversion), loading the owner's SharingState from the blob,
// and persisting it back. The owner's state is fully derivable from the blob
// plus the vault key: the sharing key is wrapped under the VEK, and every
// collection key carries an owner wrap. See ADR-0005/0007.

import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import type { VaultBlob, Vlt2Blob } from "../vault-format";
import { SHARING_WRAP_KIND_VEK, VLT2 } from "../vault-format";
import type { SharingDeps, SharingState } from "./sharing-mutations";

/** The vault-key ops the owner path needs (the loaded VEK, per-vault adapter). */
export interface OwnerVekCrypto {
	encryptWithVek(plaintext: string): Promise<{ iv: string; ciphertext: string }>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;
}

/** Enable sharing on an existing vault: mint a sharing key, wrap it under the
 * vault key, write an empty region, and re-encode as VLT2. Slots and the
 * entries payload are carried over untouched — the owner's unlock path and
 * every entry stay byte-identical. One-way: a sharing-enabled vault stays
 * VLT2 (members exist in its region; there is no un-share-everything). */
export async function enableSharing(
	deps: Pick<SharingDeps, "generateKey" | "encryptWithKey" | "encryptWithVek">,
	blob: VaultBlob,
): Promise<Vlt2Blob> {
	const shkB64 = await deps.generateKey();
	const ownerWrap = await deps.encryptWithVek(shkB64);
	const region = { index: [], collections: [], wrappers: [], members: [] };
	const regionCipher = await deps.encryptWithKey(shkB64, JSON.stringify(region));
	return {
		slots: blob.slots,
		entriesIv: blob.entriesIv,
		entriesCiphertext: blob.entriesCiphertext,
		sharingWraps: [
			{
				kind: SHARING_WRAP_KIND_VEK,
				iv: base64ToBytes(ownerWrap.iv),
				wrappedShk: base64ToBytes(ownerWrap.ciphertext),
			},
		],
		regionIv: base64ToBytes(regionCipher.iv),
		regionCiphertext: base64ToBytes(regionCipher.ciphertext),
	};
}

/** The owner wrap of the sharing key, opened with the vault key. */
async function ownerShk(
	deps: Pick<SharingDeps, "decryptWithVek" | "decryptWithKey">,
	blob: Vlt2Blob,
): Promise<string> {
	const wrap = blob.sharingWraps.find((w) => w.kind === SHARING_WRAP_KIND_VEK);
	if (!wrap || wrap.kind !== SHARING_WRAP_KIND_VEK) {
		throw new Error("this vault has no owner sharing-key wrap");
	}
	return deps.decryptWithVek(bytesToBase64(wrap.iv), bytesToBase64(wrap.wrappedShk));
}

/** Load the owner's SharingState from the sharing-enabled blob. Requires the
 * vault key loaded in the provided crypto. Collection keys come from each
 * collection's owner wrap. */
export async function loadOwnerSharingState(
	deps: Pick<SharingDeps, "decryptWithVek" | "decryptWithKey">,
	blob: Vlt2Blob,
): Promise<SharingState> {
	const shkB64 = await ownerShk(deps, blob);
	const region = JSON.parse(
		await deps.decryptWithKey(
			shkB64,
			bytesToBase64(blob.regionIv),
			bytesToBase64(blob.regionCiphertext),
		),
	) as SharingState["region"];
	const collectionKeys: Record<string, string> = {};
	for (const collection of region.collections) {
		const wrap = collection.keyWraps.find((w) => w.target === "owner");
		if (wrap?.target !== "owner") {
			throw new Error(`collection ${collection.id} has no owner key wrap`);
		}
		collectionKeys[collection.id] = await deps.decryptWithVek(wrap.iv, wrap.ciphertext);
	}
	return {
		shkB64,
		sharingWraps: blob.sharingWraps,
		region,
		collectionKeys,
		performer: { role: "owner" },
	};
}

/** Serialize the owner's sharing state back into blob bytes: re-encrypt the
 * region under the sharing key and encode as VLT2, carrying the current
 * outer wraps. The entries payload and slots are untouched. */
export async function persistOwnerSharingState(
	deps: Pick<SharingDeps, "encryptWithKey">,
	state: SharingState,
	/** The blob's invariant parts (slots + entries payload), from any decode of it.
	 * Member secrets too when present: the region-adoption path runs this on
	 * member devices as well, and dropping the secrets there erased the member's
	 * key material on the first synced region update. */
	current: Pick<VaultBlob, "slots" | "entriesIv" | "entriesCiphertext"> &
		Partial<Pick<Vlt2Blob, "memberSecretsIv" | "memberSecretsCiphertext">>,
): Promise<Uint8Array> {
	const regionCipher = await deps.encryptWithKey(state.shkB64, JSON.stringify(state.region));
	const blob: Vlt2Blob = {
		slots: current.slots,
		entriesIv: current.entriesIv,
		entriesCiphertext: current.entriesCiphertext,
		sharingWraps: state.sharingWraps,
		regionIv: base64ToBytes(regionCipher.iv),
		regionCiphertext: base64ToBytes(regionCipher.ciphertext),
		...(current.memberSecretsIv && current.memberSecretsCiphertext
			? {
					memberSecretsIv: current.memberSecretsIv,
					memberSecretsCiphertext: current.memberSecretsCiphertext,
				}
			: {}),
	};
	return VLT2.encode(blob);
}
