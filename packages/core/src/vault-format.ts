// VLT vault blob format. See docs/vault-format.md.
//
// Structure: a registry of per-version codecs (`VaultFormat`). Adding a format
// version = adding an entry to `FORMATS` with its own magic/version; the
// first-version codec is never edited. Dispatch on the magic bytes happens in
// `findFormat`, which owns the centralized unknown-magic rejection.

import { z } from "zod";
import { HlcSchema } from "./sync/hlc";

export const MAGIC = new Uint8Array([0x56, 0x4c, 0x54, 0x31]);
export const VERSION = 0x02;
export const MAX_SLOTS = 16;

export const LEN_IV = 12;
export const LEN_SALT = 16;
export const LEN_VERIFIER = 32;
export const LEN_SLOT_ID = 16;
export const LEN_WRAP_IV = 12;
// 32-byte VEK + 16-byte GCM tag.
export const LEN_WRAPPED_VEK = 48;
// Sharing layer (ADR-0001): a 32-byte sharing/collection key + 16-byte GCM tag.
// Same length as the VEK wrap; a distinct name so the sharing key can never be
// accidentally treated as the vault key.
export const LEN_SHARING_KEY = 32;
export const LEN_WRAPPED_KEY = 48;
// WebAuthn `hmac-secret` requires a 32-byte salt (CTAP2 spec).
export const LEN_HMAC_SECRET_SALT = 32;

export const SLOT_KIND_PASSWORD = 0x01;
export const SLOT_KIND_WEBAUTHN = 0x02;
export const SLOT_KIND_RECOVERY = 0x03;
/** VLT2 member-device slots (ticket: member-key unlock path). Payloads are
 * byte-identical to their 0x01/0x02 counterparts; the kind records that the
 * wrapped key is a member master key, not the vault key. A member device's
 * vault carries only member slots; an owner's only owner slots — slots never
 * travel between devices. */
export const SLOT_KIND_MEMBER_PASSWORD = 0x04;
export const SLOT_KIND_MEMBER_WEBAUTHN = 0x05;

const TLV_PREFIX_LEN = 1 + 2; // kind + len
const PASSWORD_PAYLOAD_LEN = LEN_SLOT_ID + LEN_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;
const WEBAUTHN_FIXED_LEN =
	LEN_SLOT_ID + 2 + LEN_HMAC_SECRET_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;

const KNOWN_KINDS = [
	SLOT_KIND_PASSWORD,
	SLOT_KIND_WEBAUTHN,
	SLOT_KIND_RECOVERY,
	SLOT_KIND_MEMBER_PASSWORD,
	SLOT_KIND_MEMBER_WEBAUTHN,
];

/** Any Uint8Array, kept loose (Uint8Array<ArrayBufferLike>) to match the in-memory struct types. */
const u8 = z.custom<Uint8Array>((v) => v instanceof Uint8Array, "expected Uint8Array");

/** A fixed-length byte field; the label rides the error so callers can see which field failed. */
const bytes = (n: number, label: string) =>
	u8.refine((u) => u.length === n, { message: `${label} must be ${n} bytes` });

/** Master-password slot: KEK is an Argon2id derivation of the password. */
const PasswordSlotSchema = z.object({
	kind: z.literal(SLOT_KIND_PASSWORD),
	slotId: bytes(LEN_SLOT_ID, "slotId"),
	salt: bytes(LEN_SALT, "salt"),
	verifier: bytes(LEN_VERIFIER, "verifier"),
	wrapIv: bytes(LEN_WRAP_IV, "wrapIv"),
	wrappedVek: bytes(LEN_WRAPPED_VEK, "wrappedVek"),
});
export type PasswordSlot = z.infer<typeof PasswordSlotSchema>;

/** FIDO2 slot: KEK is HKDF over the authenticator's `hmac-secret`. credentialId is variable. */
const WebauthnSlotSchema = z.object({
	kind: z.literal(SLOT_KIND_WEBAUTHN),
	slotId: bytes(LEN_SLOT_ID, "slotId"),
	credentialId: u8.refine((u) => u.length >= 1 && u.length <= 0xffff, {
		message: "credentialId must be 1..65535 bytes",
	}),
	salt: bytes(LEN_HMAC_SECRET_SALT, "salt"),
	verifier: bytes(LEN_VERIFIER, "verifier"),
	wrapIv: bytes(LEN_WRAP_IV, "wrapIv"),
	wrappedVek: bytes(LEN_WRAPPED_VEK, "wrappedVek"),
});
export type WebauthnSlot = z.infer<typeof WebauthnSlotSchema>;

/** Offline recovery code. Byte-identical to a password slot; only the kind differs. */
const RecoverySlotSchema = z.object({
	kind: z.literal(SLOT_KIND_RECOVERY),
	slotId: bytes(LEN_SLOT_ID, "slotId"),
	salt: bytes(LEN_SALT, "salt"),
	verifier: bytes(LEN_VERIFIER, "verifier"),
	wrapIv: bytes(LEN_WRAP_IV, "wrapIv"),
	wrappedVek: bytes(LEN_WRAPPED_VEK, "wrappedVek"),
});
export type RecoverySlot = z.infer<typeof RecoverySlotSchema>;

/** Unknown slot kind, preserved verbatim for round-trip. The kind must not collide with a known one. */
const OpaqueSlotSchema = z.object({
	kind: z
		.number()
		.refine((k) => !KNOWN_KINDS.includes(k), { message: "opaque slot kind is reserved" }),
	payload: u8,
});
export type OpaqueSlot = z.infer<typeof OpaqueSlotSchema>;

/** A member-device password slot: same payload shape, but the wrapped key is
 * the member master key. Parsed as a password slot variant. */
const MemberPasswordSlotSchema = PasswordSlotSchema.extend({
	kind: z.literal(SLOT_KIND_MEMBER_PASSWORD),
});
export type MemberPasswordSlot = z.infer<typeof MemberPasswordSlotSchema>;

const MemberWebauthnSlotSchema = WebauthnSlotSchema.extend({
	kind: z.literal(SLOT_KIND_MEMBER_WEBAUTHN),
});
export type MemberWebauthnSlot = z.infer<typeof MemberWebauthnSlotSchema>;

const SlotSchema = z.union([
	PasswordSlotSchema,
	WebauthnSlotSchema,
	RecoverySlotSchema,
	MemberPasswordSlotSchema,
	MemberWebauthnSlotSchema,
	OpaqueSlotSchema,
]);
export type Slot = z.infer<typeof SlotSchema>;

/** One entry's ciphertext plus its wrapped per-entry DEK and its HLC stamp.
 * The stamp rides on the outer envelope (under the VEK but outside the per-entry
 * DEK) so the merge can compare versions without unwrapping any secret. */
export const EncryptedEntrySchema = z.object({
	id: z.string(),
	wrappedDek: z.string(),
	dekIv: z.string(),
	ciphertext: z.string(),
	iv: z.string(),
	hlc: HlcSchema,
});
export type EncryptedEntry = z.infer<typeof EncryptedEntrySchema>;

/** Decoded vault: unlock slots plus the encrypted entries blob. */
const VaultBlobSchema = z.object({
	slots: z
		.array(SlotSchema)
		.min(1, { message: "vault must have at least one slot" })
		.max(MAX_SLOTS, { message: `vault has more slots than the max of ${MAX_SLOTS}` }),
	entriesIv: bytes(LEN_IV, "entriesIv"),
	entriesCiphertext: u8,
});
export type VaultBlob = z.infer<typeof VaultBlobSchema>;

/** One format version: how a vault maps to bytes and back.
 * Adding a version = adding an entry to `FORMATS` below; nothing here is edited. */
export interface VaultFormat {
	/** Magic bytes that identify the format family. */
	magic: Uint8Array;
	/** Version byte that binds a verifier to this format version. */
	versionByte: number;
	/** Maximum slot count this version allows. */
	maxSlots: number;
	encode(blob: VaultBlob): Uint8Array;
	decode(bytes: Uint8Array): VaultBlob;
}

/** Slice the five fixed-length fields shared by password and recovery slots. */
function slicePasswordFields(payload: Uint8Array) {
	let off = 0;
	const slotId = payload.slice(off, off + LEN_SLOT_ID);
	off += LEN_SLOT_ID;
	const salt = payload.slice(off, off + LEN_SALT);
	off += LEN_SALT;
	const verifier = payload.slice(off, off + LEN_VERIFIER);
	off += LEN_VERIFIER;
	const wrapIv = payload.slice(off, off + LEN_WRAP_IV);
	off += LEN_WRAP_IV;
	const wrappedVek = payload.slice(off, off + LEN_WRAPPED_VEK);
	return { slotId, salt, verifier, wrapIv, wrappedVek };
}

/** Serialize a vault's slots + entries under the given format's header.
 * Shared by every version; per-version code only supplies the header constants. */
export function encodeVaultBlobWithFormat(fmt: VaultFormat, blob: VaultBlob): Uint8Array {
	const v = VaultBlobSchema.parse(blob);

	const slotPayloads = v.slots.map(encodeSlotPayload);
	let totalSlotsLen = 0;
	for (const payload of slotPayloads) {
		if (payload.length > 0xffff) {
			throw new Error(`slot payload too large (${payload.length} bytes, max 65535)`);
		}
		totalSlotsLen += TLV_PREFIX_LEN + payload.length;
	}

	const out = new Uint8Array(
		fmt.magic.length + 2 + totalSlotsLen + LEN_IV + v.entriesCiphertext.length,
	);
	let off = 0;
	out.set(fmt.magic, off);
	off += fmt.magic.length;
	out[off++] = fmt.versionByte;
	out[off++] = v.slots.length;
	for (let i = 0; i < v.slots.length; i++) {
		const slot = v.slots[i]!;
		const payload = slotPayloads[i]!;
		out[off++] = slot.kind;
		out[off++] = (payload.length >> 8) & 0xff;
		out[off++] = payload.length & 0xff;
		out.set(payload, off);
		off += payload.length;
	}
	out.set(v.entriesIv, off);
	off += LEN_IV;
	out.set(v.entriesCiphertext, off);
	return out;
}

/** Parse a blob under the given format, preserving unknown slot kinds.
 * Bounds checks guard the untrusted byte stream. The version check is owned
 * here (per format), so dispatch only needs to resolve the magic bytes. */
export function decodeVaultBlobWithFormat(fmt: VaultFormat, bytes: Uint8Array): VaultBlob {
	const headerLen = fmt.magic.length + 2; // magic + version + slotCount
	if (bytes.length < headerLen) {
		throw new Error(`vault blob too short: ${bytes.length} bytes (need at least ${headerLen})`);
	}

	for (let i = 0; i < fmt.magic.length; i++) {
		if (bytes[i] !== fmt.magic[i]) {
			throw new Error("invalid vault magic bytes (not a VLT file)");
		}
	}

	const version = bytes[fmt.magic.length];
	if (version !== fmt.versionByte) {
		throw new Error(`unsupported vault version: ${version} (expected ${fmt.versionByte})`);
	}

	const slotCount = bytes[fmt.magic.length + 1]!;
	if (slotCount === 0) {
		throw new Error("vault has no slots");
	}
	if (slotCount > fmt.maxSlots) {
		throw new Error(`vault has ${slotCount} slots (max ${fmt.maxSlots})`);
	}

	const slots: Slot[] = [];
	let off = headerLen;
	for (let i = 0; i < slotCount; i++) {
		if (off + TLV_PREFIX_LEN > bytes.length) {
			throw new Error(`slot ${i} truncated (header overruns blob)`);
		}
		const kind = bytes[off++]!;
		const len = ((bytes[off]! << 8) | bytes[off + 1]!) & 0xffff;
		off += 2;
		if (off + len > bytes.length) {
			throw new Error(`slot ${i} truncated (payload overruns blob)`);
		}
		const payload = bytes.slice(off, off + len);
		off += len;
		slots.push(decodeSlotPayload(kind, payload));
	}

	if (off + LEN_IV > bytes.length) {
		throw new Error("vault blob truncated (entries IV overruns blob)");
	}
	const entriesIv = bytes.slice(off, off + LEN_IV);
	off += LEN_IV;
	const entriesCiphertext = bytes.slice(off);

	return { slots, entriesIv, entriesCiphertext };
}

/** Magic+version bytes that bind a verifier to the given format version. */
export function verifierPrefixFor(fmt: VaultFormat): Uint8Array {
	const out = new Uint8Array(fmt.magic.length + 1);
	out.set(fmt.magic, 0);
	out[fmt.magic.length] = fmt.versionByte;
	return out;
}

/** The registered first version of the VLT format. */
export const VLT1: VaultFormat = {
	magic: MAGIC,
	versionByte: VERSION,
	maxSlots: MAX_SLOTS,
	encode: (blob) => encodeVaultBlobWithFormat(VLT1, blob),
	decode: (bytes) => decodeVaultBlobWithFormat(VLT1, bytes),
};

// ---------------------------------------------------------------------------
// VLT2: the sharing-enabled format (ADR-0001/0002/0003/0007).
//
// Sharing adds three things to the container, as an additive layer over the
// VLT1 structure: outer records wrapping a random sharing key (SHK) for the
// owner (under the vault key) and each member (under that member's key); a
// sharing region encrypted under the SHK, readable by everyone who holds the
// SHK; and nothing else — the slots and the outer entries blob keep the VLT1
// roles. A member's device encrypts the outer entries blob under the key its
// own slots provide (a member key), so the container stays one shape.
//
// The region carries only what the sharing layer needs: the minimal index
// (existence + stamps + tombstones for every entry — no content), collections
// with labels sealed under their collection key, per-entry wrapper records
// (the entry's DEK wrapped under a collection key), and member records.
// ---------------------------------------------------------------------------

export const VLT2_MAGIC = new Uint8Array([0x56, 0x4c, 0x54, 0x32]);
export const VLT2_VERSION = 0x01;

/** Outer record: the SHK wrapped for the owner (under the vault key). */
export const SHARING_WRAP_KIND_VEK = 0x01;
/** Outer record: the SHK wrapped for one member (under that member's key). */
export const SHARING_WRAP_KIND_MEMBER = 0x02;

/** X25519 public key of the ephemeral sealing key (base64 length in bytes).
 * Seals bind the derived AES key to BOTH public keys via HKDF, so a seal
 * cannot be replayed against a different key pair (ADR-0002). */
const EPH_PUB_LEN = 32;

/** The owner wrap encrypts the sharing key's base64 text (44 chars) under the
 * vault key: 44 + 16 GCM tag. The member wrap seals the raw 32 bytes: 48. */
const LEN_WRAPPED_SHK_OWNER = 60;

/** A copy of the sharing key wrapped for one reader. Lives OUTSIDE the region:
 * a member needs it to read the region, so it cannot live inside it. */
const SharingWrapSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal(SHARING_WRAP_KIND_VEK),
		iv: bytes(LEN_IV, "iv"),
		wrappedShk: bytes(LEN_WRAPPED_SHK_OWNER, "wrappedShk"),
	}),
	z.object({
		kind: z.literal(SHARING_WRAP_KIND_MEMBER),
		memberId: z.string().min(1),
		ephemeralPub: bytes(EPH_PUB_LEN, "ephemeralPub"),
		iv: bytes(LEN_IV, "iv"),
		wrappedShk: bytes(LEN_WRAPPED_KEY, "wrappedShk"),
	}),
]);
export type SharingWrap = z.infer<typeof SharingWrapSchema>;

/** Minimal index record: existence, stamp, tombstone. No content, ever. */
const RegionIndexEntrySchema = z.object({
	id: z.string().min(1),
	hlc: HlcSchema,
	deleted: z.boolean(),
});
export type RegionIndexEntry = z.infer<typeof RegionIndexEntrySchema>;

/** A collection key sealed for a reader: the owner (under the vault key) or a
 * member (X25519 seal to their member key). Lives with its collection. */
export const RegionKeyWrapSchema = z.discriminatedUnion("target", [
	z.object({
		target: z.literal("owner"),
		iv: z.string(),
		ciphertext: z.string(),
	}),
	z.object({
		target: z.literal("member"),
		memberId: z.string().min(1),
		ephemeralPub: z.string().min(1),
		iv: z.string(),
		ciphertext: z.string(),
	}),
]);
export type RegionKeyWrap = z.infer<typeof RegionKeyWrapSchema>;

/** A collection: label sealed under the collection key, membership by member id,
 * and the collection key wrapped for every reader (owner + members). */
const RegionCollectionSchema = z.object({
	id: z.string().min(1),
	labelIv: z.string(),
	labelCiphertext: z.string(),
	memberIds: z.array(z.string().min(1)),
	keyWraps: z.array(RegionKeyWrapSchema),
});
export type RegionCollection = z.infer<typeof RegionCollectionSchema>;

/** The entry's DEK wrapped under a collection's key. Travels with the sharing
 * layer, so a member can open the entry without ever seeing the vault key. */
const RegionWrapperSchema = z.object({
	entryId: z.string().min(1),
	collectionId: z.string().min(1),
	dekIv: z.string(),
	wrappedDek: z.string(),
});
export type RegionWrapper = z.infer<typeof RegionWrapperSchema>;

/** A member: person-level X25519 key (base64), attested by device keys per ADR-0002. */
const RegionMemberSchema = z.object({
	id: z.string().min(1),
	publicKey: z.string().min(1),
	/** Ed25519 device-key signature binding this member key (base64). Optional
	 * through the rollout, like roster signatures. */
	attestation: z.string().min(1).optional(),
});
export type RegionMember = z.infer<typeof RegionMemberSchema>;

/** The sharing region: the plaintext JSON inside `regionCiphertext`. Encrypted
 * under the SHK, so it is ciphertext at rest like everything else. */
export const SharingRegionSchema = z.object({
	index: z.array(RegionIndexEntrySchema),
	collections: z.array(RegionCollectionSchema),
	wrappers: z.array(RegionWrapperSchema),
	members: z.array(RegionMemberSchema),
});
export type SharingRegion = z.infer<typeof SharingRegionSchema>;

export function emptySharingRegion(): SharingRegion {
	return { index: [], collections: [], wrappers: [], members: [] };
}

/** A decoded VLT2 vault: the VLT1 fields plus the sharing layer. */
const Vlt2BlobSchema = VaultBlobSchema.extend({
	sharingWraps: z.array(SharingWrapSchema),
	regionIv: bytes(LEN_IV, "regionIv"),
	regionCiphertext: u8,
	/** Member-device-only secrets (the member's X25519 private key), encrypted
	 * under the key this device's slots provide. Absent on owner devices. */
	memberSecretsIv: bytes(LEN_IV, "memberSecretsIv").optional(),
	memberSecretsCiphertext: u8.optional(),
});
export type Vlt2Blob = z.infer<typeof Vlt2BlobSchema>;

const sharingWrapCountLen = 1; // uint8, wraps fit in one byte at member scale
const wrapFixedLen = LEN_IV + LEN_WRAPPED_SHK_OWNER; // owner wrap
const memberWrapFixedLen = LEN_IV + LEN_WRAPPED_KEY;

function encodeSharingWrap(wrap: SharingWrap): Uint8Array {
	const memberIdBytes =
		wrap.kind === SHARING_WRAP_KIND_MEMBER ? utf8Bytes(wrap.memberId) : new Uint8Array(0);
	if (memberIdBytes.length > 0xff) throw new Error("member id too long");
	const ephLen = wrap.kind === SHARING_WRAP_KIND_MEMBER ? EPH_PUB_LEN : 0;
	const fixedLen = wrap.kind === SHARING_WRAP_KIND_MEMBER ? memberWrapFixedLen : wrapFixedLen;
	const payload = new Uint8Array(
		(wrap.kind === SHARING_WRAP_KIND_MEMBER ? 1 : 0) + memberIdBytes.length + ephLen + fixedLen,
	);
	let off = 0;
	if (wrap.kind === SHARING_WRAP_KIND_MEMBER) {
		payload[off++] = memberIdBytes.length;
		payload.set(memberIdBytes, off);
		off += memberIdBytes.length;
		payload.set(wrap.ephemeralPub, off);
		off += EPH_PUB_LEN;
	}
	payload.set(wrap.iv, off);
	off += LEN_IV;
	payload.set(wrap.wrappedShk, off);
	return payload;
}

function decodeSharingWrap(kind: number, payload: Uint8Array): SharingWrap {
	if (kind === SHARING_WRAP_KIND_VEK) {
		if (payload.length !== wrapFixedLen) {
			// owner wrap: iv + base64-key ciphertext
			throw new Error(`sharing wrap (owner) payload length mismatch: ${payload.length}`);
		}
		return SharingWrapSchema.parse({
			kind,
			iv: payload.slice(0, LEN_IV),
			wrappedShk: payload.slice(LEN_IV),
		});
	}
	if (kind === SHARING_WRAP_KIND_MEMBER) {
		if (payload.length < 1 + EPH_PUB_LEN + memberWrapFixedLen) {
			throw new Error(`sharing wrap (member) payload too short: ${payload.length}`);
		}
		const memberIdLen = payload[0]!;
		if (1 + memberIdLen + EPH_PUB_LEN + memberWrapFixedLen !== payload.length) {
			throw new Error(`sharing wrap (member) payload length mismatch (memberIdLen=${memberIdLen})`);
		}
		const decoder = new TextDecoder();
		return SharingWrapSchema.parse({
			kind,
			memberId: decoder.decode(payload.slice(1, 1 + memberIdLen)),
			ephemeralPub: payload.slice(1 + memberIdLen, 1 + memberIdLen + EPH_PUB_LEN),
			iv: payload.slice(1 + memberIdLen + EPH_PUB_LEN, 1 + memberIdLen + EPH_PUB_LEN + LEN_IV),
			wrappedShk: payload.slice(1 + memberIdLen + EPH_PUB_LEN + LEN_IV),
		});
	}
	throw new Error(`unknown sharing wrap kind: ${kind}`);
}

function utf8Bytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

/** Serialize a VLT2 vault. The outer entries blob keeps the VLT1 role; the
 * sharing wraps and the region are additive trailing structures. */
function encodeVlt2(blob: Vlt2Blob): Uint8Array {
	const v = Vlt2BlobSchema.parse(blob);

	const slotPayloads = v.slots.map(encodeSlotPayload);
	let totalSlotsLen = 0;
	for (const payload of slotPayloads) {
		if (payload.length > 0xffff) {
			throw new Error(`slot payload too large (${payload.length} bytes, max 65535)`);
		}
		totalSlotsLen += TLV_PREFIX_LEN + payload.length;
	}
	if (v.sharingWraps.length > 0xff) throw new Error("too many sharing wraps");

	const wrapPayloads = v.sharingWraps.map(encodeSharingWrap);
	let totalWrapsLen = 0;
	for (const payload of wrapPayloads) {
		if (payload.length > 0xffff) {
			throw new Error(`sharing wrap payload too large (${payload.length} bytes, max 65535)`);
		}
		totalWrapsLen += TLV_PREFIX_LEN + payload.length;
	}

	const entriesLen = LEN_IV + v.entriesCiphertext.length;
	if (entriesLen > 0xffffffff) throw new Error("entries blob too large");

	const headerLen = VLT2_MAGIC.length + 2 + sharingWrapCountLen;
	const memberSecrets =
		v.memberSecretsIv && v.memberSecretsCiphertext
			? { flag: 1, iv: v.memberSecretsIv, ct: v.memberSecretsCiphertext }
			: null;
	// The flag byte is always present (0 = no member secrets) so the trailing
	// region's first byte is never ambiguous with it.
	const memberSecretsLen = memberSecrets ? 4 + LEN_IV + memberSecrets.ct.length : 0;
	const out = new Uint8Array(
		headerLen +
			totalSlotsLen +
			totalWrapsLen +
			4 +
			entriesLen +
			1 +
			memberSecretsLen +
			LEN_IV +
			v.regionCiphertext.length,
	);
	let off = 0;
	out.set(VLT2_MAGIC, off);
	off += VLT2_MAGIC.length;
	out[off++] = VLT2_VERSION;
	out[off++] = v.slots.length;
	out[off++] = v.sharingWraps.length;
	for (let i = 0; i < v.slots.length; i++) {
		const slot = v.slots[i]!;
		const payload = slotPayloads[i]!;
		out[off++] = slot.kind;
		out[off++] = (payload.length >> 8) & 0xff;
		out[off++] = payload.length & 0xff;
		out.set(payload, off);
		off += payload.length;
	}
	for (let i = 0; i < v.sharingWraps.length; i++) {
		const wrap = v.sharingWraps[i]!;
		const payload = wrapPayloads[i]!;
		out[off++] = wrap.kind;
		out[off++] = (payload.length >> 8) & 0xff;
		out[off++] = payload.length & 0xff;
		out.set(payload, off);
		off += payload.length;
	}
	const entriesLenBe = new DataView(new ArrayBuffer(4));
	entriesLenBe.setUint32(0, entriesLen);
	out.set(new Uint8Array(entriesLenBe.buffer), off);
	off += 4;
	out.set(v.entriesIv, off);
	off += LEN_IV;
	out.set(v.entriesCiphertext, off);
	off += v.entriesCiphertext.length;
	out[off++] = memberSecrets ? 1 : 0;
	if (memberSecrets) {
		const msLenBe = new DataView(new ArrayBuffer(4));
		msLenBe.setUint32(0, LEN_IV + memberSecrets.ct.length);
		out.set(new Uint8Array(msLenBe.buffer), off);
		off += 4;
		out.set(memberSecrets.iv, off);
		off += LEN_IV;
		out.set(memberSecrets.ct, off);
		off += memberSecrets.ct.length;
	}
	out.set(v.regionIv, off);
	off += LEN_IV;
	out.set(v.regionCiphertext, off);
	return out;
}

/** Parse a VLT2 vault. Bounds checks guard the untrusted byte stream. */
function decodeVlt2(bytes: Uint8Array): Vlt2Blob {
	const headerLen = VLT2_MAGIC.length + 2 + sharingWrapCountLen;
	if (bytes.length < headerLen) {
		throw new Error(`vault blob too short: ${bytes.length} bytes (need at least ${headerLen})`);
	}

	const version = bytes[VLT2_MAGIC.length];
	if (version !== VLT2_VERSION) {
		throw new Error(`unsupported vault version: ${version} (expected ${VLT2_VERSION})`);
	}

	const slotCount = bytes[VLT2_MAGIC.length + 1]!;
	if (slotCount === 0) {
		throw new Error("vault has no slots");
	}
	if (slotCount > MAX_SLOTS) {
		throw new Error(`vault has ${slotCount} slots (max ${MAX_SLOTS})`);
	}

	let off = VLT2_MAGIC.length + 2;
	const sharingWrapCount = bytes[off++]!;
	const slots: Slot[] = [];
	for (let i = 0; i < slotCount; i++) {
		if (off + TLV_PREFIX_LEN > bytes.length) {
			throw new Error(`slot ${i} truncated (header overruns blob)`);
		}
		const kind = bytes[off++]!;
		const len = ((bytes[off]! << 8) | bytes[off + 1]!) & 0xffff;
		off += 2;
		if (off + len > bytes.length) {
			throw new Error(`slot ${i} truncated (payload overruns blob)`);
		}
		slots.push(decodeSlotPayload(kind, bytes.slice(off, off + len)));
		off += len;
	}
	const sharingWraps: SharingWrap[] = [];
	for (let i = 0; i < sharingWrapCount; i++) {
		if (off + TLV_PREFIX_LEN > bytes.length) {
			throw new Error(`sharing wrap ${i} truncated (header overruns blob)`);
		}
		const kind = bytes[off++]!;
		const len = ((bytes[off]! << 8) | bytes[off + 1]!) & 0xffff;
		off += 2;
		if (off + len > bytes.length) {
			throw new Error(`sharing wrap ${i} truncated (payload overruns blob)`);
		}
		sharingWraps.push(decodeSharingWrap(kind, bytes.slice(off, off + len)));
		off += len;
	}

	if (off + 4 > bytes.length) {
		throw new Error("vault blob truncated (entries length overruns blob)");
	}
	const entriesLen = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0);
	off += 4;
	if (entriesLen < LEN_IV || off + entriesLen > bytes.length) {
		throw new Error(
			`entries blob length invalid: ${entriesLen} (blob has ${bytes.length - off} bytes left)`,
		);
	}
	const entriesIv = bytes.slice(off, off + LEN_IV);
	off += LEN_IV;
	const entriesCiphertext = bytes.slice(off, off + entriesLen - LEN_IV);
	off += entriesLen - LEN_IV;

	// Member secrets: 1-byte flag (always present); when set, u32 length + iv + ciphertext.
	let memberSecretsIv: Uint8Array | undefined;
	let memberSecretsCiphertext: Uint8Array | undefined;
	{
		if (off + 1 > bytes.length) {
			throw new Error("vault blob truncated (member secrets flag overruns blob)");
		}
		const flag = bytes[off++]!;
		if (flag === 1) {
			if (off + 4 > bytes.length) {
				throw new Error("vault blob truncated (member secrets length overruns blob)");
			}
			const msLen = new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0);
			off += 4;
			if (msLen < LEN_IV || off + msLen > bytes.length) {
				throw new Error(`member secrets length invalid: ${msLen}`);
			}
			memberSecretsIv = bytes.slice(off, off + LEN_IV);
			off += LEN_IV;
			memberSecretsCiphertext = bytes.slice(off, off + msLen - LEN_IV);
			off += msLen - LEN_IV;
		}
	}

	if (off + LEN_IV > bytes.length) {
		throw new Error("vault blob truncated (region IV overruns blob)");
	}
	const regionIv = bytes.slice(off, off + LEN_IV);
	off += LEN_IV;
	const regionCiphertext = bytes.slice(off);

	return Vlt2BlobSchema.parse({
		slots,
		sharingWraps,
		entriesIv,
		entriesCiphertext,
		memberSecretsIv,
		memberSecretsCiphertext,
		regionIv,
		regionCiphertext,
	});
}

/** The registered sharing-enabled version (ADR-0007). */
export const VLT2: VaultFormat = {
	magic: VLT2_MAGIC,
	versionByte: VLT2_VERSION,
	maxSlots: MAX_SLOTS,
	encode: (blob) => encodeVlt2(blob as Vlt2Blob),
	decode: (bytes) => decodeVlt2(bytes),
};

/** All registered format versions, in dispatch order. Adding a version appends here. */
const FORMATS: VaultFormat[] = [VLT1, VLT2];

const MIN_DISPATCH_LEN = 4 + 2; // longest magic among versions + version + slotCount
/** The first three magic bytes identify the VLT family: a build that knows no
 * matching version can still say "newer app required" instead of "not a vault". */
const VLT_FAMILY_PREFIX = new Uint8Array([0x56, 0x4c, 0x54]);

function magicMatches(fmt: VaultFormat, bytes: Uint8Array): boolean {
	if (bytes.length < fmt.magic.length) return false;
	for (let i = 0; i < fmt.magic.length; i++) {
		if (bytes[i] !== fmt.magic[i]) return false;
	}
	return true;
}

/** Resolve the format version from a blob's magic bytes.
 * Centralized rejection: unknown magic fails here, once, with one message. */
export function findFormat(bytes: Uint8Array): VaultFormat {
	if (bytes.length < MIN_DISPATCH_LEN) {
		throw new Error(
			`vault blob too short: ${bytes.length} bytes (need at least ${MIN_DISPATCH_LEN})`,
		);
	}
	for (const fmt of FORMATS) {
		if (magicMatches(fmt, bytes)) return fmt;
	}
	if (
		magicMatches(
			{
				magic: VLT_FAMILY_PREFIX,
				versionByte: 0,
				maxSlots: 0,
				encode: () => new Uint8Array(0),
				decode: () => {
					throw new Error("unreachable");
				},
			},
			bytes,
		)
	) {
		throw new Error("sharing-enabled vault requires a newer version of the app");
	}
	throw new Error("invalid vault magic bytes (not a VLT file)");
}

/** A decoded vault with its format tag, so sharing-aware callers can narrow. */
export type DecodedVault = { format: "vlt1"; blob: VaultBlob } | { format: "vlt2"; blob: Vlt2Blob };

/** Serialize a vault to the first version's byte layout (the default for new vaults). */
export function encodeVaultBlob(blob: VaultBlob): Uint8Array {
	return VLT1.encode(blob);
}

/** Parse a vault blob, dispatching on the magic bytes to the right version. */
export function decodeVault(bytes: Uint8Array): DecodedVault {
	const fmt = findFormat(bytes);
	return fmt === VLT2
		? { format: "vlt2", blob: fmt.decode(bytes) as Vlt2Blob }
		: { format: "vlt1", blob: fmt.decode(bytes) };
}

/** Parse a vault blob to the base fields (shared by every version). */
export function decodeVaultBlob(bytes: Uint8Array): VaultBlob {
	return decodeVault(bytes).blob;
}

/** Magic+version bytes that bind a verifier to the current format version. */
export function verifierPrefix(): Uint8Array {
	return verifierPrefixFor(VLT1);
}

/** The five fixed-length fields shared by every password-shaped slot
 * (password, recovery, member-password). */
type PasswordShapedSlot = Pick<
	PasswordSlot,
	"slotId" | "salt" | "verifier" | "wrapIv" | "wrappedVek"
>;
type WebauthnShapedSlot = Pick<
	WebauthnSlot,
	"slotId" | "credentialId" | "salt" | "verifier" | "wrapIv" | "wrappedVek"
>;

function encodePasswordPayload(slot: PasswordShapedSlot): Uint8Array {
	const out = new Uint8Array(PASSWORD_PAYLOAD_LEN);
	let off = 0;
	out.set(slot.slotId, off);
	off += LEN_SLOT_ID;
	out.set(slot.salt, off);
	off += LEN_SALT;
	out.set(slot.verifier, off);
	off += LEN_VERIFIER;
	out.set(slot.wrapIv, off);
	off += LEN_WRAP_IV;
	out.set(slot.wrappedVek, off);
	return out;
}

function encodeWebauthnPayload(slot: WebauthnShapedSlot): Uint8Array {
	const out = new Uint8Array(WEBAUTHN_FIXED_LEN + slot.credentialId.length);
	let off = 0;
	out.set(slot.slotId, off);
	off += LEN_SLOT_ID;
	out[off++] = (slot.credentialId.length >> 8) & 0xff;
	out[off++] = slot.credentialId.length & 0xff;
	out.set(slot.credentialId, off);
	off += slot.credentialId.length;
	out.set(slot.salt, off);
	off += LEN_HMAC_SECRET_SALT;
	out.set(slot.verifier, off);
	off += LEN_VERIFIER;
	out.set(slot.wrapIv, off);
	off += LEN_WRAP_IV;
	out.set(slot.wrappedVek, off);
	return out;
}

// OpaqueSlot.kind is `number`, so the union doesn't discriminate at the type
// level; cast after the runtime kind check.
function encodeSlotPayload(slot: Slot): Uint8Array {
	if (slot.kind === SLOT_KIND_PASSWORD) return encodePasswordPayload(slot as PasswordSlot);
	if (slot.kind === SLOT_KIND_WEBAUTHN) return encodeWebauthnPayload(slot as WebauthnSlot);
	if (slot.kind === SLOT_KIND_RECOVERY) return encodePasswordPayload(slot as RecoverySlot);
	if (slot.kind === SLOT_KIND_MEMBER_PASSWORD) {
		return encodePasswordPayload(slot as MemberPasswordSlot);
	}
	if (slot.kind === SLOT_KIND_MEMBER_WEBAUTHN) {
		return encodeWebauthnPayload(slot as MemberWebauthnSlot);
	}
	return (slot as OpaqueSlot).payload;
}

function decodeWebauthnPayload(payload: Uint8Array): WebauthnSlot {
	if (payload.length < WEBAUTHN_FIXED_LEN + 1) {
		throw new Error(`webauthn slot payload too short: ${payload.length}`);
	}
	let off = LEN_SLOT_ID;
	const slotId = payload.slice(0, off);
	const credIdLen = ((payload[off]! << 8) | payload[off + 1]!) & 0xffff;
	off += 2;
	if (
		off + credIdLen + LEN_HMAC_SECRET_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK !==
		payload.length
	) {
		throw new Error(`webauthn slot payload length mismatch (credIdLen=${credIdLen})`);
	}
	const credentialId = payload.slice(off, off + credIdLen);
	off += credIdLen;
	const salt = payload.slice(off, off + LEN_HMAC_SECRET_SALT);
	off += LEN_HMAC_SECRET_SALT;
	const verifier = payload.slice(off, off + LEN_VERIFIER);
	off += LEN_VERIFIER;
	const wrapIv = payload.slice(off, off + LEN_WRAP_IV);
	off += LEN_WRAP_IV;
	const wrappedVek = payload.slice(off, off + LEN_WRAPPED_VEK);
	return WebauthnSlotSchema.parse({
		kind: SLOT_KIND_WEBAUTHN,
		slotId,
		credentialId,
		salt,
		verifier,
		wrapIv,
		wrappedVek,
	});
}

function decodeSlotPayload(kind: number, payload: Uint8Array): Slot {
	if (kind === SLOT_KIND_PASSWORD) {
		return PasswordSlotSchema.parse({ kind, ...slicePasswordFields(payload) });
	}
	if (kind === SLOT_KIND_WEBAUTHN) {
		return decodeWebauthnPayload(payload);
	}
	if (kind === SLOT_KIND_RECOVERY) {
		return RecoverySlotSchema.parse({ kind, ...slicePasswordFields(payload) });
	}
	if (kind === SLOT_KIND_MEMBER_PASSWORD) {
		return MemberPasswordSlotSchema.parse({ ...slicePasswordFields(payload), kind });
	}
	if (kind === SLOT_KIND_MEMBER_WEBAUTHN) {
		const decoded = decodeWebauthnPayload(payload);
		return MemberWebauthnSlotSchema.parse({ ...decoded, kind: SLOT_KIND_MEMBER_WEBAUTHN });
	}
	return { kind, payload };
}

/** The vault's password slot, or null if none. */
export function findPasswordSlot(blob: VaultBlob): PasswordSlot | null {
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_PASSWORD) return slot as PasswordSlot;
	}
	return null;
}

/** A member device's password slot, or null if none (owner slots never appear
 * on a member device and vice versa — slots never travel). */
export function findMemberPasswordSlot(blob: VaultBlob): MemberPasswordSlot | null {
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_MEMBER_PASSWORD) return slot as MemberPasswordSlot;
	}
	return null;
}

/** The password slot this device would unlock with: the owner's slot if
 * present, else the member slot. */
export function findUnlockPasswordSlot(blob: VaultBlob): PasswordSlot | MemberPasswordSlot | null {
	return findPasswordSlot(blob) ?? findMemberPasswordSlot(blob);
}

/** True if this blob's password slot is a member slot (a member device's vault). */
export function isMemberVault(blob: VaultBlob): boolean {
	return findMemberPasswordSlot(blob) !== null && findPasswordSlot(blob) === null;
}

/** All security-key slots on the vault. */
export function findWebauthnSlots(blob: VaultBlob): WebauthnSlot[] {
	const out: WebauthnSlot[] = [];
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_WEBAUTHN) out.push(slot as WebauthnSlot);
	}
	return out;
}

/** All recovery slots (backups, not primary unlock methods). At most one today. */
export function findRecoverySlots(blob: VaultBlob): RecoverySlot[] {
	const out: RecoverySlot[] = [];
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_RECOVERY) out.push(slot as RecoverySlot);
	}
	return out;
}
