// The mailbox engine's own bookkeeping for one vault: its sender epoch and numbering, what it
// last posted, what it has seen from each sender, and what it still owes. Parsed on load, and a
// state that does not parse starts fresh rather than stopping sync.

import { z } from "zod";
import type { StorageAdapter } from "../../adapters/storage";
import { bytesToBase64Url } from "../../util/bytes";
import { BlobHashSchema, MAX_MEMBERS, MessageIdSchema, SigKeySchema } from "./protocol";

export const SenderTrackSchema = z.object({
	epoch: MessageIdSchema,
	through: z.int().min(0),
	above: z.array(z.int()),
});
export type SenderTrack = z.infer<typeof SenderTrackSchema>;

export const MailboxStateSchema = z.object({
	/** This device's sender epoch: a fresh state restarts numbering under a new one. */
	epoch: MessageIdSchema,
	nextSeq: z.int().min(1),
	/** The PostedIndex of the last delta posted. */
	posted: z.record(z.string(), z.string()),
	/** This device's own deltas and snapshots since its last compaction. A snapshot does not count
	 * toward the next compaction, or a large vault would be re-posted every round. */
	log: z.array(
		z.object({
			id: MessageIdSchema,
			bytes: z.int().min(0),
			at: z.int(),
			snapshot: z.boolean().default(false),
		}),
	),
	active: z.boolean(),
	/** Ask everyone for a snapshot on the next sync. */
	catchUp: z.boolean(),
	/** By sender sigKey. */
	senders: z.record(z.string(), SenderTrackSchema),
	/** Split snapshots in flight, by sender sigKey. */
	snapshots: z.record(
		z.string(),
		z.object({
			epoch: MessageIdSchema,
			seq: z.int(),
			parts: z.int(),
			got: z.array(z.int()),
		}),
	),
	/** Senders to ask for a snapshot. */
	gaps: z.array(SigKeySchema),
	/** Requester sigKey: whose gap it asked about (null for a catch-up). */
	toAnswer: z.record(z.string(), SigKeySchema.nullable()),
	/** Sender sigKey, or "*" for everyone: when this device last asked. */
	requested: z.record(z.string(), z.int()),
	/** Requester sigKey and the sender asked about ("*" for a catch-up): when last answered. */
	answered: z.record(z.string(), z.int()),
	/** Gap sender: when an answer last arrived that didn't reach its gap. */
	uncovered: z.record(z.string(), z.int()).default({}),
	/** Held message ids: when to look at each again, so a held body is not fetched every round. */
	held: z.record(z.string(), z.int()).default({}),
	/** New wants already fetched directly once. */
	tried: z.array(BlobHashSchema).default([]),
	/** Hashes this device uploaded eagerly. */
	uploaded: z.array(BlobHashSchema),
	/** The wants list last sent. */
	wants: z.array(BlobHashSchema),
	reconciled: z.object({ roster: z.string(), at: z.int() }).nullable(),
	/** Hex SHA-256 of the account number the mailbox was created under or moved to (hosted). */
	account: z.string().nullable().default(null),
	/** Who this device's last change post was for; null until a post records it. A key that joins
	 * it later is sent a snapshot, since the posts before reached others but not it. */
	addressed: z.array(SigKeySchema).nullable().default(null),
	/** Senders whose messages were refused because the roster didn't hold them, newest last. Once
	 * it does, each is asked for a snapshot: what it sent was quarantined, not merged. */
	refused: z.array(SigKeySchema).max(MAX_MEMBERS).default([]),
});
export type MailboxState = z.infer<typeof MailboxStateSchema>;
export type SnapshotParts = MailboxState["snapshots"][string];

/** Drop gaps and per-sender state for keys `members` doesn't hold: a server can name any sender. */
export function forgetStrangers(state: MailboxState, members: string[]): void {
	const known = new Set(members);
	const keep = (key: string) => known.has(key);
	state.gaps = state.gaps.filter(keep);
	for (const record of [state.senders, state.snapshots, state.toAnswer, state.uncovered]) {
		for (const key of Object.keys(record)) if (!keep(key)) delete record[key];
	}
	for (const key of Object.keys(state.requested)) {
		if (key !== "*" && !keep(key)) delete state.requested[key];
	}
	for (const key of Object.keys(state.answered)) {
		if (!keep(key.split("|")[0] ?? "")) delete state.answered[key];
	}
}

/** Ask each refused sender the roster now holds for a snapshot; keep the others. */
export function retryRefused(state: MailboxState, members: string[]): void {
	const known = new Set(members);
	for (const key of state.refused) {
		if (known.has(key) && !state.gaps.includes(key)) state.gaps.push(key);
	}
	state.refused = state.refused.filter((key) => !known.has(key));
}

/** Note a sender refused for not being in the roster. */
export function noteRefused(state: MailboxState, sender: string): void {
	state.refused = [...state.refused.filter((key) => key !== sender), sender].slice(-MAX_MEMBERS);
}

export interface MailboxStateStore {
	load(): Promise<MailboxState>;
	save(state: MailboxState): Promise<void>;
}

export function freshState(random: (n: number) => Uint8Array): MailboxState {
	return {
		epoch: bytesToBase64Url(random(16)),
		nextSeq: 1,
		posted: {},
		log: [],
		active: false,
		catchUp: false,
		senders: {},
		snapshots: {},
		gaps: [],
		toAnswer: {},
		requested: {},
		answered: {},
		uncovered: {},
		held: {},
		tried: [],
		uploaded: [],
		wants: [],
		reconciled: null,
		account: null,
		addressed: null,
		refused: [],
	};
}

/** Missing or unparsable state loads as a fresh one. */
export function metaStateStore(
	storage: Pick<StorageAdapter, "getMeta" | "setMeta">,
	key: string,
	random: (n: number) => Uint8Array,
): MailboxStateStore {
	return {
		async load() {
			const parsed = MailboxStateSchema.safeParse(await storage.getMeta<unknown>(key));
			return parsed.success ? parsed.data : freshState(random);
		},
		save: (state) => storage.setMeta(key, state),
	};
}
