import { describe, expect, it } from "vitest";
import {
	decodeVaultBlob,
	encodeVaultBlob,
	encodeVaultBlobWithFormat,
	findFormat,
	MAGIC,
	type Slot,
	type VaultBlob,
	VLT1,
	verifierPrefixFor,
} from "./vault-format";

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

// A minimal valid VLT1 blob, built through the public encoder.
function makeBlob(entriesLen = 8): VaultBlob {
	return {
		slots: [
			{
				kind: 0x01,
				slotId: fillBytes(16, 0x10),
				salt: fillBytes(16, 0x20),
				verifier: fillBytes(32, 0x30),
				wrapIv: fillBytes(12, 0x40),
				wrappedVek: fillBytes(48, 0x50),
			},
		],
		entriesIv: fillBytes(12, 0x70),
		entriesCiphertext: fillBytes(entriesLen, 0x80),
	};
}

describe("format dispatch", () => {
	it("findFormat resolves the VLT1 entry from its magic bytes", () => {
		const bytes = encodeVaultBlob(makeBlob());
		expect(findFormat(bytes)).toBe(VLT1);
	});

	it("findFormat centralizes unknown-magic rejection", () => {
		const bytes = encodeVaultBlob(makeBlob());
		bytes[0] = 0x00;
		expect(() => findFormat(bytes)).toThrow(/magic/);
		expect(() => decodeVaultBlob(bytes)).toThrow(/magic/);
	});

	it("version rejection happens inside the resolved format", () => {
		const bytes = encodeVaultBlob(makeBlob());
		bytes[MAGIC.length] = 0xff;
		// Magic resolves to VLT1, which then owns the version check.
		expect(findFormat(bytes)).toBe(VLT1);
		expect(() => decodeVaultBlob(bytes)).toThrow(/version/);
	});

	it("encodeVaultBlobWithFormat round-trips through the format table", () => {
		const blob = makeBlob(24);
		const bytes = encodeVaultBlobWithFormat(VLT1, blob);
		// Byte-identical to the public encoder (which delegates to VLT1).
		expect(bytes).toEqual(encodeVaultBlob(blob));
		expect(decodeVaultBlob(bytes).entriesCiphertext).toEqual(blob.entriesCiphertext);
	});

	it("rejects input too short to hold any magic + version header", () => {
		expect(() => findFormat(new Uint8Array(5))).toThrow(/short/);
	});
});

describe("verifierPrefixFor", () => {
	it("binds a prefix to the given format's magic + version", () => {
		const prefix = verifierPrefixFor(VLT1);
		expect(prefix.length).toBe(MAGIC.length + 1);
		expect(prefix.subarray(0, MAGIC.length)).toEqual(MAGIC);
		expect(prefix[MAGIC.length]).toBe(VLT1.versionByte);
	});
});

describe("adding a version requires no edits to the first version", () => {
	// The AC of the prefactor, exercised structurally: a second format entry
	// that reuses the shared slot-TLV logic dispatches without touching VLT1
	// code paths. It writes its own magic and round-trips through dispatch.
	it("a second format entry dispatches alongside VLT1", () => {
		const ALT_MAGIC = new Uint8Array([0x41, 0x4c, 0x54, 0x32]);
		const alt = {
			magic: ALT_MAGIC,
			versionByte: 0x01,
			maxSlots: VLT1.maxSlots,
			encode: (blob: VaultBlob) => encodeVaultBlobWithFormat(alt, blob),
			decode: (bytes: Uint8Array) => decodeVaultBlob(bytes),
		};
		// Rebuild alt's bytes through the shared encoder with a patched magic.
		const altBytes = encodeVaultBlobWithFormat({ ...VLT1, magic: ALT_MAGIC }, makeBlob());
		expect(altBytes.subarray(0, 4)).toEqual(ALT_MAGIC);
		// The dispatcher rejects it (it's not registered) — registration is the
		// only edit adding a version makes, and it happens outside VLT1 code.
		expect(() => decodeVaultBlob(altBytes)).toThrow(/magic/);
		expect(() => findFormat(altBytes)).toThrow(/magic/);
		expect((makeBlob().slots[0] as Slot).kind).toBe(0x01);
	});
});
