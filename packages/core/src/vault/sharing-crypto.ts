// Sharing-layer crypto: AES-256-GCM under explicit keys (the sharing region,
// collection labels, wrapper records) and X25519 sealing of raw keys to member
// public keys. See ADR-0001/0002 and docs/research/family-sharing-key-models.md.
//
// This is TypeScript/WebCrypto, not the Rust core: the wasm could not be
// rebuilt in the environment where sharing was implemented (no Rust
// toolchain). It is written to mirror the core's naming and semantics so the
// move into core-rust is mechanical: same operations, same encodings, AES-256-
// GCM everywhere, HKDF-SHA256 key derivation for seals. The vault's own crypto
// (VEK/DEK/entries) is untouched and stays in the core.

import { x25519 } from "@noble/curves/ed25519.js";
import { base64ToBytes, bytesToBase64, bytesToHex } from "../util/bytes";

// crypto.subtle wants BufferSource; our Uint8Arrays are ArrayBufferLike-backed,
// which newer TS lib.dom types reject without a cast (same as sync/nostr.ts).
const buf = (b: Uint8Array): BufferSource => b as BufferSource;

const AES_ALGO = { name: "AES-GCM", length: 256 } as const;
/** Context string for the HKDF that turns an X25519 shared secret into an AES
 * key. Distinct uses must never share raw key bytes. */
const SEAL_INFO = "bramble-member-seal-v1";

/** A key sealed to a recipient's public key: ephemeral X25519 public key plus
 * the AES-GCM encrypted payload. All base64. */
export interface SealedKey {
	ephemeralPub: string;
	iv: string;
	ciphertext: string;
}

/** A random 32-byte symmetric key, base64. For sharing keys and collection keys. */
export async function generateKey(): Promise<string> {
	const key = crypto.getRandomValues(new Uint8Array(32));
	return bytesToBase64(key);
}

/** AES-256-GCM encrypt a UTF-8 string under an explicit 32-byte key (base64). */
export async function encryptWithKey(
	keyB64: string,
	plaintext: string,
): Promise<{ iv: string; ciphertext: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await crypto.subtle.importKey("raw", buf(base64ToBytes(keyB64)), AES_ALGO, false, [
		"encrypt",
	]);
	const ciphertext = await crypto.subtle.encrypt(
		{ ...AES_ALGO, iv: buf(iv) },
		key,
		buf(new TextEncoder().encode(plaintext)),
	);
	return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

/** AES-256-GCM decrypt under an explicit key. Rejects wrong keys via auth. */
export async function decryptWithKey(
	keyB64: string,
	iv: string,
	ciphertext: string,
): Promise<string> {
	const key = await crypto.subtle.importKey("raw", buf(base64ToBytes(keyB64)), AES_ALGO, false, [
		"decrypt",
	]);
	const plaintext = await crypto.subtle.decrypt(
		{ ...AES_ALGO, iv: buf(base64ToBytes(iv)) },
		key,
		buf(base64ToBytes(ciphertext)),
	);
	return new TextDecoder().decode(plaintext);
}

/** A member's X25519 keypair (ADR-0002), base64. */
export async function generateMemberKeypair(): Promise<{ publicKey: string; privateKey: string }> {
	const privateKey = x25519.keygen().secretKey;
	return {
		privateKey: bytesToBase64(privateKey),
		publicKey: bytesToBase64(x25519.getPublicKey(privateKey)),
	};
}

/** Seal a raw 32-byte key (base64) to a member's public key:
 * X25519 ECDH with an ephemeral key, HKDF-SHA256, AES-256-GCM. */
export async function sealToMemberKey(
	recipientPubB64: string,
	rawKeyB64: string,
): Promise<SealedKey> {
	const ephemeral = x25519.keygen();
	const recipient = base64ToBytes(recipientPubB64);
	const shared = x25519.getSharedSecret(ephemeral.secretKey, recipient);
	const key = await sealKeyFromShared(shared, ephemeral.publicKey, recipient);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ ...AES_ALGO, iv: buf(iv) },
		key,
		buf(base64ToBytes(rawKeyB64)),
	);
	return {
		ephemeralPub: bytesToBase64(ephemeral.publicKey),
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
	};
}

/** Open a seal with the member's private key; returns the raw key, base64. */
export async function openMemberSeal(privateKeyB64: string, sealed: SealedKey): Promise<string> {
	const privateKey = base64ToBytes(privateKeyB64);
	const ephemeralPub = base64ToBytes(sealed.ephemeralPub);
	const shared = x25519.getSharedSecret(privateKey, ephemeralPub);
	const key = await sealKeyFromShared(shared, ephemeralPub, x25519.getPublicKey(privateKey));
	const plaintext = await crypto.subtle.decrypt(
		{ ...AES_ALGO, iv: buf(base64ToBytes(sealed.iv)) },
		key,
		buf(base64ToBytes(sealed.ciphertext)),
	);
	return bytesToBase64(new Uint8Array(plaintext));
}

/** HKDF-SHA256 over the X25519 shared secret, salted with both public keys so
 * the derived key is bound to this exact exchange (prevents key substitution
 * across ephemeral/recipient pairs). */
async function sealKeyFromShared(
	shared: Uint8Array,
	ephemeralPub: Uint8Array,
	recipientPub: Uint8Array,
): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveBits"]);
	const salt = new Uint8Array(ephemeralPub.length + recipientPub.length);
	salt.set(ephemeralPub, 0);
	salt.set(recipientPub, ephemeralPub.length);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: buf(salt),
			info: buf(new TextEncoder().encode(SEAL_INFO)),
		},
		base,
		256,
	);
	return crypto.subtle.importKey("raw", bits, AES_ALGO, false, ["encrypt", "decrypt"]);
}

/** Short verifiable fingerprint of a member public key (ADR-0002): first 8
 * bytes of SHA-256, hex. Displayed and compared out of band. */
export async function memberKeyFingerprint(publicKeyB64: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buf(base64ToBytes(publicKeyB64)));
	return bytesToHex(new Uint8Array(digest).slice(0, 8));
}
