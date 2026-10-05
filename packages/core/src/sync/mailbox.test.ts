// Mailbox client tests: the envelope round-trip with real signatures (injected
// signer/verifier), verification failures dropping silently, and the room
// binding. The relay itself is untrusted by design, so these test what the
// client guarantees without any server.

import { describe, expect, it } from "vitest";
import { type EntriesPayload, emptyEntriesPayload } from "./entries-payload";
import {
	buildMailboxEnvelope,
	MAILBOX_PROTOCOL_VERSION,
	type MailboxSigner,
	type MailboxVerifier,
	parseMailboxEnvelope,
} from "./mailbox";

/** A real Ed25519-ish signer/verifier pair over an in-memory key table.
 * The actual crypto comes from the roster sig layer in production; here the
 * signature is a keyed tag, which is enough to test the contract. */
function makeKeys(deviceIds: string[]) {
	const keys = new Map(deviceIds.map((id) => [id, `sk-${id}`]));
	const pubs = new Map(deviceIds.map((id) => [id, `pk-${id}`]));
	return {
		signerFor(id: string): MailboxSigner {
			return {
				sign: async (message) => `sig(${keys.get(id)}|${message})`,
				publicKey: async () => `pk-${id}`,
			};
		},
		verifier(): MailboxVerifier {
			return {
				signingKeyFor: async (deviceId) => pubs.get(deviceId) ?? null,
				verify: async (publicKeyB64, message, sigB64) =>
					sigB64 === `sig(${publicKeyB64.replace("pk-", "sk-")}|${message})`,
			};
		},
	};
}

const ROOM = "room-1";

describe("buildMailboxEnvelope", () => {
	it("produces a signed envelope whose payload is the encoded entries payload", async () => {
		const { signerFor } = makeKeys(["device-a"]);
		const envelope = await buildMailboxEnvelope({
			from: "device-a",
			to: "member-dad",
			room: ROOM,
			payload: emptyEntriesPayload(),
			signer: signerFor("device-a"),
		});
		expect(envelope.v).toBe(MAILBOX_PROTOCOL_VERSION);
		expect(envelope.from).toBe("device-a");
		expect(envelope.to).toBe("member-dad");
		expect(envelope.room).toBe(ROOM);
		expect(envelope.sig).toContain("sk-device-a");
		expect(JSON.parse(envelope.payload)).toEqual({ entries: [], tombstones: [] });
	});

	it("rejects an oversized payload before signing", async () => {
		const { signerFor } = makeKeys(["device-a"]);
		const big: EntriesPayload = {
			entries: [],
			tombstones: [],
			settings: {
				filler: { hlc: { wall: 1, counter: 0, node: "a" }, value: "x".repeat(300 * 1024) },
			},
		};
		await expect(
			buildMailboxEnvelope({
				from: "device-a",
				to: "member-dad",
				room: ROOM,
				payload: big,
				signer: signerFor("device-a"),
			}),
		).rejects.toThrow(/too large/);
	});
});

describe("parseMailboxEnvelope", () => {
	it("round-trips a signed envelope to the original payload", async () => {
		const { signerFor, verifier } = makeKeys(["device-a"]);
		const payload: EntriesPayload = {
			entries: [
				{
					id: "e1",
					ciphertext: "ct",
					iv: "iv",
					wrappedDek: "wd",
					dekIv: "di",
					hlc: { wall: 1700000000000, counter: 1, node: "device-a" },
				},
			],
			tombstones: [],
		};
		const envelope = await buildMailboxEnvelope({
			from: "device-a",
			to: "member-dad",
			room: ROOM,
			payload,
			signer: signerFor("device-a"),
		});
		const parsed = await parseMailboxEnvelope(JSON.stringify(envelope), ROOM, verifier());
		expect(parsed).toEqual(payload);
	});

	it("drops an envelope whose signature was tampered with", async () => {
		const { signerFor, verifier } = makeKeys(["device-a"]);
		const envelope = await buildMailboxEnvelope({
			from: "device-a",
			to: "member-dad",
			room: ROOM,
			payload: emptyEntriesPayload(),
			signer: signerFor("device-a"),
		});
		const tampered = { ...envelope, payload: envelope.payload.replace("[]", '[{"x":1}]') };
		expect(await parseMailboxEnvelope(JSON.stringify(tampered), ROOM, verifier())).toBeNull();
	});

	it("drops an envelope from an unknown device", async () => {
		const { signerFor } = makeKeys(["device-a", "device-b"]);
		const envelope = await buildMailboxEnvelope({
			from: "device-b",
			to: "member-dad",
			room: ROOM,
			payload: emptyEntriesPayload(),
			signer: signerFor("device-b"),
		});
		// The recipient's roster only knows device-a.
		const { verifier: aOnly } = makeKeys(["device-a"]);
		expect(await parseMailboxEnvelope(JSON.stringify(envelope), ROOM, aOnly())).toBeNull();
	});

	it("drops an envelope addressed to a different room", async () => {
		const { signerFor, verifier } = makeKeys(["device-a"]);
		const envelope = await buildMailboxEnvelope({
			from: "device-a",
			to: "member-dad",
			room: ROOM,
			payload: emptyEntriesPayload(),
			signer: signerFor("device-a"),
		});
		expect(await parseMailboxEnvelope(JSON.stringify(envelope), "room-2", verifier())).toBeNull();
	});

	it("drops unparseable input", async () => {
		const { verifier } = makeKeys(["device-a"]);
		expect(await parseMailboxEnvelope("not json", ROOM, verifier())).toBeNull();
	});
});
