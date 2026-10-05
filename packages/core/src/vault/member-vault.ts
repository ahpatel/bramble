// Member-device unlock and state assembly (ADR-0002, ticket: member-key unlock
// path). After a member slot yields the member master key (MMK), the member's
// device uses it exactly like an owner uses the vault key for everything
// device-local (outer entries blob, entry DEKs), and additionally opens the
// sharing chain: the X25519 member key from the member secrets blob, the
// sharing key from its seal, the region, and the collection keys from their
// seals. The result is a member-performer SharingState.

import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import type { Vlt2Blob } from "../vault-format";
import {
	isMemberVault,
	SHARING_WRAP_KIND_MEMBER,
	SLOT_KIND_MEMBER_PASSWORD,
	type Slot,
	VLT2,
	verifierPrefix,
} from "../vault-format";
import type { ProcessedMemberJoin } from "./member-invite";
import type { SharingDeps, SharingState } from "./sharing-mutations";

/** Device-local member secrets: the member id and the X25519 private key
 * (ADR-0002), encrypted under the member master key inside the member's blob.
 * Never synced as plaintext and never visible to the owner. */
export interface MemberSecrets {
	memberId: string;
	memberPrivateKey: string;
}

export async function encryptMemberSecrets(
	deps: Pick<SharingDeps, "encryptWithKey">,
	memberMasterKeyB64: string,
	secrets: MemberSecrets,
): Promise<{ iv: string; ciphertext: string }> {
	return deps.encryptWithKey(memberMasterKeyB64, JSON.stringify(secrets));
}

export async function decryptMemberSecrets(
	deps: Pick<SharingDeps, "decryptWithKey">,
	memberMasterKeyB64: string,
	blob: Vlt2Blob,
): Promise<MemberSecrets> {
	if (!blob.memberSecretsIv || !blob.memberSecretsCiphertext) {
		throw new Error("this vault has no member secrets (not a member device's copy)");
	}
	return JSON.parse(
		await deps.decryptWithKey(
			memberMasterKeyB64,
			bytesToBase64(blob.memberSecretsIv),
			bytesToBase64(blob.memberSecretsCiphertext),
		),
	) as MemberSecrets;
}

/** Assemble the member's SharingState from their blob and unlocked MMK.
 * Opens the member secrets, the sharing key seal, the region, and every
 * collection key seal for collections the member belongs to. */
export async function buildMemberSharingState(
	deps: Pick<SharingDeps, "decryptWithKey" | "openMemberSeal">,
	{ blob, memberMasterKeyB64 }: { blob: Vlt2Blob; memberMasterKeyB64: string },
): Promise<SharingState> {
	if (!isMemberVault(blob)) {
		throw new Error("not a member vault (no member slots)");
	}
	const secrets = await decryptMemberSecrets(deps, memberMasterKeyB64, blob);

	const wrap = blob.sharingWraps.find(
		(w) => w.kind === SHARING_WRAP_KIND_MEMBER && w.memberId === secrets.memberId,
	);
	if (!wrap || wrap.kind !== SHARING_WRAP_KIND_MEMBER) {
		throw new Error(`no sharing key seal for member ${secrets.memberId}`);
	}
	const shkB64 = await deps.openMemberSeal(secrets.memberPrivateKey, {
		ephemeralPub: bytesToBase64(wrap.ephemeralPub),
		iv: bytesToBase64(wrap.iv),
		ciphertext: bytesToBase64(wrap.wrappedShk),
	});

	const region = JSON.parse(
		await deps.decryptWithKey(
			shkB64,
			bytesToBase64(blob.regionIv),
			bytesToBase64(blob.regionCiphertext),
		),
	) as SharingState["region"];

	const collectionKeys: Record<string, string> = {};
	for (const collection of region.collections) {
		if (!collection.memberIds.includes(secrets.memberId)) continue;
		const seal = collection.keyWraps.find(
			(w) => w.target === "member" && w.memberId === secrets.memberId,
		);
		if (seal?.target !== "member") {
			throw new Error(`missing collection key seal for ${collection.id}`);
		}
		collectionKeys[collection.id] = await deps.openMemberSeal(secrets.memberPrivateKey, seal);
	}

	return {
		shkB64,
		sharingWraps: blob.sharingWraps,
		region,
		collectionKeys,
		memberPrivateKeyB64: secrets.memberPrivateKey,
		performer: { role: "member", memberId: secrets.memberId },
	};
}

/** Wrap an entry's DEK under the member master key for local storage: the
 * member-side counterpart of the owner's DEK-under-VEK wrapping. Used when a
 * shared entry arrives and when the member creates a private entry. */
export async function wrapDekForMemberStorage(
	deps: Pick<SharingDeps, "encryptWithKey">,
	memberMasterKeyB64: string,
	dekB64: string,
): Promise<{ dekIv: string; wrappedDek: string }> {
	const wrapped = await deps.encryptWithKey(memberMasterKeyB64, dekB64);
	return { dekIv: wrapped.iv, wrappedDek: wrapped.ciphertext };
}

/** The member's private key, back from storage form. */
export function memberPrivateKeyFromSecrets(secrets: MemberSecrets): string {
	return secrets.memberPrivateKey;
}

/** Guard for callers that need the raw private key bytes. */
export function memberPrivateKeyBytes(secrets: MemberSecrets): Uint8Array {
	return base64ToBytes(secrets.memberPrivateKey);
}

/** Build the joining member's VLT2 vault blob: a member password slot wrapping
 * the MMK (the caller has loaded the MMK into its crypto context so the wrap
 * ops target it), plus the processed join's stored pieces. Mirrors
 * buildVaultBytes for the member side. */
export async function buildMemberVaultBytes(
	crypto: Pick<
		import("../adapters/crypto").CryptoAdapter,
		"generateSalt" | "generateSlotId" | "wrapVekPassword"
	>,
	password: string,
	processed: ProcessedMemberJoin,
): Promise<Uint8Array> {
	const saltB64 = await crypto.generateSalt();
	const slotIdB64 = await crypto.generateSlotId();
	const wrapped = await crypto.wrapVekPassword({
		password,
		saltB64,
		slotIdB64,
		magicVersion: verifierPrefix(),
	});
	const slot: Slot = {
		kind: SLOT_KIND_MEMBER_PASSWORD,
		slotId: base64ToBytes(slotIdB64),
		salt: base64ToBytes(saltB64),
		verifier: base64ToBytes(wrapped.verifier),
		wrapIv: base64ToBytes(wrapped.wrapIv),
		wrappedVek: base64ToBytes(wrapped.wrappedVek),
	};
	const blob: Vlt2Blob = {
		slots: [slot],
		sharingWraps: processed.sharingWraps,
		entriesIv: base64ToBytes(processed.entriesPayload.iv),
		entriesCiphertext: base64ToBytes(processed.entriesPayload.ciphertext),
		memberSecretsIv: base64ToBytes(processed.memberSecrets.iv),
		memberSecretsCiphertext: base64ToBytes(processed.memberSecrets.ciphertext),
		regionIv: base64ToBytes(processed.region.iv),
		regionCiphertext: base64ToBytes(processed.region.ciphertext),
	};
	return VLT2.encode(blob);
}
