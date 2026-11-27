// Sending (docs/mailbox-service.md, "Messages", "Compaction"): closed deltas numbered under this
// device's epoch, snapshots that cover through its last number, snapshot requests, and compaction
// of this device's own backlog. New attachments go up before the delta that names them.

import { bytesToBase64Url } from "../../util/bytes";
import { activeSigKeys, encodeRoster, type RosterPayload } from "../roster";
import { MailboxApiError } from "./api";
import { limit, type MailboxContext } from "./context";
import { cutDelta } from "./delta";
import { sealMessage } from "./envelope";
import { uploadTo } from "./files";
import { encodePlaintext, type MailboxPlaintext } from "./plaintext";
import { MAX_LIST, MAX_MEMBERS, sha256Hex } from "./protocol";
import type { MailboxState } from "./state";
import type { MailboxEnvelope } from "./vault-port";

export type PostOutcome = "posted" | "nothing" | "collect_only" | "quota_exceeded";

const DAY_MS = 86_400_000;
/** The posted index's entry for the roster, beside cutDelta's entry, file and setting groups. */
const ROSTER_KEY = "r:";
const dayOf = (ms: number) => Math.floor(ms / DAY_MS);

/** Everyone else in the roster. Any active member can add a key to the server's list, so that list
 * never decides who a post or a blob is for. */
export const rosterRecipients = (ctx: MailboxContext, roster: RosterPayload) =>
	activeSigKeys(roster).filter((key) => key !== ctx.sigKey);

/**
 * Seal and post one message to `to`, a part at a time past the server's per-request limit (a
 * repeat of the id only adds deliveries). A stored delta or snapshot is logged for compaction; a
 * request is not, since no snapshot of this device's state stands in for it.
 */
async function postOne(
	ctx: MailboxContext,
	state: MailboxState,
	plaintext: MailboxPlaintext,
	to: string[],
): Promise<{ id: string; stored: boolean; recipients: number }> {
	const id = bytesToBase64Url(ctx.random(16));
	if (to.length === 0) return { id, stored: false, recipients: 0 };
	const body = await sealMessage(ctx.crypto, {
		groupKeyB64: ctx.groupKeyB64,
		mailboxId: ctx.api.mailboxId,
		messageId: id,
		sender: ctx.sigKey,
		plaintext: encodePlaintext(plaintext),
	});
	let stored = false;
	let recipients = 0;
	for (let i = 0; i < to.length; i += MAX_MEMBERS) {
		const res = await ctx.api.post(id, body, to.slice(i, i + MAX_MEMBERS));
		stored ||= res.stored;
		recipients += res.recipients;
	}
	if (stored && plaintext.kind !== "snapshot_request") {
		const snapshot = plaintext.kind === "snapshot";
		state.log.push({ id, bytes: body.length, at: ctx.api.serverNow(), snapshot });
	}
	return { id, stored, recipients };
}

/**
 * Upload attachments named in `parts` that this device holds and has not uploaded before. The
 * first post carries the whole vault, and switching on uploads nothing historical (the wants path
 * moves what a member lacks), so it uploads nothing. A failed upload never holds back the delta.
 */
async function uploadNew(
	ctx: MailboxContext,
	state: MailboxState,
	parts: MailboxEnvelope["entries"][],
	to: string[],
) {
	if (Object.keys(state.posted).length === 0) return;
	const done = new Set(state.uploaded);
	for (const file of parts.flatMap((p) => p.files ?? [])) {
		if (done.has(file.hash) || !(await ctx.blobs.store.has(file.hash))) continue;
		done.add(file.hash);
		try {
			if (to.length > 0) await uploadTo(ctx, file.hash, to);
			state.uploaded.push(file.hash);
		} catch (err) {
			console.warn("[mailbox] an attachment upload failed; the wants path covers it:", err);
		}
	}
}

/** A post the server refused for the account, not for the message: collect-only, or a full quota. */
export const refusal = (err: unknown): PostOutcome | null =>
	err instanceof MailboxApiError && (err.code === "collect_only" || err.code === "quota_exceeded")
		? err.code
		: null;

export async function postChanges(
	ctx: MailboxContext,
	state: MailboxState,
	local: MailboxEnvelope,
): Promise<PostOutcome> {
	const { parts, index } = await cutDelta(local.entries, state.posted, limit(ctx, "partBudget"));
	// A roster change alone is news too: membership follows the roster each member has merged.
	const roster = (await sha256Hex(encodeRoster(local.roster))).slice(0, 32);
	if (parts.length === 0 && state.posted[ROSTER_KEY] === roster) return "nothing";
	const toPost = parts.length > 0 ? parts : [{ entries: [], tombstones: [] }];
	const to = rosterRecipients(ctx, local.roster);
	try {
		await uploadNew(ctx, state, parts, to);
		for (const entries of toPost) {
			const seq = state.nextSeq;
			await postOne(
				ctx,
				state,
				{ v: 1, kind: "delta", epoch: state.epoch, seq, entries, roster: local.roster },
				to,
			);
			state.nextSeq = seq + 1;
		}
	} catch (err) {
		const outcome = refusal(err);
		if (outcome) return outcome;
		throw err;
	}
	// Only once every part is up: a failure midway re-cuts the same groups next time.
	state.posted = { ...index, [ROSTER_KEY]: roster };
	return "posted";
}

/** The whole state, split into parts, to `to`. The stored parts' ids. */
export async function postSnapshot(
	ctx: MailboxContext,
	state: MailboxState,
	local: MailboxEnvelope,
	to: string[],
	answers: string | null,
): Promise<string[]> {
	const { parts } = await cutDelta(local.entries, {}, limit(ctx, "partBudget"));
	// An empty vault still answers, so the request is covered.
	const all = parts.length > 0 ? parts : [{ entries: [], tombstones: [] }];
	const had = answers ? state.senders[answers] : undefined;
	const covers = had ? { epoch: had.epoch, through: had.through } : undefined;
	const ids: string[] = [];
	for (const [i, entries] of all.entries()) {
		const posted = await postOne(
			ctx,
			state,
			{
				v: 1,
				kind: "snapshot",
				epoch: state.epoch,
				seq: state.nextSeq - 1,
				part: i + 1,
				parts: all.length,
				answers,
				...(covers ? { covers } : {}),
				entries,
				roster: local.roster,
			},
			to,
		);
		if (posted.stored) ids.push(posted.id);
	}
	return ids;
}

/** Ask `of`'s sender (or the roster, `of` null) for a snapshot, at most once per requestEveryMs. */
export async function requestSnapshot(
	ctx: MailboxContext,
	state: MailboxState,
	of: string | null,
	roster: RosterPayload,
): Promise<void> {
	const key = of ?? "*";
	const last = state.requested[key];
	if (last !== undefined && ctx.now() - last < limit(ctx, "requestEveryMs")) return;
	const uncovered = of ? state.uncovered[of] : undefined;
	if (uncovered !== undefined && ctx.now() - uncovered < limit(ctx, "uncoveredRetryMs")) return;
	const request: MailboxPlaintext = { v: 1, kind: "snapshot_request", of };
	// A sender that is gone reaches nobody: then any member may answer for it.
	const direct = of ? await postOne(ctx, state, request, [of]) : null;
	if (!direct || direct.recipients === 0)
		await postOne(ctx, state, request, rosterRecipients(ctx, roster));
	state.requested[key] = ctx.now();
}

export async function answerRequests(
	ctx: MailboxContext,
	state: MailboxState,
	local: MailboxEnvelope,
): Promise<void> {
	const members = activeSigKeys(local.roster);
	for (const [requester, of] of Object.entries(state.toAnswer)) {
		// Per request kind: a catch-up answered a minute ago must not block a gap's answer.
		const key = `${requester}|${of ?? "*"}`;
		const last = state.answered[key];
		const due = last === undefined || ctx.now() - last >= limit(ctx, "requestEveryMs");
		// A requester revoked since it asked is never sent the vault.
		if (due && members.includes(requester)) {
			await postSnapshot(ctx, state, local, [requester], of);
			state.answered[key] = ctx.now();
		}
		delete state.toAnswer[requester];
	}
}

/**
 * Replace this device's backlog with one snapshot for members that have not collected it. A
 * logged message from a day before every member's last check-in has been collected by all of
 * them, so it leaves the log without a snapshot; one from that day on may not have been.
 */
export async function compact(
	ctx: MailboxContext,
	state: MailboxState,
	local: MailboxEnvelope,
): Promise<void> {
	const over = () => {
		const since = state.log.filter((e) => !e.snapshot);
		return (
			since.length >= limit(ctx, "compactCount") ||
			since.reduce((n, e) => n + e.bytes, 0) >= limit(ctx, "compactBytes")
		);
	};
	if (!over()) return;
	// The roster, not the server's list: a device revoked here may still be listed there.
	const members = activeSigKeys(local.roster);
	const others = (await ctx.api.members()).members.filter(
		(m) => m.status === "active" && m.sigKey !== ctx.sigKey && members.includes(m.sigKey),
	);
	const checked = others.map((m) => m.lastCheckedDay ?? Number.NEGATIVE_INFINITY);
	const everyone = checked.length > 0 ? Math.min(...checked) : Number.POSITIVE_INFINITY;
	state.log = state.log.filter((e) => dayOf(e.at) >= everyone);
	const oldest = state.log[0];
	if (!oldest || !over()) return;
	const targets = others
		.filter((m) => m.lastCheckedDay === null || m.lastCheckedDay < dayOf(oldest.at))
		.map((m) => m.sigKey);
	if (targets.length === 0) return;
	const replaced = state.log.map((e) => e.id);
	const ids = await postSnapshot(ctx, state, local, targets, null);
	const last = ids.at(-1);
	if (last === undefined) return;
	for (let i = 0; i < replaced.length; i += MAX_LIST) {
		await ctx.api.replaces(last, replaced.slice(i, i + MAX_LIST));
	}
	state.log = state.log.filter((e) => ids.includes(e.id));
}
