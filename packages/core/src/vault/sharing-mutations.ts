// The sharing mutations: every change to a sharing-enabled vault's sharing
// layer is a transition here and nowhere else, mirroring EntryMutations for
// VaultEntries. See ADR-0001 (collections), ADR-0002 (member keys),
// ADR-0003 (index), ADR-0004 (revocation), ADR-0005 (authority).
//
// A transition takes (deps, state, input) and returns the NEXT state. It never
// touches storage and never persists: the caller serializes the region (via
// encryptRegion) and writes the blob. The state carries the decrypted working
// key material the performer holds; the performer field carries who is acting,
// and owner-only transitions enforce it.

import type { VekEncrypted } from "../adapters/crypto";
import { base64ToBytes } from "../util/bytes";
import {
	type RegionKeyWrap,
	SHARING_WRAP_KIND_MEMBER,
	type SharingRegion,
	type SharingWrap,
} from "../vault-format";
import * as sharingCrypto from "./sharing-crypto";

export interface SharingDeps {
	/** AES-256-GCM under an explicit key: region, labels, wrapper DEKs. */
	encryptWithKey(keyB64: string, plaintext: string): Promise<{ iv: string; ciphertext: string }>;
	decryptWithKey(keyB64: string, iv: string, ciphertext: string): Promise<string>;
	generateKey(): Promise<string>;
	/** Seal a raw key (b64) to a member's public key (ADR-0002). */
	sealToMemberKey(recipientPubB64: string, rawKeyB64: string): Promise<sharingCrypto.SealedKey>;
	openMemberSeal(privateKeyB64: string, sealed: sharingCrypto.SealedKey): Promise<string>;
	/** Owner path: the loaded vault key, through the per-vault adapter. */
	encryptWithVek(plaintext: string): Promise<VekEncrypted>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;
}

/** Production deps: the real sharing crypto plus the caller's vault-key ops. */
export function createSharingDeps(crypto: {
	encryptWithVek(plaintext: string): Promise<VekEncrypted>;
	decryptWithVek(iv: string, ciphertext: string): Promise<string>;
}): SharingDeps {
	return {
		...sharingCrypto,
		encryptWithVek: crypto.encryptWithVek,
		decryptWithVek: crypto.decryptWithVek,
	};
}

/** Who is acting. Owner-only transitions enforce this at the transition, not
 * the UI: a member context simply cannot perform a grant. */
export type SharingPerformer = { role: "owner" } | { role: "member"; memberId: string };

/** The in-memory sharing state a performer holds: the decrypted region, the
 * sharing key, the outer wraps, and every collection key they can open. */
export interface SharingState {
	shkB64: string;
	/** Outer SHK wraps (blob-level): owner's (under the vault key) and per member. */
	sharingWraps: SharingWrap[];
	region: SharingRegion;
	/** Decrypted collection keys this performer holds, by collection id. */
	collectionKeys: Record<string, string>;
	/** Member context only: the performer's X25519 private key (b64). */
	memberPrivateKeyB64?: string;
	performer: SharingPerformer;
}

function requireOwner(state: SharingState): void {
	if (state.performer.role !== "owner") {
		throw new Error("only the owner can perform this sharing action");
	}
}

function requireCollection(state: SharingState, collectionId: string) {
	const collection = state.region.collections.find((c) => c.id === collectionId);
	if (!collection) throw new Error(`unknown collection: ${collectionId}`);
	return collection;
}

function requireCollectionKey(state: SharingState, collectionId: string): string {
	const key = state.collectionKeys[collectionId];
	if (!key) throw new Error(`no collection key held for: ${collectionId}`);
	return key;
}

/** Serialize the region for persistence: JSON encrypted under the sharing key. */
export async function encryptRegion(
	deps: SharingDeps,
	state: SharingState,
): Promise<{ iv: string; ciphertext: string }> {
	return deps.encryptWithKey(state.shkB64, JSON.stringify(state.region));
}

/** The inverse: decrypt a stored region with the sharing key. */
export async function decryptRegion(
	deps: SharingDeps,
	shkB64: string,
	iv: string,
	ciphertext: string,
): Promise<SharingRegion> {
	return JSON.parse(await deps.decryptWithKey(shkB64, iv, ciphertext)) as SharingRegion;
}

/** Create a collection. Owner-only (ADR-0005): the key wrap goes under the
 * vault key; members are added later, each getting their own seal. */
export async function createCollection(
	deps: SharingDeps,
	state: SharingState,
	name: string,
): Promise<SharingState> {
	requireOwner(state);
	const id = globalThis.crypto.randomUUID();
	const key = await deps.generateKey();
	const label = await deps.encryptWithKey(key, name);
	const ownerWrap = await deps.encryptWithVek(key);
	return withCollection(state, {
		id,
		labelIv: label.iv,
		labelCiphertext: label.ciphertext,
		memberIds: [],
		keyWraps: [{ target: "owner", iv: ownerWrap.iv, ciphertext: ownerWrap.ciphertext }],
		key,
	});
}

/** Rename a collection. Owner-only; needs the collection key to re-seal the label. */
export async function renameCollection(
	deps: SharingDeps,
	state: SharingState,
	collectionId: string,
	name: string,
): Promise<SharingState> {
	requireOwner(state);
	const collection = requireCollection(state, collectionId);
	const key = requireCollectionKey(state, collectionId);
	const label = await deps.encryptWithKey(key, name);
	return withCollection(state, {
		...collection,
		labelIv: label.iv,
		labelCiphertext: label.ciphertext,
		key,
	});
}

/** Share an entry into a collection: wrap its existing DEK under the collection
 * key (ADR-0001 — the payload ciphertext is never re-encrypted). Owner-only.
 * The caller resolves the DEK with resolveEntryDek. */
export async function grantEntry(
	deps: SharingDeps,
	state: SharingState,
	input: { entryId: string; collectionId: string; dekB64: string },
): Promise<SharingState> {
	requireOwner(state);
	requireCollection(state, input.collectionId);
	const key = requireCollectionKey(state, input.collectionId);
	if (
		state.region.wrappers.some(
			(w) => w.entryId === input.entryId && w.collectionId === input.collectionId,
		)
	) {
		throw new Error(`entry ${input.entryId} is already in collection ${input.collectionId}`);
	}
	const wrapped = await deps.encryptWithKey(key, input.dekB64);
	return withWrappers(state, [
		...state.region.wrappers,
		{
			entryId: input.entryId,
			collectionId: input.collectionId,
			dekIv: wrapped.iv,
			wrappedDek: wrapped.ciphertext,
		},
	]);
}

/** Stop sharing an entry (remove it from a collection) without deleting it. */
export async function unshareEntry(
	_deps: SharingDeps,
	state: SharingState,
	input: { entryId: string; collectionId: string },
): Promise<SharingState> {
	requireOwner(state);
	requireCollection(state, input.collectionId);
	const wrapper = state.region.wrappers.find(
		(w) => w.entryId === input.entryId && w.collectionId === input.collectionId,
	);
	if (!wrapper) {
		throw new Error(`entry ${input.entryId} is not in collection ${input.collectionId}`);
	}
	return withWrappers(
		state,
		state.region.wrappers.filter((w) => w !== wrapper),
	);
}

/** Move an entry between collections: re-wrap its DEK under the target key.
 * Owner-only. The DEK comes from the source collection's wrapper. */
export async function moveEntry(
	deps: SharingDeps,
	state: SharingState,
	input: { entryId: string; fromCollectionId: string; toCollectionId: string },
): Promise<SharingState> {
	requireOwner(state);
	requireCollection(state, input.fromCollectionId);
	requireCollection(state, input.toCollectionId);
	const fromKey = requireCollectionKey(state, input.fromCollectionId);
	requireCollectionKey(state, input.toCollectionId);
	const wrapper = state.region.wrappers.find(
		(w) => w.entryId === input.entryId && w.collectionId === input.fromCollectionId,
	);
	if (!wrapper) {
		throw new Error(`entry ${input.entryId} is not in collection ${input.fromCollectionId}`);
	}
	const dekB64 = await deps.decryptWithKey(fromKey, wrapper.dekIv, wrapper.wrappedDek);
	const wrapped = await deps.encryptWithKey(state.collectionKeys[input.toCollectionId]!, dekB64);
	return withWrappers(state, [
		...state.region.wrappers.filter((w) => w !== wrapper),
		{
			entryId: input.entryId,
			collectionId: input.toCollectionId,
			dekIv: wrapped.iv,
			wrappedDek: wrapped.ciphertext,
		},
	]);
}

/** Promotion (ADR-0005): a member shares their own private entry into a
 * collection they belong to, after which the owner can open, edit, and move it.
 * Members cannot re-share entries that were shared to them — a promotion only
 * ever adds the FIRST wrapper for an entry. */
export async function promoteEntry(
	deps: SharingDeps,
	state: SharingState,
	input: { entryId: string; collectionId: string; dekB64: string },
): Promise<SharingState> {
	if (state.performer.role !== "member") {
		// The owner granting an entry is grantEntry; promotion is the member path.
		throw new Error("promotion is a member action; the owner uses grantEntry");
	}
	const collection = requireCollection(state, input.collectionId);
	if (!collection.memberIds.includes(state.performer.memberId)) {
		throw new Error(`member is not in collection ${input.collectionId}`);
	}
	const key = requireCollectionKey(state, input.collectionId);
	if (state.region.wrappers.some((w) => w.entryId === input.entryId)) {
		throw new Error(`entry ${input.entryId} is already shared; it cannot be promoted`);
	}
	const wrapped = await deps.encryptWithKey(key, input.dekB64);
	return withWrappers(state, [
		...state.region.wrappers,
		{
			entryId: input.entryId,
			collectionId: input.collectionId,
			dekIv: wrapped.iv,
			wrappedDek: wrapped.ciphertext,
		},
	]);
}

/** Register a member (owner-only): the member record plus the sharing key
 * sealed to their public key, so they can read the region. Collection access
 * is granted separately, collection by collection. */
export async function addMember(
	deps: SharingDeps,
	state: SharingState,
	input: { memberId: string; publicKey: string; label?: string },
): Promise<SharingState> {
	requireOwner(state);
	if (state.region.members.some((m) => m.id === input.memberId)) {
		throw new Error(`member already exists: ${input.memberId}`);
	}
	const sealed = await deps.sealToMemberKey(input.publicKey, state.shkB64);
	return {
		...state,
		sharingWraps: [
			...state.sharingWraps,
			{
				kind: SHARING_WRAP_KIND_MEMBER,
				memberId: input.memberId,
				ephemeralPub: base64ToBytes(sealed.ephemeralPub),
				iv: base64ToBytes(sealed.iv),
				wrappedShk: base64ToBytes(sealed.ciphertext),
			},
		],
		region: {
			...state.region,
			members: [
				...state.region.members,
				{
					id: input.memberId,
					publicKey: input.publicKey,
					...(input.label ? { label: input.label } : {}),
				},
			],
		},
	};
}

/** Grant a member access to a collection (owner-only): membership plus the
 * collection key sealed to their member key. */
export async function addMemberToCollection(
	deps: SharingDeps,
	state: SharingState,
	input: { collectionId: string; memberId: string },
): Promise<SharingState> {
	requireOwner(state);
	const collection = requireCollection(state, input.collectionId);
	const key = requireCollectionKey(state, input.collectionId);
	const member = state.region.members.find((m) => m.id === input.memberId);
	if (!member) throw new Error(`unknown member: ${input.memberId}`);
	if (collection.memberIds.includes(input.memberId)) {
		throw new Error(`member ${input.memberId} is already in collection ${input.collectionId}`);
	}
	const sealed = await deps.sealToMemberKey(member.publicKey, key);
	return withCollection(state, {
		...collection,
		memberIds: [...collection.memberIds, input.memberId],
		keyWraps: [
			...collection.keyWraps,
			{
				target: "member",
				memberId: input.memberId,
				ephemeralPub: sealed.ephemeralPub,
				iv: sealed.iv,
				ciphertext: sealed.ciphertext,
			},
		],
		key,
	});
}

/** Revoke a member from one collection (owner-only). Rotates the collection
 * key (ADR-0001/0004): the departing member's knowledge of the old key must
 * not extend to future wrapper records. */
export async function removeMemberFromCollection(
	deps: SharingDeps,
	state: SharingState,
	input: { collectionId: string; memberId: string },
): Promise<SharingState> {
	requireOwner(state);
	const collection = requireCollection(state, input.collectionId);
	if (!collection.memberIds.includes(input.memberId)) {
		throw new Error(`member ${input.memberId} is not in collection ${input.collectionId}`);
	}
	const rotated = await rotateCollection(deps, state, collection, input.memberId);
	return rotated;
}

/** Remove a member entirely (owner-only). Every collection they belong to is
 * rotated, their membership, record, and sharing-key wrap are removed.
 * Per ADR-0004 this stops future access; it is NOT a remote wipe — the caller
 * (UI) must tell the user to rotate the affected credentials. */
export async function removeMember(
	deps: SharingDeps,
	state: SharingState,
	memberId: string,
): Promise<SharingState> {
	requireOwner(state);
	const member = state.region.members.find((m) => m.id === memberId);
	if (!member) throw new Error(`unknown member: ${memberId}`);

	let next = state;
	for (const collection of state.region.collections) {
		if (collection.memberIds.includes(memberId)) {
			next = await rotateCollection(deps, next, collection, memberId);
		}
	}
	return {
		...next,
		sharingWraps: next.sharingWraps.filter(
			(w) => !(w.kind === SHARING_WRAP_KIND_MEMBER && w.memberId === memberId),
		),
		region: {
			...next.region,
			members: next.region.members.filter((m) => m.id !== memberId),
		},
	};
}

/** Rotate one collection's key: new key, every wrapper record re-wrapped under
 * it (payloads untouched), label re-sealed, key wraps rebuilt for the owner
 * and the members who KEEP access. `removedMemberId` loses access. */
async function rotateCollection(
	deps: SharingDeps,
	state: SharingState,
	collection: SharingRegion["collections"][number],
	removedMemberId: string,
): Promise<SharingState> {
	const oldKey = requireCollectionKey(state, collection.id);
	const newKey = await deps.generateKey();

	// Re-wrap every wrapper record of this collection under the new key.
	const rewrapped: SharingRegion["wrappers"] = await Promise.all(
		state.region.wrappers.map(async (w) => {
			if (w.collectionId !== collection.id) return w;
			const dekB64 = await deps.decryptWithKey(oldKey, w.dekIv, w.wrappedDek);
			const wrapped = await deps.encryptWithKey(newKey, dekB64);
			return { ...w, dekIv: wrapped.iv, wrappedDek: wrapped.ciphertext };
		}),
	);

	const label = await deps.decryptWithKey(oldKey, collection.labelIv, collection.labelCiphertext);
	const newLabel = await deps.encryptWithKey(newKey, label);
	const ownerWrap = await deps.encryptWithVek(newKey);

	const keptMemberIds = collection.memberIds.filter((id) => id !== removedMemberId);
	const keyWraps: RegionKeyWrap[] = [
		{ target: "owner", iv: ownerWrap.iv, ciphertext: ownerWrap.ciphertext },
	];
	const collectionKeys = { ...state.collectionKeys, [collection.id]: newKey };
	for (const memberId of keptMemberIds) {
		const member = state.region.members.find((m) => m.id === memberId);
		if (!member) throw new Error(`unknown member in collection: ${memberId}`);
		const sealed = await deps.sealToMemberKey(member.publicKey, newKey);
		keyWraps.push({
			target: "member",
			memberId,
			ephemeralPub: sealed.ephemeralPub,
			iv: sealed.iv,
			ciphertext: sealed.ciphertext,
		});
	}

	return withCollection(
		{
			...state,
			collectionKeys,
			region: { ...state.region, wrappers: rewrapped },
		},
		{
			...collection,
			memberIds: keptMemberIds,
			labelIv: newLabel.iv,
			labelCiphertext: newLabel.ciphertext,
			keyWraps,
		},
	);
}

/** The synced-settings key the sharing region rides for convergence
 * (ticket: sharing-state convergence). The value is the region JSON, stamped
 * on every sharing change; devices adopt a newer remote region and refresh
 * their blob's region section from it. */
export const SHARING_REGION_SETTING = "sharing.region";

/** Adopt a (possibly newer) region from sync into the local sharing state:
 * recompute the collection keys this performer holds from the adopted region.
 * The owner opens every collection's owner wrap; a member opens the seals for
 * collections they belong to. */
export async function adoptSharedRegion(
	deps: SharingDeps,
	state: SharingState,
	region: SharingRegion,
): Promise<SharingState> {
	const collectionKeys: Record<string, string> = {};
	if (state.performer.role === "owner") {
		for (const collection of region.collections) {
			const wrap = collection.keyWraps.find((w) => w.target === "owner");
			if (wrap?.target !== "owner") continue;
			collectionKeys[collection.id] = await deps.decryptWithVek(wrap.iv, wrap.ciphertext);
		}
	} else {
		const member = state.performer;
		if (member.role !== "member" || !state.memberPrivateKeyB64) {
			throw new Error("member state without a member private key");
		}
		for (const collection of region.collections) {
			if (!collection.memberIds.includes(member.memberId)) continue;
			const seal = collection.keyWraps.find(
				(w) => w.target === "member" && w.memberId === member.memberId,
			);
			if (seal?.target !== "member") continue;
			collectionKeys[collection.id] = await deps.openMemberSeal(state.memberPrivateKeyB64, seal);
		}
	}
	return { ...state, region, collectionKeys };
}

/** Upsert one minimal index record (existence + stamp + tombstone, no content).
 * Any performer writes their own entries' records; convergence is the sync
 * layer's job (ADR-0003). */ export function upsertIndexEntry(
	state: SharingState,
	entry: { id: string; hlc: SharingRegion["index"][number]["hlc"]; deleted: boolean },
): SharingState {
	const existing = state.region.index.findIndex((e) => e.id === entry.id);
	const index =
		existing >= 0
			? state.region.index.map((e, i) => (i === existing ? entry : e))
			: [...state.region.index, entry];
	return { ...state, region: { ...state.region, index } };
}

/** Resolve an entry's DEK from its current wraps: the owner path (wrapped under
 * the vault key, from the entry payload) or the collection path (a wrapper
 * record, opened with the collection key). Exactly one must be available. */
export async function resolveEntryDek(
	deps: SharingDeps,
	state: SharingState,
	input:
		| { via: "vek"; entry: { dekIv: string; wrappedDek: string } }
		| { via: "collection"; entryId: string; collectionId: string },
): Promise<string> {
	if (input.via === "vek") {
		return deps.decryptWithVek(input.entry.dekIv, input.entry.wrappedDek);
	}
	const key = requireCollectionKey(state, input.collectionId);
	const wrapper = state.region.wrappers.find(
		(w) => w.entryId === input.entryId && w.collectionId === input.collectionId,
	);
	if (!wrapper) {
		throw new Error(
			`no wrapper record for entry ${input.entryId} in collection ${input.collectionId}`,
		);
	}
	return deps.decryptWithKey(key, wrapper.dekIv, wrapper.wrappedDek);
}

// --- state helpers -----------------------------------------------------------

function withCollection(
	state: SharingState,
	collection: SharingRegion["collections"][number] & { key?: string },
): SharingState {
	const { key, ...record } = collection;
	const collections = state.region.collections.some((c) => c.id === record.id)
		? state.region.collections.map((c) => (c.id === record.id ? record : c))
		: [...state.region.collections, record];
	return {
		...state,
		collectionKeys: key ? { ...state.collectionKeys, [record.id]: key } : state.collectionKeys,
		region: { ...state.region, collections },
	};
}

function withWrappers(state: SharingState, wrappers: SharingRegion["wrappers"]): SharingState {
	return { ...state, region: { ...state.region, wrappers } };
}
