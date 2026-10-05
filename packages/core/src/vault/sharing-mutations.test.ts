// Sharing mutations tests: real crypto (WebCrypto + noble X25519), a fixed
// test key standing in for the vault key. Every transition is exercised as a
// state transition — in-memory, no storage, no UI.

import { describe, expect, it } from "vitest";
import { HlcSchema } from "../sync/hlc";
import { bytesToBase64 } from "../util/bytes";
import { emptySharingRegion } from "../vault-format";
import {
	decryptWithKey,
	encryptWithKey,
	generateKey,
	generateMemberKeypair,
	openMemberSeal,
} from "./sharing-crypto";
import {
	addMember,
	addMemberToCollection,
	createCollection,
	createSharingDeps,
	decryptRegion,
	encryptRegion,
	grantEntry,
	moveEntry,
	promoteEntry,
	removeMember,
	removeMemberFromCollection,
	renameCollection,
	resolveEntryDek,
	type SharingState,
	unshareEntry,
	upsertIndexEntry,
} from "./sharing-mutations";

/** A fixed 32-byte test key standing in for the vault key. */
const TEST_VEK = bytesToBase64(new Uint8Array(32).fill(0xab));

/** Real AES-GCM under the fixed test key, standing in for the adapter's VEK ops. */
function makeDeps() {
	return createSharingDeps({
		encryptWithVek: (plaintext) => encryptWithKey(TEST_VEK, plaintext),
		decryptWithVek: (iv, ciphertext) => decryptWithKey(TEST_VEK, iv, ciphertext),
	});
}

const deps = makeDeps();

/** An owner state with an empty region and a fresh sharing key. */
async function ownerState(): Promise<SharingState> {
	const shk = await generateKey();
	return {
		shkB64: shk,
		sharingWraps: [],
		region: emptySharingRegion(),
		collectionKeys: {},
		performer: { role: "owner" },
	};
}

/** A member state built from a collection state: decrypts the member's seals. */
async function asMember(
	state: SharingState,
	memberId: string,
	privateKeyB64: string,
): Promise<SharingState> {
	const wrap = state.sharingWraps.find((w) => w.kind === 2 && w.memberId === memberId);
	if (wrap?.kind !== 2) throw new Error("member SHK seal not found");
	const shkB64 = await openMemberSeal(privateKeyB64, {
		ephemeralPub: bytesToBase64(wrap.ephemeralPub),
		iv: bytesToBase64(wrap.iv),
		ciphertext: bytesToBase64(wrap.wrappedShk),
	});
	const { iv, ciphertext } = await encryptRegion(deps, state);
	const region = await decryptRegion(deps, shkB64, iv, ciphertext);
	const collectionKeys: Record<string, string> = {};
	for (const collection of region.collections) {
		if (!collection.memberIds.includes(memberId)) continue;
		const seal = collection.keyWraps.find(
			(w) => w.target === "member" && w.memberId === memberId,
		) as {
			target: "member";
			memberId: string;
			ephemeralPub: string;
			iv: string;
			ciphertext: string;
		};
		collectionKeys[collection.id] = await openMemberSeal(privateKeyB64, seal);
	}
	return {
		shkB64,
		sharingWraps: state.sharingWraps,
		region,
		collectionKeys,
		memberPrivateKeyB64: privateKeyB64,
		performer: { role: "member", memberId },
	};
}

/** A member's SHK seal (SharingWrap bytes) as a SealedKey for openMemberSeal. */
function _asSealed(wrap: { ephemeralPub: Uint8Array; iv: Uint8Array; wrappedShk: Uint8Array }) {
	return {
		ephemeralPub: bytesToBase64(wrap.ephemeralPub),
		iv: bytesToBase64(wrap.iv),
		ciphertext: bytesToBase64(wrap.wrappedShk),
	};
}

const HLC = HlcSchema.parse({ wall: 1700000000000, counter: 1, node: "a" });

describe("collections", () => {
	it("creates a collection with a sealed label and an owner key wrap", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		expect(state.region.collections).toHaveLength(1);
		const collection = state.region.collections[0]!;
		// The label round-trips through the collection key.
		expect(
			await decryptWithKey(
				state.collectionKeys[collection.id]!,
				collection.labelIv,
				collection.labelCiphertext,
			),
		).toBe("Dad's banking");
		// The owner wrap decrypts under the (test) vault key to the same key.
		const ownerWrap = collection.keyWraps[0]!;
		expect(ownerWrap.target).toBe("owner");
		expect(await deps.decryptWithVek(ownerWrap.iv, ownerWrap.ciphertext)).toBe(
			state.collectionKeys[collection.id],
		);
		expect(collection.memberIds).toEqual([]);
	});

	it("a member cannot create a collection", async () => {
		const state = await ownerState();
		const memberState: SharingState = { ...state, performer: { role: "member", memberId: "m1" } };
		await expect(createCollection(deps, memberState, "nope")).rejects.toThrow(/owner/);
	});

	it("renames by re-sealing the label with the same key", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Before");
		const id = state.region.collections[0]!.id;
		const keyBefore = state.collectionKeys[id];
		state = await renameCollection(deps, state, id, "After");
		const collection = state.region.collections[0]!;
		expect(
			await decryptWithKey(
				state.collectionKeys[id]!,
				collection.labelIv,
				collection.labelCiphertext,
			),
		).toBe("After");
		// Same key — only the label was re-sealed.
		expect(state.collectionKeys[id]).toBe(keyBefore);
	});
});

describe("grants", () => {
	async function grantedState() {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		const collectionId = state.region.collections[0]!.id;
		const dekB64 = await generateKey();
		state = await grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 });
		return { state, collectionId, dekB64 };
	}

	it("wraps the existing DEK under the collection key without touching the payload", async () => {
		const { state, collectionId, dekB64 } = await grantedState();
		const wrapper = state.region.wrappers[0]!;
		expect(wrapper.entryId).toBe("entry-1");
		// The wrapper opens to the same DEK.
		expect(
			await decryptWithKey(state.collectionKeys[collectionId]!, wrapper.dekIv, wrapper.wrappedDek),
		).toBe(dekB64);
	});

	it("rejects a duplicate grant of the same entry into the same collection", async () => {
		const { state, collectionId, dekB64 } = await grantedState();
		await expect(
			grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 }),
		).rejects.toThrow(/already/);
	});

	it("unshares by removing the wrapper record only", async () => {
		const { state, collectionId } = await grantedState();
		const next = await unshareEntry(deps, state, { entryId: "entry-1", collectionId });
		expect(next.region.wrappers).toHaveLength(0);
		// The collection and its key survive.
		expect(next.region.collections).toHaveLength(1);
	});

	it("unshare of an entry not in the collection is an error", async () => {
		const { state, collectionId } = await grantedState();
		await expect(
			unshareEntry(deps, state, { entryId: "entry-other", collectionId }),
		).rejects.toThrow(/not in collection/);
	});

	it("moves the entry by re-wrapping the DEK under the target key", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "With dad");
		state = await createCollection(deps, state, "Family");
		const withDad = state.region.collections[0]!;
		const family = state.region.collections[1]!;
		const dekB64 = await generateKey();
		state = await grantEntry(deps, state, { entryId: "e1", collectionId: withDad.id, dekB64 });
		state = await moveEntry(deps, state, {
			entryId: "e1",
			fromCollectionId: withDad.id,
			toCollectionId: family.id,
		});
		const wrapper = state.region.wrappers[0]!;
		expect(wrapper.collectionId).toBe(family.id);
		expect(
			await decryptWithKey(state.collectionKeys[family.id]!, wrapper.dekIv, wrapper.wrappedDek),
		).toBe(dekB64);
	});

	it("a member cannot grant or move", async () => {
		const { state, collectionId } = await grantedState();
		const memberState: SharingState = { ...state, performer: { role: "member", memberId: "m1" } };
		await expect(
			grantEntry(deps, memberState, { entryId: "e2", collectionId, dekB64: "x" }),
		).rejects.toThrow(/owner/);
		await expect(
			moveEntry(deps, memberState, {
				entryId: "entry-1",
				fromCollectionId: collectionId,
				toCollectionId: collectionId,
			}),
		).rejects.toThrow(/owner/);
	});
});

describe("members and membership", () => {
	it("registers a member with the sharing key sealed to their public key", async () => {
		let state = await ownerState();
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		expect(state.region.members).toHaveLength(1);
		const wrap = state.sharingWraps.find((w) => w.kind === 2);
		if (wrap?.kind !== 2) throw new Error("expected member SHK wrap");
		expect(wrap.memberId).toBe("dad");
		// The seal opens to the sharing key with the member's private key.
		expect(
			await openMemberSeal(dad.privateKey, {
				ephemeralPub: bytesToBase64(wrap.ephemeralPub),
				iv: bytesToBase64(wrap.iv),
				ciphertext: bytesToBase64(wrap.wrappedShk),
			}),
		).toBe(state.shkB64);
	});

	it("rejects a duplicate member", async () => {
		let state = await ownerState();
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		await expect(
			addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey }),
		).rejects.toThrow(/already/);
	});

	it("grants collection access by sealing the collection key to the member", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		const collectionId = state.region.collections[0]!.id;
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "dad" });
		const collection = state.region.collections[0]!;
		expect(collection.memberIds).toEqual(["dad"]);
		const seal = collection.keyWraps.find((w) => w.target === "member") as never as {
			ephemeralPub: string;
			iv: string;
			ciphertext: string;
		};
		expect(await openMemberSeal(dad.privateKey, seal)).toBe(state.collectionKeys[collectionId]);
	});

	it("the member can then read the whole chain: shk -> region -> collection key", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		const collectionId = state.region.collections[0]!.id;
		const dekB64 = await generateKey();
		state = await grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 });
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "dad" });
		const memberState = await asMember(state, "dad", dad.privateKey);
		// The member sees exactly the shared entries: index has their entry id,
		// and the wrapper record opens to the DEK.
		const wrapper = memberState.region.wrappers[0]!;
		expect(
			await decryptWithKey(
				memberState.collectionKeys[collectionId]!,
				wrapper.dekIv,
				wrapper.wrappedDek,
			),
		).toBe(dekB64);
	});

	it("a member can promote their private entry into a collection they belong to", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Family");
		const wife = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "wife", publicKey: wife.publicKey });
		const collectionId = state.region.collections[0]!.id;
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "wife" });
		const memberState = await asMember(state, "wife", wife.privateKey);
		const dekB64 = await generateKey();
		const promoted = await promoteEntry(deps, memberState, {
			entryId: "wife-private-1",
			collectionId,
			dekB64,
		});
		const wrapper = promoted.region.wrappers[0]!;
		expect(wrapper.entryId).toBe("wife-private-1");
		// The owner resolves the DEK through the collection key.
		const ownerDek = await resolveEntryDek(deps, promoted, {
			via: "collection",
			entryId: "wife-private-1",
			collectionId,
		});
		expect(ownerDek).toBe(dekB64);
	});

	it("a member cannot promote into a collection they do not belong to", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad only");
		state = await createCollection(deps, state, "Family");
		const wife = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "wife", publicKey: wife.publicKey });
		const dadOnly = state.region.collections[0]!;
		const family = state.region.collections[1]!;
		state = await addMemberToCollection(deps, state, { collectionId: family.id, memberId: "wife" });
		const memberState = await asMember(state, "wife", wife.privateKey);
		await expect(
			promoteEntry(deps, memberState, { entryId: "e1", collectionId: dadOnly.id, dekB64: "x" }),
		).rejects.toThrow(/not in collection|no collection key/);
	});

	it("promotion of an already-shared entry is rejected", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Family");
		const wife = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "wife", publicKey: wife.publicKey });
		const collectionId = state.region.collections[0]!.id;
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "wife" });
		const dekB64 = await generateKey();
		// The owner already shares entry-1 into the collection.
		state = await grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 });
		const memberState = await asMember(state, "wife", wife.privateKey);
		await expect(
			promoteEntry(deps, memberState, { entryId: "entry-1", collectionId, dekB64 }),
		).rejects.toThrow(/already shared/);
	});
});

describe("revocation", () => {
	async function dadInCollection() {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		const dad = await generateMemberKeypair();
		const wife = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		state = await addMember(deps, state, { memberId: "wife", publicKey: wife.publicKey });
		const collectionId = state.region.collections[0]!.id;
		const dekB64 = await generateKey();
		state = await grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 });
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "dad" });
		state = await addMemberToCollection(deps, state, { collectionId, memberId: "wife" });
		return { state, dad, wife, collectionId, dekB64 };
	}

	it("removing a member rotates the collection key and re-wraps the entries", async () => {
		const { state, wife, collectionId, dekB64 } = await dadInCollection();
		const oldKey = state.collectionKeys[collectionId];
		if (!oldKey) throw new Error("collection key missing");
		const next = await removeMember(deps, state, "dad");
		const rotatedCollectionId = collectionId;
		const rotatedKey = next.collectionKeys[rotatedCollectionId];
		if (!rotatedKey) throw new Error("rotated collection key missing");
		const collection = next.region.collections[0]!;
		// The key rotated.
		expect(rotatedKey).not.toBe(oldKey);
		// No key wrap for the removed member remains.
		expect(collection.memberIds).toEqual(["wife"]);
		expect(collection.keyWraps.some((w) => w.target === "member" && w.memberId === "dad")).toBe(
			false,
		);
		// The wrapper record still opens to the same DEK under the new key.
		const wrapper = next.region.wrappers[0]!;
		expect(
			await decryptWithKey(next.collectionKeys[collectionId]!, wrapper.dekIv, wrapper.wrappedDek),
		).toBe(dekB64);
		// The member record and SHK wrap are gone.
		expect(next.region.members.some((m) => m.id === "dad")).toBe(false);
		expect(
			next.sharingWraps.some(
				(w) => w.kind === 2 && (w as { memberId?: string }).memberId === "dad",
			),
		).toBe(false);
		// The remaining member can still open the chain.
		const wifeWrap = collection.keyWraps.find((w) => w.target === "member");
		if (wifeWrap?.target !== "member") throw new Error("expected member key wrap");
		expect(await openMemberSeal(wife.privateKey, wifeWrap)).toBe(rotatedKey);
		// The removed member's old key no longer opens the wrapper record.
		await expect(decryptWithKey(oldKey, wrapper.dekIv, wrapper.wrappedDek)).rejects.toThrow();
	});

	it("revoking from one collection does not touch another", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "With dad");
		state = await createCollection(deps, state, "Family");
		const dad = await generateMemberKeypair();
		state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
		const withDad = state.region.collections[0]!;
		const family = state.region.collections[1]!;
		const dek1 = await generateKey();
		state = await grantEntry(deps, state, {
			entryId: "e1",
			collectionId: withDad.id,
			dekB64: dek1,
		});
		state = await addMemberToCollection(deps, state, { collectionId: withDad.id, memberId: "dad" });
		state = await addMemberToCollection(deps, state, { collectionId: family.id, memberId: "dad" });
		const next = await removeMemberFromCollection(deps, state, {
			collectionId: withDad.id,
			memberId: "dad",
		});
		// "With dad" rotated and lost the member.
		expect(next.region.collections[0]!.memberIds).toEqual([]);
		// "Family" is untouched, same key.
		expect(next.collectionKeys[family.id]).toBe(state.collectionKeys[family.id]);
		expect(next.region.collections[1]!.memberIds).toEqual(["dad"]);
	});

	it("the removed member's stale copy cannot open the rotated wrapper", async () => {
		const { state, dad, collectionId, dekB64 } = await dadInCollection();
		const memberState = await asMember(state, "dad", dad.privateKey);
		// Snapshot the member's view before revocation.
		const oldWrapper = memberState.region.wrappers[0]!;
		const next = await removeMember(deps, state, "dad");
		const newWrapper = next.region.wrappers[0]!;
		// Old member key: the new wrapper's DEK is sealed to other members now,
		// and the old collection key no longer decrypts the re-wrapped record.
		await expect(
			decryptWithKey(
				oldKeySnapshot(memberState, collectionId),
				newWrapper.dekIv,
				newWrapper.wrappedDek,
			),
		).rejects.toThrow();
		// But their stale local copy (old wrapper) still opens — trust, not control.
		expect(
			await decryptWithKey(
				oldKeySnapshot(memberState, collectionId),
				oldWrapper.dekIv,
				oldWrapper.wrappedDek,
			),
		).toBe(dekB64);
	});

	function oldKeySnapshot(state: SharingState, collectionId: string): string {
		return state.collectionKeys[collectionId]!;
	}
});

describe("index", () => {
	it("upserts index records and keeps them content-free", async () => {
		let state = await ownerState();
		state = upsertIndexEntry(state, { id: "e1", hlc: HLC, deleted: false });
		state = upsertIndexEntry(state, { id: "e1", hlc: { ...HLC, counter: 2 }, deleted: true });
		expect(state.region.index).toHaveLength(1);
		expect(state.region.index[0]).toEqual({ id: "e1", hlc: { ...HLC, counter: 2 }, deleted: true });
		// The region round-trips through the sharing key.
		const sealed = await encryptRegion(deps, state);
		const round = await decryptRegion(deps, state.shkB64, sealed.iv, sealed.ciphertext);
		expect(round.index).toEqual(state.region.index);
	});

	it("the serialized region contains no plaintext content", async () => {
		let state = await ownerState();
		state = await createCollection(deps, state, "Secret collection name");
		const sealed = await encryptRegion(deps, state);
		expect(sealed.ciphertext).not.toContain("Secret");
	});
});

describe("resolveEntryDek", () => {
	it("resolves via the vault key path", async () => {
		const dekB64 = await generateKey();
		const entry = await encryptWithKey(TEST_VEK, dekB64);
		const state = await ownerState();
		expect(
			await resolveEntryDek(deps, state, {
				via: "vek",
				entry: { dekIv: entry.iv, wrappedDek: entry.ciphertext },
			}),
		).toBe(dekB64);
	});

	it("resolves via the collection path", async () => {
		const { state, collectionId, dekB64 } = await grantedState();
		expect(
			await resolveEntryDek(deps, state, { via: "collection", entryId: "entry-1", collectionId }),
		).toBe(dekB64);
	});

	async function grantedState() {
		let state = await ownerState();
		state = await createCollection(deps, state, "Dad's banking");
		const collectionId = state.region.collections[0]!.id;
		const dekB64 = await generateKey();
		state = await grantEntry(deps, state, { entryId: "entry-1", collectionId, dekB64 });
		return { state, collectionId, dekB64 };
	}
});
