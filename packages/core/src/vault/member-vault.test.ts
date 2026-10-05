// Member unlock path tests: the full member chain, end to end, with real
// crypto — member slot in the blob, member secrets under the member master
// key, sharing key seal, region, collection key seal, and finally a shared
// entry's DEK. The owner side is assembled with the sharing transitions; the
// member blob simulates what enrollment produces.

import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import {
	findMemberPasswordSlot,
	findPasswordSlot,
	findUnlockPasswordSlot,
	isMemberVault,
	LEN_IV,
	SLOT_KIND_MEMBER_PASSWORD,
	SLOT_KIND_PASSWORD,
	type Vlt2Blob,
} from "../vault-format";
import {
	buildMemberSharingState,
	decryptMemberSecrets,
	encryptMemberSecrets,
	wrapDekForMemberStorage,
} from "./member-vault";
import {
	decryptWithKey,
	encryptWithKey,
	generateKey,
	generateMemberKeypair,
} from "./sharing-crypto";
import {
	addMember,
	addMemberToCollection,
	createCollection,
	createSharingDeps,
	encryptRegion,
	grantEntry,
	type SharingState,
} from "./sharing-mutations";

const TEST_VEK = bytesToBase64(new Uint8Array(32).fill(0xab));

const deps = createSharingDeps({
	encryptWithVek: (plaintext) => encryptWithKey(TEST_VEK, plaintext),
	decryptWithVek: (iv, ciphertext) => decryptWithKey(TEST_VEK, iv, ciphertext),
});

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function slot(kind: number) {
	return {
		kind,
		slotId: fillBytes(16, 0x10),
		salt: fillBytes(16, 0x20),
		verifier: fillBytes(32, 0x30),
		wrapIv: fillBytes(12, 0x40),
		wrappedVek: fillBytes(48, 0x50),
	};
}

describe("member slots", () => {
	it("a member blob carries member slots and is detected as a member vault", () => {
		const blob = {
			slots: [slot(SLOT_KIND_MEMBER_PASSWORD)],
			sharingWraps: [],
			entriesIv: fillBytes(LEN_IV),
			entriesCiphertext: new Uint8Array(0),
			regionIv: fillBytes(LEN_IV),
			regionCiphertext: new Uint8Array(0),
		} as Vlt2Blob;
		expect(findMemberPasswordSlot(blob)).not.toBeNull();
		expect(findPasswordSlot(blob)).toBeNull();
		expect(findUnlockPasswordSlot(blob)?.kind).toBe(SLOT_KIND_MEMBER_PASSWORD);
		expect(isMemberVault(blob)).toBe(true);
	});

	it("an owner blob is not a member vault", () => {
		const blob = {
			slots: [slot(SLOT_KIND_PASSWORD)],
			sharingWraps: [],
			entriesIv: fillBytes(LEN_IV),
			entriesCiphertext: new Uint8Array(0),
			regionIv: fillBytes(LEN_IV),
			regionCiphertext: new Uint8Array(0),
		} as Vlt2Blob;
		expect(isMemberVault(blob)).toBe(false);
		expect(findUnlockPasswordSlot(blob)?.kind).toBe(SLOT_KIND_PASSWORD);
	});
});

describe("member secrets", () => {
	it("round-trips encrypted under the member master key", async () => {
		const mmk = await generateKey();
		const secrets = { memberId: "dad", memberPrivateKey: "priv-b64" };
		const sealed = await encryptMemberSecrets(deps, mmk, secrets);
		const blob = {
			slots: [slot(SLOT_KIND_MEMBER_PASSWORD)],
			sharingWraps: [],
			entriesIv: fillBytes(LEN_IV),
			entriesCiphertext: new Uint8Array(0),
			memberSecretsIv: base64ToBytes(sealed.iv),
			memberSecretsCiphertext: base64ToBytes(sealed.ciphertext),
			regionIv: fillBytes(LEN_IV),
			regionCiphertext: new Uint8Array(0),
		} as Vlt2Blob;
		expect(await decryptMemberSecrets(deps, mmk, blob)).toEqual(secrets);
		// Not openable with a wrong key.
		await expect(decryptMemberSecrets(deps, await generateKey(), blob)).rejects.toThrow();
	});
});

describe("buildMemberSharingState", () => {
	/** Assemble the owner state with one collection, one shared entry, and a
	 * member with access — then produce the member's blob as enrollment would. */
	async function memberWorld() {
		let state: SharingState = {
			shkB64: await generateKey(),
			sharingWraps: [],
			region: {
				index: [],
				collections: [],
				wrappers: [],
				members: [],
			},
			collectionKeys: {},
			performer: { role: "owner" },
		};
		state = await createCollection(deps, state, "Dad's banking");
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		const collectionId = state.region.collections[0]!.id;
		const entryDek = await generateKey();
		const entryPlaintext = JSON.stringify({ title: "Dad's bank", password: "hunter2" });
		// The owner's local entry payload: content under the DEK, DEK under the vault key.
		const ownerContent = await encryptWithKey(entryDek, entryPlaintext);
		const ownerDekWrap = await encryptWithKey(TEST_VEK, entryDek);
		state = await grantEntry(deps, state, {
			entryId: "entry-dad-bank",
			collectionId,
			dekB64: entryDek,
		});
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "dad" });

		// The member's device: MMK, secrets blob, member slot, SHK seal, region.
		const mmk = await generateKey();
		const memberSecrets = await encryptMemberSecrets(deps, mmk, {
			memberId: "dad",
			memberPrivateKey: dad.privateKey,
		});
		const { iv: regionIv, ciphertext: regionCiphertext } = await encryptRegion(deps, state);
		const blob = {
			slots: [slot(SLOT_KIND_MEMBER_PASSWORD)],
			sharingWraps: state.sharingWraps,
			entriesIv: fillBytes(LEN_IV, 0x30),
			entriesCiphertext: fillBytes(16, 0x40),
			memberSecretsIv: base64ToBytes(memberSecrets.iv),
			memberSecretsCiphertext: base64ToBytes(memberSecrets.ciphertext),
			regionIv: base64ToBytes(regionIv),
			regionCiphertext: base64ToBytes(regionCiphertext),
		} as Vlt2Blob;
		return { state, dad, mmk, blob, entryDek, entryPlaintext, ownerContent, ownerDekWrap };
	}

	it("builds a member performer state through the full chain", async () => {
		const { state, mmk, blob } = await memberWorld();
		const memberState = await buildMemberSharingState(deps, { blob, memberMasterKeyB64: mmk });
		expect(memberState.performer).toEqual({ role: "member", memberId: "dad" });
		expect(memberState.shkB64).toBe(state.shkB64);
		// The member holds exactly the collection key, not the owner's others.
		expect(Object.keys(memberState.collectionKeys)).toEqual([state.region.collections[0]!.id]);
	});

	it("the member can open the shared entry's DEK via the wrapper record", async () => {
		const { state, mmk, blob, entryDek } = await memberWorld();
		const memberState = await buildMemberSharingState(deps, { blob, memberMasterKeyB64: mmk });
		const collectionId = state.region.collections[0]!.id;
		const wrapper = memberState.region.wrappers[0]!;
		const dek = await decryptWithKey(
			memberState.collectionKeys[collectionId]!,
			wrapper.dekIv,
			wrapper.wrappedDek,
		);
		expect(dek).toBe(entryDek);
	});

	it("the member stores the entry locally wrapped under the member master key", async () => {
		const { mmk, entryDek, entryPlaintext, ownerContent } = await memberWorld();
		// On receipt, the member re-wraps the DEK under their MMK for local storage.
		const local = await wrapDekForMemberStorage(deps, mmk, entryDek);
		const dek = await decryptWithKey(mmk, local.dekIv, local.wrappedDek);
		expect(dek).toBe(entryDek);
		// The content itself is DEK-encrypted and identical to what the owner has.
		const plaintext = await decryptWithKey(dek, ownerContent.iv, ownerContent.ciphertext);
		expect(plaintext).toBe(entryPlaintext);
	});

	it("refuses to build a member state from an owner vault", async () => {
		const { blob } = await memberWorld();
		const ownerBlob = { ...blob, slots: [slot(SLOT_KIND_PASSWORD)] } as Vlt2Blob;
		await expect(
			buildMemberSharingState(deps, { blob: ownerBlob, memberMasterKeyB64: await generateKey() }),
		).rejects.toThrow(/not a member vault/);
	});

	it("refuses when the member secrets are missing", async () => {
		const { mmk, blob } = await memberWorld();
		const stripped = {
			...blob,
			memberSecretsIv: undefined,
			memberSecretsCiphertext: undefined,
		} as Vlt2Blob;
		await expect(
			buildMemberSharingState(deps, { blob: stripped, memberMasterKeyB64: mmk }),
		).rejects.toThrow(/member secrets/);
	});
});
