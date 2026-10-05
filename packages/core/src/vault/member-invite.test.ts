// Member invite round-trip tests: owner assembles a world, builds the invite
// bundle, the joiner processes it with its own freshly generated keys — and
// ends up able to open every shared entry without ever holding the vault key.

import { describe, expect, it } from "vitest";
import { HlcSchema } from "../sync/hlc";
import {
	buildMemberInvite,
	decodeMemberInviteBundle,
	encodeMemberInviteBundle,
	processMemberInvite,
} from "./member-invite";
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
	grantEntry,
	type SharingState,
} from "./sharing-mutations";

const TEST_VEK = bytesToBase64(new Uint8Array(32).fill(0xcd));

function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

const deps = createSharingDeps({
	encryptWithVek: (plaintext) => encryptWithKey(TEST_VEK, plaintext),
	decryptWithVek: (iv, ciphertext) => decryptWithKey(TEST_VEK, iv, ciphertext),
});

async function ownerWorld() {
	let state: SharingState = {
		shkB64: await generateKey(),
		sharingWraps: [],
		region: { index: [], collections: [], wrappers: [], members: [] },
		collectionKeys: {},
		performer: { role: "owner" },
	};
	state = await createCollection(deps, state, "Dad's banking");
	state = await createCollection(deps, state, "Family");
	const dad = await generateMemberKeypair();
	const wife = await generateMemberKeypair();
	state = await addMember(deps, state, { memberId: "dad", publicKey: dad.publicKey });
	state = await addMember(deps, state, { memberId: "wife", publicKey: wife.publicKey });
	const dadsBanking = state.region.collections[0]!;
	const family = state.region.collections[1]!;
	const dek1 = await generateKey();
	state = await grantEntry(deps, state, {
		entryId: "dad-bank",
		collectionId: dadsBanking.id,
		dekB64: dek1,
	});
	state = await addMemberToCollection(deps, state, {
		collectionId: dadsBanking.id,
		memberId: "dad",
	});
	const dek2 = await generateKey();
	state = await grantEntry(deps, state, {
		entryId: "netflix",
		collectionId: family.id,
		dekB64: dek2,
	});
	state = await addMemberToCollection(deps, state, { collectionId: family.id, memberId: "dad" });
	state = await addMemberToCollection(deps, state, { collectionId: family.id, memberId: "wife" });

	// The owner's local entry contents (DEK-encrypted), as the UI would read them.
	const content1 = await encryptWithKey(dek1, JSON.stringify({ title: "Dad bank" }));
	const content2 = await encryptWithKey(dek2, JSON.stringify({ title: "Netflix" }));
	return {
		state,
		dad,
		wife,
		dadsBanking,
		family,
		contents: {
			"dad-bank": { ciphertext: content1.ciphertext, iv: content1.iv, dek: dek1 },
			netflix: { ciphertext: content2.ciphertext, iv: content2.iv, dek: dek2 },
		},
	};
}

const HLC = HlcSchema.parse({ wall: 1700000000000, counter: 1, node: "a" });

describe("buildMemberInvite", () => {
	it("packs the sharing wraps, region, and this member's shared entries", async () => {
		const world = await ownerWorld();
		const bundle = buildMemberInvite(world.state, {
			memberId: "dad",
			memberPubKey: world.dad.publicKey,
			entries: [
				{
					entryId: "dad-bank",
					ciphertext: world.contents["dad-bank"].ciphertext,
					iv: world.contents["dad-bank"].iv,
					hlc: HLC,
				},
				{
					entryId: "netflix",
					ciphertext: world.contents.netflix.ciphertext,
					iv: world.contents.netflix.iv,
					hlc: HLC,
				},
			],
		});
		expect(bundle.memberId).toBe("dad");
		expect(bundle.sharingWraps.some((w) => w.kind === 2 && w.memberId === "dad")).toBe(true);
		// Only dad's collections are relevant; the region carries everything.
		expect(bundle.region.members).toHaveLength(2);
		// The bundle round-trips through JSON.
		expect(decodeMemberInviteBundle(encodeMemberInviteBundle(bundle))).toEqual(bundle);
	});

	it("refuses a public key that does not match the registered member", async () => {
		const world = await ownerWorld();
		const stranger = await generateMemberKeypair();
		expect(() =>
			buildMemberInvite(world.state, {
				memberId: "dad",
				memberPubKey: stranger.publicKey,
				entries: [],
			}),
		).toThrow(/mismatch/);
	});

	it("refuses an invite before the member is registered", async () => {
		const world = await ownerWorld();
		const stranger = await generateMemberKeypair();
		expect(() =>
			buildMemberInvite(world.state, {
				memberId: "nobody",
				memberPubKey: stranger.publicKey,
				entries: [],
			}),
		).toThrow(/unknown member/);
	});

	it("a member cannot build an invite", async () => {
		const world = await ownerStateAsMember();
		const stranger = await generateMemberKeypair();
		expect(() =>
			buildMemberInvite(world, { memberId: "x", memberPubKey: stranger.publicKey, entries: [] }),
		).toThrow(/owner/);
	});

	async function ownerStateAsMember(): Promise<SharingState> {
		const { state } = await ownerWorld();
		return { ...state, performer: { role: "member", memberId: "dad" } };
	}
});

describe("processMemberInvite", () => {
	async function joinFlow() {
		const world = await ownerWorld();
		const bundle = buildMemberInvite(world.state, {
			memberId: "dad",
			memberPubKey: world.dad.publicKey,
			entries: [
				{
					entryId: "dad-bank",
					ciphertext: world.contents["dad-bank"].ciphertext,
					iv: world.contents["dad-bank"].iv,
					hlc: HLC,
				},
				{
					entryId: "netflix",
					ciphertext: world.contents.netflix.ciphertext,
					iv: world.contents.netflix.iv,
					hlc: HLC,
				},
			],
		});
		// In the real flow the joining device generated this keypair and the
		// owner registered its public key — here, world.dad.
		const joinerMmk = await generateKey();
		// A keypair mismatch (e.g. the app regenerated) must be rejected.
		const stranger = await generateMemberKeypair();
		await expect(
			processMemberInvite(deps, {
				bundle,
				memberPrivateKey: stranger.privateKey,
				memberPublicKey: stranger.publicKey,
				memberMasterKeyB64: joinerMmk,
			}),
		).rejects.toThrow(/different member key/);
		const processed = await processMemberInvite(deps, {
			bundle,
			memberPrivateKey: world.dad.privateKey,
			memberPublicKey: world.dad.publicKey,
			memberMasterKeyB64: joinerMmk,
		});
		return { world, bundle, processed, joinerMmk };
	}

	it("yields the sharing key, collection keys, and stored pieces", async () => {
		const { world, processed } = await joinFlow();
		expect(processed.memberId).toBe("dad");
		expect(processed.shkB64).toBe(world.state.shkB64);
		expect(Object.keys(processed.collectionKeys).sort()).toEqual(
			[world.dadsBanking.id, world.family.id].sort(),
		);
		expect(processed.sharingWraps).toHaveLength(world.state.sharingWraps.length);
	});

	it("the joiner decrypts both shared entries from local storage", async () => {
		const { world, processed, joinerMmk } = await joinFlow();
		// The local entries payload decrypts under the member master key.
		const payload = JSON.parse(
			await decryptWithKey(
				joinerMmk,
				processed.entriesPayload.iv,
				processed.entriesPayload.ciphertext,
			),
		) as {
			entries: { id: string; ciphertext: string; iv: string; wrappedDek: string; dekIv: string }[];
		};
		expect(payload.entries).toHaveLength(2);
		const bank = payload.entries.find((e) => e.id === "dad-bank")!;
		// DEK opens under the MMK, then the content opens under the DEK.
		const dek = await decryptWithKey(joinerMmk, bank.dekIv, bank.wrappedDek);
		expect(dek).toBe(world.contents["dad-bank"].dek);
		const plaintext = await decryptWithKey(dek, bank.iv, bank.ciphertext);
		expect(JSON.parse(plaintext)).toEqual({ title: "Dad bank" });
	});

	it("the joiner's stored region decrypts under the sharing key", async () => {
		const { processed } = await joinFlow();
		const region = JSON.parse(
			await decryptWithKey(processed.shkB64, processed.region.iv, processed.region.ciphertext),
		);
		expect(region.collections).toHaveLength(2);
		expect(region.members).toHaveLength(2);
	});

	it("the member secrets round-trip under the member master key", async () => {
		const { processed, joinerMmk } = await joinFlow();
		const secrets = JSON.parse(
			await decryptWithKey(
				joinerMmk,
				processed.memberSecrets.iv,
				processed.memberSecrets.ciphertext,
			),
		) as { memberId: string; memberPrivateKey: string };
		expect(secrets.memberId).toBe("dad");
		expect(secrets.memberPrivateKey).toBeTruthy();
	});

	it("an entry without a wrapper record is rejected, not silently dropped", async () => {
		const world = await ownerWorld();
		const bundle = buildMemberInvite(world.state, {
			memberId: "dad",
			memberPubKey: world.dad.publicKey,
			entries: [{ entryId: "ghost", ciphertext: "x", iv: "y", hlc: HLC }],
		});
		await expect(
			processMemberInvite(deps, {
				bundle,
				memberPrivateKey: world.dad.privateKey,
				memberPublicKey: world.dad.publicKey,
				memberMasterKeyB64: await generateKey(),
			}),
		).rejects.toThrow(/no wrapper record/);
	});
});
