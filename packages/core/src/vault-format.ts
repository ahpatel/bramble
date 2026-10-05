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
// WebAuthn `hmac-secret` requires a 32-byte salt (CTAP2 spec).
export const LEN_HMAC_SECRET_SALT = 32;

export const SLOT_KIND_PASSWORD = 0x01;
export const SLOT_KIND_WEBAUTHN = 0x02;
export const SLOT_KIND_RECOVERY = 0x03;

const TLV_PREFIX_LEN = 1 + 2; // kind + len
const PASSWORD_PAYLOAD_LEN = LEN_SLOT_ID + LEN_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;
const WEBAUTHN_FIXED_LEN =
	LEN_SLOT_ID + 2 + LEN_HMAC_SECRET_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK;

const KNOWN_KINDS = [SLOT_KIND_PASSWORD, SLOT_KIND_WEBAUTHN, SLOT_KIND_RECOVERY];

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

const SlotSchema = z.union([
	PasswordSlotSchema,
	WebauthnSlotSchema,
	RecoverySlotSchema,
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

/** All registered format versions, in dispatch order. Adding a version appends here. */
const FORMATS: VaultFormat[] = [VLT1];

const MIN_DISPATCH_LEN = 4 + 2; // longest magic among versions + version + slotCount

/** Resolve the format version from a blob's magic bytes.
 * Centralized rejection: unknown magic fails here, once, with one message. */
export function findFormat(bytes: Uint8Array): VaultFormat {
	if (bytes.length < MIN_DISPATCH_LEN) {
		throw new Error(
			`vault blob too short: ${bytes.length} bytes (need at least ${MIN_DISPATCH_LEN})`,
		);
	}
	for (const fmt of FORMATS) {
		let match = true;
		for (let i = 0; i < fmt.magic.length; i++) {
			if (bytes[i] !== fmt.magic[i]) {
				match = false;
				break;
			}
		}
		if (match) return fmt;
	}
	throw new Error("invalid vault magic bytes (not a VLT file)");
}

/** Serialize a vault to the current format version's byte layout. */
export function encodeVaultBlob(blob: VaultBlob): Uint8Array {
	return VLT1.encode(blob);
}

/** Parse a vault blob, dispatching on the magic bytes to the right version. */
export function decodeVaultBlob(bytes: Uint8Array): VaultBlob {
	return findFormat(bytes).decode(bytes);
}

/** Magic+version bytes that bind a verifier to the current format version. */
export function verifierPrefix(): Uint8Array {
	return verifierPrefixFor(VLT1);
}

function encodePasswordPayload(slot: PasswordSlot | RecoverySlot): Uint8Array {
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

function encodeWebauthnPayload(slot: WebauthnSlot): Uint8Array {
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
	return { kind, payload };
}

/** The vault's password slot, or null if none. */
export function findPasswordSlot(blob: VaultBlob): PasswordSlot | null {
	for (const slot of blob.slots) {
		if (slot.kind === SLOT_KIND_PASSWORD) return slot as PasswordSlot;
	}
	return null;
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
