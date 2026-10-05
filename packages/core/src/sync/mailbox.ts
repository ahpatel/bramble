// The mailbox: store-and-forward delivery for peers that aren't online.
// See ADR-0008 and the relay's Durable Object (nostr-relay/cf-worker).
//
// The relay is an UNTRUSTED postbox — it stores opaque per-recipient blobs and
// enforces only size and count limits. Trust comes from signatures: the sender
// signs each envelope with its roster device signing key, and the recipient
// verifies against the roster it already holds, exactly as it would a live
// sync frame. A forged or tampered envelope fails verification and is dropped.

import type { EntriesPayload } from "./entries-payload";
import { encodeEntriesPayload } from "./entries-payload";

export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, relay-enforced
/** Envelope size ceiling, mirrored in the DO. A sync payload for a family
 * vault is far below this; the cap is abuse control, not a format limit. */
export const MAX_MAILBOX_ENVELOPE_BYTES = 256 * 1024;
/** Per-recipient queue depth, mirrored in the DO. Oldest overflow is dropped:
 * sync rebroadcasts continuously, so a dropped stale envelope is re-sent. */
export const MAX_MAILBOX_PER_RECIPIENT = 64;

export const MAILBOX_PROTOCOL_VERSION = 1;

/** One store-and-forward delivery. `payload` is the same EntriesPayload JSON a
 * live sync frame carries. `sig` covers everything but itself, made with the
 * sender's Ed25519 roster signing key (base64). */
export interface MailboxEnvelope {
	v: number;
	/** Sender's roster device id (the HLC node id). */
	from: string;
	/** Recipient's address: the member or device id the queue belongs to. */
	to: string;
	/** The sync room this delivery belongs to (HMAC of the group key), so the
	 * recipient can bind it to the vault it syncs. */
	room: string;
	/** Epoch ms, informational (the relay enforces TTL on its own clock). */
	ts: number;
	payload: string;
	sig: string;
}

export interface MailboxSigner {
	/** Sign `message` with this device's roster signing key (base64 sig). */
	sign(message: string): Promise<string>;
	/** This device's roster signing public key (base64). */
	publicKey(): Promise<string>;
}

export interface MailboxVerifier {
	/** Verify `sig` over `message` against a roster signing key (base64). */
	verify(publicKeyB64: string, message: string, sigB64: string): Promise<boolean>;
	/** The roster's signing keys by device id, for sender verification. */
	signingKeyFor(deviceId: string): Promise<string | null>;
}

function canonicalEnvelope(e: Omit<MailboxEnvelope, "sig">): string {
	return JSON.stringify([e.v, e.from, e.to, e.room, e.ts, e.payload]);
}

/** Build and sign one envelope. Rejects oversized payloads before signing. */
export async function buildMailboxEnvelope(input: {
	from: string;
	to: string;
	room: string;
	payload: EntriesPayload;
	signer: MailboxSigner;
}): Promise<MailboxEnvelope> {
	const payload = encodeEntriesPayload(input.payload);
	const base = {
		v: MAILBOX_PROTOCOL_VERSION,
		from: input.from,
		to: input.to,
		room: input.room,
		ts: Date.now(),
		payload,
	};
	const message = canonicalEnvelope(base);
	if (new TextEncoder().encode(message).length > MAX_MAILBOX_ENVELOPE_BYTES) {
		throw new Error("mailbox envelope too large");
	}
	const sig = await input.signer.sign(message);
	return { ...base, sig };
}

/** Parse and verify one envelope: signature against the sender's roster key,
 * protocol version, room binding. Returns null (drop) on any failure — the
 * relay is untrusted, so failures are silent skips, not errors. */
export async function parseMailboxEnvelope(
	raw: string,
	room: string,
	verifier: MailboxVerifier,
): Promise<EntriesPayload | null> {
	let envelope: MailboxEnvelope;
	try {
		const parsed = JSON.parse(raw) as MailboxEnvelope;
		if (parsed.v !== MAILBOX_PROTOCOL_VERSION) return null;
		if (parsed.room !== room) return null;
		if (!parsed.from || !parsed.to || !parsed.payload || !parsed.sig) return null;
		envelope = parsed;
	} catch {
		return null;
	}
	const signingKey = await verifier.signingKeyFor(envelope.from);
	if (!signingKey) return null;
	const { sig, ...base } = envelope;
	const ok = await verifier.verify(signingKey, canonicalEnvelope(base), sig);
	if (!ok) return null;
	try {
		return JSON.parse(envelope.payload) as EntriesPayload;
	} catch {
		return null;
	}
}

/** The relay's mailbox HTTP API (the DO serves these). POST pushes one
 * envelope, GET pops the queue. Kept here so client and relay agree. */
export function mailboxPushUrl(relayUrl: string, room: string, recipient: string): string {
	return `${relayUrl.replace(/\/$/, "")}/mailbox/${encodeURIComponent(room)}/${encodeURIComponent(recipient)}`;
}

export async function pushToMailbox(
	relayUrl: string,
	room: string,
	recipient: string,
	envelope: MailboxEnvelope,
): Promise<void> {
	const res = await fetch(mailboxPushUrl(relayUrl, room, recipient), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(envelope),
	});
	if (!res.ok) throw new Error(`mailbox push failed: ${res.status}`);
}

/** Pop the recipient's queue. Each returned raw envelope has been deleted
 * server-side; a failed verify drops it permanently, which is safe because
 * sync rebroadcasts continuously while peers are online. */
export async function pullFromMailbox(
	relayUrl: string,
	room: string,
	recipient: string,
	verifier: MailboxVerifier,
): Promise<EntriesPayload[]> {
	const res = await fetch(mailboxPushUrl(relayUrl, room, recipient));
	if (res.status === 404) return [];
	if (!res.ok) throw new Error(`mailbox pull failed: ${res.status}`);
	const raw: unknown = await res.json();
	if (!Array.isArray(raw)) return [];
	const out: EntriesPayload[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const payload = await parseMailboxEnvelope(item, room, verifier);
		if (payload) out.push(payload);
	}
	return out;
}
