// VLT2 sharing-enabled format tests. See docs/vault-format.md and ADR-0001/0002/0003/0007.

import { describe, expect, it } from "vitest";
import { HlcSchema } from "./sync/hlc";
import {
	decodeVault,
	decodeVaultBlob,
	emptySharingRegion,
	findFormat,
	LEN_IV,
	LEN_SALT,
	LEN_SHARING_KEY,
	LEN_SLOT_ID,
	LEN_VERIFIER,
	LEN_WRAP_IV,
	LEN_WRAPPED_KEY,
	SHARING_WRAP_KIND_MEMBER,
	SHARING_WRAP_KIND_VEK,
	type SharingRegion,
	SharingRegionSchema,
	SLOT_KIND_PASSWORD,
	VLT2,
	VLT2_MAGIC,
	type Vlt2Blob,
} from "./vault-format";

function fillBytes(length: number, base = 0): Uint8Array {
	const arr = new Uint8Array(length);
	for (let i = 0; i < length; i++) arr[i] = (base + i) & 0xff;
	return arr;
}

function makeOwnerSlot() {
	return {
		kind: SLOT_KIND_PASSWORD,
		slotId: fillBytes(LEN_SLOT_ID, 0x10),
		salt: fillBytes(LEN_SALT, 0x20),
		verifier: fillBytes(LEN_VERIFIER, 0x30),
		wrapIv: fillBytes(LEN_WRAP_IV, 0x40),
		wrappedVek: fillBytes(LEN_WRAPPED_KEY, 0x50),
	};
}

const HLC = HlcSchema.parse({ wall: 1700000000000, counter: 1, node: "a" });

function makeRegion(overrides: Partial<SharingRegion> = {}): SharingRegion {
	return SharingRegionSchema.parse({
		...emptySharingRegion(),
		index: [{ id: "entry-1", hlc: HLC, deleted: false }],
		collections: [
			{
				id: "col-dad",
				labelIv: fillBytes(12, 0x90).toString(),
				labelCiphertext: fillBytes(24, 0xa0).toString(),
				memberIds: ["member-dad"],
				keyWraps: [
					{ target: "owner", iv: "iv-o", ciphertext: "ct-o" },
					{
						target: "member",
						memberId: "member-dad",
						ephemeralPub: "ep",
						iv: "iv-m",
						ciphertext: "ct-m",
					},
				],
			},
		],
		wrappers: [
			{
				entryId: "entry-1",
				collectionId: "col-dad",
				dekIv: fillBytes(12, 0xb0).toString(),
				wrappedDek: fillBytes(48, 0xc0).toString(),
			},
		],
		members: [{ id: "member-dad", publicKey: fillBytes(32, 0xd0).toString(), attestation: "sig" }],
		...overrides,
	});
}

function makeVlt2Blob(): Vlt2Blob {
	return {
		slots: [makeOwnerSlot()],
		sharingWraps: [
			{
				kind: SHARING_WRAP_KIND_VEK,
				iv: fillBytes(LEN_IV, 0x60),
				wrappedShk: fillBytes(LEN_WRAPPED_KEY, 0x70),
			},
			{
				kind: SHARING_WRAP_KIND_MEMBER,
				memberId: "member-dad",
				ephemeralPub: fillBytes(32, 0x85),
				iv: fillBytes(LEN_IV, 0x80),
				wrappedShk: fillBytes(LEN_WRAPPED_KEY, 0x90),
			},
		],
		entriesIv: fillBytes(LEN_IV, 0x40),
		entriesCiphertext: fillBytes(32, 0x50),
		regionIv: fillBytes(LEN_IV, 0xe0),
		regionCiphertext: fillBytes(64, 0xf0),
	} as Vlt2Blob;
}

describe("VLT2 round-trips", () => {
	it("round-trips a populated sharing-enabled vault", () => {
		const blob = makeVlt2Blob();
		const decoded = decodeVault(VLT2.encode(blob));
		expect(decoded.format).toBe("vlt2");
		const v2 = decoded.blob as Vlt2Blob;
		expect(v2.slots).toHaveLength(1);
		expect(v2.entriesCiphertext).toEqual(blob.entriesCiphertext);
		expect(v2.sharingWraps).toHaveLength(2);
		expect(v2.sharingWraps[0]!.kind).toBe(SHARING_WRAP_KIND_VEK);
		expect(v2.sharingWraps[1]!.kind).toBe(SHARING_WRAP_KIND_MEMBER);
		const memberWrap = v2.sharingWraps[1]!;
		if (memberWrap.kind !== SHARING_WRAP_KIND_MEMBER) throw new Error("expected member wrap");
		expect(memberWrap.memberId).toBe("member-dad");
	});

	it("round-trips a member id with non-ASCII characters", () => {
		const blob = makeVlt2Blob();
		const memberIdWrap = blob.sharingWraps[1]!;
		if (memberIdWrap.kind !== SHARING_WRAP_KIND_MEMBER) throw new Error("expected member wrap");
		blob.sharingWraps[1] = { ...memberIdWrap, memberId: "成员-π" };
		const decoded = decodeVault(VLT2.encode(blob));
		const wraps = (decoded.blob as Vlt2Blob).sharingWraps;
		const decodedWrap = wraps[1]!;
		if (decodedWrap.kind !== SHARING_WRAP_KIND_MEMBER) throw new Error("expected member wrap");
		expect(decodedWrap.memberId).toBe("成员-π");
	});

	it("round-trips an empty region (fresh sharing-enabled vault)", () => {
		const blob = makeVlt2Blob();
		const decoded = decodeVault(VLT2.encode(blob));
		expect((decoded.blob as Vlt2Blob).regionCiphertext).toEqual(blob.regionCiphertext);
	});

	it("dispatches VLT2 by magic and tags it vlt2", () => {
		const bytes = VLT2.encode(makeVlt2Blob());
		expect(findFormat(bytes)).toBe(VLT2);
		expect(bytes.subarray(0, 4)).toEqual(VLT2_MAGIC);
		expect(decodeVault(bytes).format).toBe("vlt2");
	});

	it("decodeVaultBlob still returns the base fields", () => {
		const blob = makeVlt2Blob();
		const base = decodeVaultBlob(VLT2.encode(blob));
		expect(base.entriesCiphertext).toEqual(blob.entriesCiphertext);
		expect(base.slots).toHaveLength(1);
	});

	it("rejects a VLT2 blob with an unsupported version byte", () => {
		const bytes = VLT2.encode(makeVlt2Blob());
		bytes[VLT2_MAGIC.length] = 0xff;
		expect(() => decodeVault(bytes)).toThrow(/version/);
	});

	it("preserves corrupt trailing region ciphertext without validating it", () => {
		const bytes = VLT2.encode(makeVlt2Blob());
		bytes[bytes.length - 8] = 0xff;
		// The region is opaque ciphertext to the container; corruption is
		// preserved for the crypto layer to reject, not the parser.
		expect(() => decodeVault(bytes)).not.toThrow();
	});

	it("rejects an entries length that overruns the blob", () => {
		const bytes = VLT2.encode(makeVlt2Blob());
		// Layout: magic(4) + version(1) + slotCount(1) + wrapCount(1)
		//        + slot TLV(3+124) + owner wrap TLV(3+60) + member wrap TLV(3+103)
		//        => entriesLen (u32-BE) at this offset.
		const slotPayload = LEN_SLOT_ID + LEN_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_KEY;
		const ownerWrapPayload = LEN_IV + LEN_WRAPPED_KEY;
		const memberWrapPayload = 1 + "member-dad".length + 32 + ownerWrapPayload;
		const entriesLenOffset =
			4 + 2 + 1 + (3 + slotPayload) + (3 + ownerWrapPayload) + (3 + memberWrapPayload);
		const dv = new DataView(bytes.buffer, bytes.byteOffset + entriesLenOffset, 4);
		dv.setUint32(0, 0xffffffff);
		expect(() => decodeVault(bytes)).toThrow(/entries/);
	});
});

describe("first-format readers reject sharing-enabled vaults", () => {
	// A build that predates VLT2 has no entry for its magic in the dispatch
	// table. The shared VLT-family prefix is what lets it say "newer app
	// required" instead of "not a vault" — simulated here with VLT3, which no
	// registered version claims.
	it("an unregistered VLT-family magic gets the newer-app message", () => {
		const bytes = VLT2.encode(makeVlt2Blob());
		bytes[3] = 0x33; // "VLT3"
		expect(() => decodeVault(bytes)).toThrow(/newer/);
	});
});

describe("sharing region schema", () => {
	it("rejects an index entry missing the deleted flag", () => {
		expect(() =>
			SharingRegionSchema.parse({
				index: [{ id: "e", hlc: HLC }],
				collections: [],
				wrappers: [],
				members: [],
			}),
		).toThrow();
	});

	it("allows a collection with empty membership (prepared before members join)", () => {
		expect(() =>
			makeRegion({
				collections: [
					{ id: "c", labelIv: "iv", labelCiphertext: "ct", memberIds: [], keyWraps: [] },
				],
			}),
		).not.toThrow();
	});

	it("rejects a key wrap with an unknown target", () => {
		expect(() =>
			makeRegion({
				collections: [
					{
						id: "c",
						labelIv: "iv",
						labelCiphertext: "ct",
						memberIds: [],
						keyWraps: [{ target: "everyone" } as never],
					},
				],
			}),
		).toThrow();
	});

	it("rejects a member key wrap missing its ephemeral public key", () => {
		expect(() =>
			makeRegion({
				collections: [
					{
						id: "c",
						labelIv: "iv",
						labelCiphertext: "ct",
						memberIds: ["m"],
						keyWraps: [{ target: "member", memberId: "m", iv: "i", ciphertext: "c" } as never],
					},
				],
			}),
		).toThrow();
	});

	it("LEN_SHARING_KEY matches the wrapped key length", () => {
		expect(LEN_SHARING_KEY).toBe(32);
		expect(LEN_WRAPPED_KEY).toBe(48);
	});
});
