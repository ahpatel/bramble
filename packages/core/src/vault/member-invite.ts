// The member enrollment bundle and both sides of processing it.
//
// A member join differs from a device join in one fundamental way: the
// joining device generates the key material (its X25519 member keypair and
// its member master key) and the owner can never know either. So the bundle
// carries no key in the clear — it carries SEALS made to the member's public
// key, which the joiner's hello delivered ahead of the bundle. The joiner
// opens the seals, re-wraps each shared entry's DEK under its own member
// master key for local storage, and rebuilds the vault pieces it stores.
//
// The bundle travels over the roster-authenticated Noise channel, like the
// device-join bundle's VEK does, so the region rides as plaintext there and
// is re-encrypted under the sharing key by the joiner for storage.

import { z } from "zod";
import { HlcSchema } from "../sync/hlc";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import {
	SHARING_WRAP_KIND_MEMBER,
	SHARING_WRAP_KIND_VEK,
	type SharingRegion,
	SharingRegionSchema,
	type SharingWrap,
} from "../vault-format";
import type { SealedKey } from "./sharing-crypto";
import type { SharingState } from "./sharing-mutations";

/** A sharing wrap in transport form: the binary fields as base64. */
export const WireSharingWrapSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal(SHARING_WRAP_KIND_VEK),
		ivB64: z.string().min(1),
		wrappedShkB64: z.string().min(1),
	}),
	z.object({
		kind: z.literal(SHARING_WRAP_KIND_MEMBER),
		memberId: z.string().min(1),
		ephemeralPubB64: z.string().min(1),
		ivB64: z.string().min(1),
		wrappedShkB64: z.string().min(1),
	}),
]);
export type WireSharingWrap = z.infer<typeof WireSharingWrapSchema>;

/** One shared entry's content as the joiner receives it: the DEK-encrypted
 * payload plus the stamp it was written with. The joiner re-wraps the DEK
 * under its member master key; the content bytes are untouched. */
export const InviteEntrySchema = z.object({
	entryId: z.string().min(1),
	ciphertext: z.string().min(1),
	iv: z.string().min(1),
	hlc: HlcSchema,
});
export type InviteEntry = z.infer<typeof InviteEntrySchema>;

export const MemberInviteBundleSchema = z.object({
	memberId: z.string().min(1),
	/** The member public key the seals were made to. The joiner checks it
	 * against its own generated keypair before opening anything. */
	memberPubKey: z.string().min(1),
	/** The full outer sharing-wrap list in transport form, including this
	 * member's new SHK seal. */
	sharingWraps: z.array(WireSharingWrapSchema),
	region: SharingRegionSchema,
	/** Content of every entry shared with the member at invite time. */
	entries: z.array(InviteEntrySchema),
	/** The inviter's device roster, so the joiner bootstraps sync membership
	 * exactly like a device join does (the joiner's own entry is added on top). */
	roster: z
		.object({
			devices: z.array(z.record(z.string(), z.unknown())),
			revoked: z.array(z.record(z.string(), z.unknown())),
		})
		.passthrough()
		.optional(),
});
export type MemberInviteBundle = z.infer<typeof MemberInviteBundleSchema>;

export function encodeMemberInviteBundle(bundle: MemberInviteBundle): string {
	return JSON.stringify(MemberInviteBundleSchema.parse(bundle));
}

export function decodeMemberInviteBundle(json: string): MemberInviteBundle {
	return MemberInviteBundleSchema.parse(JSON.parse(json));
}

export function sharingWrapToWire(wrap: SharingWrap): WireSharingWrap {
	if (wrap.kind === SHARING_WRAP_KIND_MEMBER) {
		return {
			kind: wrap.kind,
			memberId: wrap.memberId,
			ephemeralPubB64: bytesToBase64(wrap.ephemeralPub),
			ivB64: bytesToBase64(wrap.iv),
			wrappedShkB64: bytesToBase64(wrap.wrappedShk),
		};
	}
	return {
		kind: wrap.kind,
		ivB64: bytesToBase64(wrap.iv),
		wrappedShkB64: bytesToBase64(wrap.wrappedShk),
	};
}

export function sharingWrapFromWire(wrap: WireSharingWrap): SharingWrap {
	if (wrap.kind === SHARING_WRAP_KIND_MEMBER) {
		return {
			kind: wrap.kind,
			memberId: wrap.memberId,
			ephemeralPub: base64ToBytes(wrap.ephemeralPubB64),
			iv: base64ToBytes(wrap.ivB64),
			wrappedShk: base64ToBytes(wrap.wrappedShkB64),
		};
	}
	return {
		kind: wrap.kind,
		iv: base64ToBytes(wrap.ivB64),
		wrappedShk: base64ToBytes(wrap.wrappedShkB64),
	};
}

function toWire(wraps: SharingWrap[]): WireSharingWrap[] {
	return wraps.map(sharingWrapToWire);
}

/** Assemble the invite bundle (inviter side). The member must already be
 * registered (addMember) and any pre-granted collections must have their key
 * seals; this validates both before packing. The caller resolves the shared
 * entries' content: every entry with a wrapper in a collection the member
 * belongs to. */
export function buildMemberInvite(
	state: SharingState,
	input: {
		memberId: string;
		memberPubKey: string;
		entries: InviteEntry[];
	},
): MemberInviteBundle {
	if (state.performer.role !== "owner") {
		throw new Error("only the owner can build a member invite");
	}
	const member = state.region.members.find((m) => m.id === input.memberId);
	if (!member) throw new Error(`unknown member: ${input.memberId}`);
	if (member.publicKey !== input.memberPubKey) {
		throw new Error("member public key mismatch; re-run the invite");
	}
	const wrap = state.sharingWraps.find(
		(w) => w.kind === SHARING_WRAP_KIND_MEMBER && w.memberId === input.memberId,
	);
	if (!wrap) {
		throw new Error(`no sharing key seal for member ${input.memberId}; add the member first`);
	}
	for (const collection of state.region.collections) {
		if (!collection.memberIds.includes(input.memberId)) continue;
		if (!collection.keyWraps.some((w) => w.target === "member" && w.memberId === input.memberId)) {
			throw new Error(`collection ${collection.id} has no key seal for member ${input.memberId}`);
		}
	}
	return MemberInviteBundleSchema.parse({
		memberId: input.memberId,
		memberPubKey: input.memberPubKey,
		sharingWraps: toWire(state.sharingWraps),
		region: state.region,
		entries: input.entries,
	});
}

/** What the joining device writes into its new vault. */
export interface ProcessedMemberJoin {
	memberId: string;
	/** The outer sharing-wrap list to store in the blob (binary form). */
	sharingWraps: SharingWrap[];
	/** The sharing region, re-encrypted under the joiner's copy of the SHK. */
	region: { iv: string; ciphertext: string };
	/** The member's local entries payload (its shared entries), encrypted
	 * under the member master key. */
	entriesPayload: { iv: string; ciphertext: string };
	/** The member secrets blob (member id + X25519 private key) under the MMK. */
	memberSecrets: { iv: string; ciphertext: string };
	/** Working keys, for immediate use; never stored unencrypted. */
	shkB64: string;
	collectionKeys: Record<string, string>;
}

export interface ProcessMemberInviteDeps {
	openMemberSeal(privateKeyB64: string, sealed: SealedKey): Promise<string>;
	decryptWithKey(keyB64: string, iv: string, ciphertext: string): Promise<string>;
	encryptWithKey(keyB64: string, plaintext: string): Promise<{ iv: string; ciphertext: string }>;
}

/** Process the invite bundle (joiner side): open the seals, rebuild the local
 * vault pieces. `memberPublicKey` is the joiner's own generated public key —
 * a mismatch means the bundle was sealed for someone else and is rejected
 * before any seal is opened. */
export async function processMemberInvite(
	deps: ProcessMemberInviteDeps,
	input: {
		bundle: MemberInviteBundle;
		memberPrivateKey: string;
		memberPublicKey: string;
		memberMasterKeyB64: string;
	},
): Promise<ProcessedMemberJoin> {
	const { bundle } = input;
	if (bundle.memberPubKey !== input.memberPublicKey) {
		throw new Error("this invite was sealed for a different member key; generate a new code");
	}

	// 1. The member's copy of the sharing key, from their SHK seal.
	const shkWrap = bundle.sharingWraps.find(
		(w) => w.kind === SHARING_WRAP_KIND_MEMBER && w.memberId === bundle.memberId,
	);
	if (!shkWrap || shkWrap.kind !== SHARING_WRAP_KIND_MEMBER) {
		throw new Error("bundle has no sharing key seal for this member");
	}
	const shkB64 = await deps.openMemberSeal(input.memberPrivateKey, {
		ephemeralPub: shkWrap.ephemeralPubB64,
		iv: shkWrap.ivB64,
		ciphertext: shkWrap.wrappedShkB64,
	});

	// 2. Validate the region: this member must be registered, and every
	// collection they belong to must carry their key seal.
	const region: SharingRegion = SharingRegionSchema.parse(bundle.region);
	if (!region.members.some((m) => m.id === bundle.memberId)) {
		throw new Error("bundle region does not register this member");
	}
	const collectionKeys: Record<string, string> = {};
	for (const collection of region.collections) {
		if (!collection.memberIds.includes(bundle.memberId)) continue;
		const seal = collection.keyWraps.find(
			(w) => w.target === "member" && w.memberId === bundle.memberId,
		);
		if (seal?.target !== "member") {
			throw new Error(`collection ${collection.id} has no key seal for this member`);
		}
		collectionKeys[collection.id] = await deps.openMemberSeal(input.memberPrivateKey, seal);
	}

	// 3. Local entries: open each entry's DEK through a wrapper record, then
	// re-wrap it under the member master key for local storage.
	const localEntries = [];
	for (const entry of bundle.entries) {
		const wrapper = region.wrappers.find((w) => w.entryId === entry.entryId);
		if (!wrapper) {
			throw new Error(`entry ${entry.entryId} has no wrapper record for this member`);
		}
		const collectionKey = collectionKeys[wrapper.collectionId];
		if (!collectionKey) {
			throw new Error(
				`entry ${entry.entryId} references collection ${wrapper.collectionId} without a key`,
			);
		}
		const dekB64 = await deps.decryptWithKey(collectionKey, wrapper.dekIv, wrapper.wrappedDek);
		const local = await deps.encryptWithKey(input.memberMasterKeyB64, dekB64);
		localEntries.push({
			id: entry.entryId,
			ciphertext: entry.ciphertext,
			iv: entry.iv,
			wrappedDek: local.ciphertext,
			dekIv: local.iv,
			hlc: entry.hlc,
		});
	}
	const entriesPayload = await deps.encryptWithKey(
		input.memberMasterKeyB64,
		JSON.stringify({ entries: localEntries, tombstones: [] }),
	);

	// 4. Member secrets and the region, both under the MMK / SHK for storage.
	const memberSecrets = await deps.encryptWithKey(
		input.memberMasterKeyB64,
		JSON.stringify({ memberId: bundle.memberId, memberPrivateKey: input.memberPrivateKey }),
	);
	const regionEncrypted = await deps.encryptWithKey(shkB64, JSON.stringify(region));

	return {
		memberId: bundle.memberId,
		sharingWraps: bundle.sharingWraps.map(sharingWrapFromWire),
		region: regionEncrypted,
		entriesPayload,
		memberSecrets,
		shkB64,
		collectionKeys,
	};
}
