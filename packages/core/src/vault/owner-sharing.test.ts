// Owner sharing lifecycle tests: enable sharing on a real VLT1 vault, load the
// owner's state, run transitions, persist, reload — full circle with real crypto.

import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../util/bytes";
import { decodeVault, findPasswordSlot, type VaultBlob, VLT2 } from "../vault-format";
import {
	enableSharing,
	loadOwnerSharingState,
	type OwnerVekCrypto,
	persistOwnerSharingState,
} from "./owner-sharing";
import { decryptWithKey, encryptWithKey } from "./sharing-crypto";
import { createCollection, createSharingDeps } from "./sharing-mutations";

const TEST_VEK = bytesToBase64(new Uint8Array(32).fill(0x77));

const vek: OwnerVekCrypto = {
	encryptWithVek: (plaintext) => encryptWithKey(TEST_VEK, plaintext),
	decryptWithVek: (iv, ciphertext) => decryptWithKey(TEST_VEK, iv, ciphertext),
};
const deps = createSharingDeps(vek);

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function makeVlt1Blob(): VaultBlob {
	return {
		slots: [
			{
				kind: 1,
				slotId: fillBytes(16, 0x10),
				salt: fillBytes(16, 0x20),
				verifier: fillBytes(32, 0x30),
				wrapIv: fillBytes(12, 0x40),
				wrappedVek: fillBytes(48, 0x50),
			},
		],
		entriesIv: fillBytes(12, 0x60),
		entriesCiphertext: fillBytes(32, 0x70),
	};
}

describe("enableSharing", () => {
	it("converts a VLT1 vault to VLT2 carrying slots and entries untouched", async () => {
		const v1 = makeVlt1Blob();
		const v2 = await enableSharing(deps, v1);
		expect(findPasswordSlot(v2)).not.toBeNull();
		expect(v2.entriesCiphertext).toEqual(v1.entriesCiphertext);
		expect(v2.sharingWraps).toHaveLength(1);
		// The blob encodes and decodes as VLT2.
		expect(decodeVault(VLT2.encode(v2)).format).toBe("vlt2");
	});

	it("the owner wrap opens to the sharing key, and the region decrypts", async () => {
		const v2 = await enableSharing(deps, makeVlt1Blob());
		const state = await loadOwnerSharingState(deps, v2);
		expect(state.performer).toEqual({ role: "owner" });
		expect(state.region.collections).toEqual([]);
		expect(state.region.members).toEqual([]);
	});
});

describe("owner state lifecycle", () => {
	it("create collection -> persist -> reload keeps the state", async () => {
		const v2 = await enableSharing(deps, makeVlt1Blob());
		let state = await loadOwnerSharingState(deps, v2);
		state = await createCollection(deps, state, "Dad's banking");

		const bytes = await persistOwnerSharingState(deps, state, v2);
		const decoded = decodeVault(bytes);
		expect(decoded.format).toBe("vlt2");
		const reloaded = await loadOwnerSharingState(
			deps,
			decoded.blob as Parameters<typeof loadOwnerSharingState>[1],
		);
		expect(reloaded.region.collections).toHaveLength(1);
		// The label decrypts with the reloaded collection key.
		const collection = reloaded.region.collections[0]!;
		expect(
			await decryptWithKey(
				reloaded.collectionKeys[collection.id]!,
				collection.labelIv,
				collection.labelCiphertext,
			),
		).toBe("Dad's banking");
		// The entries payload is untouched across the whole cycle.
		expect(reloaded.sharingWraps).toEqual(state.sharingWraps);
	});

	it("a fresh sharing key is minted per enable, and it differs across vaults", async () => {
		const a = await enableSharing(deps, makeVlt1Blob());
		const b = await enableSharing(deps, makeVlt1Blob());
		const shkA = await loadOwnerSharingState(deps, a);
		const shkB = await loadOwnerSharingState(deps, b);
		expect(shkA.shkB64).not.toBe(shkB.shkB64);
	});
});
