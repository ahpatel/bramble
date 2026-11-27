// Collecting the inbox (docs/mailbox-service.md, "Acknowledgement and deletion", "Gaps and
// self-healing"). A message is acknowledged once its merge is written; a merge that set something
// aside, or a newer client's message, is held; one that fails to verify or open, or comes from a
// revoked device, is quarantined and acknowledged. A local fault stops the drain with nothing
// acknowledged for it, so the next sync tries again.

import { bytesToBase64 } from "../../util/bytes";
import type { QuarantinedMessage } from "../../vault/quarantine";
import { activeSigKeys } from "../roster";
import { MailboxApiError } from "./api";
import { limit, type MailboxContext } from "./context";
import { MailboxOpenError, openMessage } from "./envelope";
import { collectBlobs } from "./files";
import { decodePlaintext, type MailboxPlaintext } from "./plaintext";
import { type InboxResponse, MAX_MESSAGE_BYTES } from "./protocol";
import { hasGap, recordDelta, recordPart, recordSnapshot } from "./sequence";
import { type MailboxState, noteRefused } from "./state";

export interface DrainResult {
	merged: number;
	/** Left pending: set aside or unsupported. */
	held: number;
	/** A merge did not run or a crypto call failed for a local reason: stop, retry later. */
	interrupted: boolean;
	/** The inbox said this device is not active (or not a member). */
	deactivated: boolean;
	/** Hashes others want and have no delivery for, with who wants each, every page. */
	wanted: InboxResponse["wanted"];
}

type Message = InboxResponse["messages"][number];
/** `hold`: set aside, look again soon; `newer`: a newer client's, look again much later. */
type Verdict = "ack" | "merged" | "hold" | "newer" | "stop";
type Numbered = Extract<MailboxPlaintext, { kind: "delta" | "snapshot" }>;
type Observed = { sender: string; m: Numbered };

function addGap(state: MailboxState, sender: string): void {
	if (!state.gaps.includes(sender)) state.gaps.push(sender);
}

async function quarantine(
	ctx: MailboxContext,
	msg: Message,
	body: Uint8Array,
	reason: QuarantinedMessage["reason"],
): Promise<void> {
	await ctx.vault.quarantine({
		messages: [
			{
				mailboxMessage: bytesToBase64(body),
				mailboxId: ctx.api.mailboxId,
				messageId: msg.id,
				sender: msg.sender,
				reason,
			},
		],
	});
}

function track(state: MailboxState, sender: string, m: Numbered, now: number): void {
	if (m.kind === "delta") {
		state.senders[sender] = recordDelta(state.senders[sender], m.epoch, m.seq);
		return;
	}
	const { pending, complete } = recordPart(state.snapshots[sender], m);
	if (pending) state.snapshots[sender] = pending;
	else delete state.snapshots[sender];
	if (!complete) return;
	state.senders[sender] = recordSnapshot(state.senders[sender], m.epoch, m.seq);
	if (m.answers && m.answers !== sender) {
		// Only as far as the answerer had that sender: an answer that never got the missing message
		// can't stand in for it.
		const gap = state.senders[m.answers];
		if (gap && m.covers?.epoch === gap.epoch) {
			state.senders[m.answers] = recordSnapshot(gap, m.covers.epoch, m.covers.through);
		}
		if (hasGap(state.senders[m.answers])) state.uncovered[m.answers] = now;
		else delete state.uncovered[m.answers];
	}
}

/**
 * Record what a page carried, lowest number first per sender: messages posted in one server
 * millisecond arrive in id order, and a sender first seen at a higher number would hide the gap
 * below it. Epochs keep the order they were first seen in.
 */
function trackAll(state: MailboxState, observed: Observed[], now: number): void {
	const rank = new Map<string, number>();
	for (const o of observed) {
		const key = `${o.sender}|${o.m.epoch}`;
		if (!rank.has(key)) rank.set(key, rank.size);
	}
	const at = (o: Observed) => rank.get(`${o.sender}|${o.m.epoch}`) as number;
	const kind = (o: Observed) => (o.m.kind === "delta" ? 0 : 1);
	const sorted = [...observed].sort(
		(x, y) => at(x) - at(y) || x.m.seq - y.m.seq || kind(x) - kind(y),
	);
	for (const o of sorted) track(state, o.sender, o.m, now);
}

/** Quarantine and acknowledge, unless the vault changed under the drain: then nothing is judged. */
async function refuse(
	ctx: MailboxContext,
	state: MailboxState,
	msg: Message,
	body: Uint8Array,
	reason: QuarantinedMessage["reason"],
	gap: boolean,
): Promise<Verdict> {
	if (!ctx.vault.current()) return "stop";
	await quarantine(ctx, msg, body, reason);
	if (gap) addGap(state, msg.sender);
	return "ack";
}

async function receive(
	ctx: MailboxContext,
	state: MailboxState,
	msg: Message,
	observed: Observed[],
): Promise<Verdict> {
	if (!ctx.vault.current()) return "stop";
	const body = await ctx.api.message(msg.id);
	if (body === null || body.length > MAX_MESSAGE_BYTES) {
		// The row outlived its body, or no sender could have posted it: nothing to merge, so heal it
		// as a gap.
		addGap(state, msg.sender);
		return "ack";
	}
	let text: string;
	try {
		text = await openMessage(ctx.crypto, {
			groupKeyB64: ctx.groupKeyB64,
			mailboxId: ctx.api.mailboxId,
			messageId: msg.id,
			sender: msg.sender,
			body,
		});
	} catch (err) {
		if (!(err instanceof MailboxOpenError)) return "stop";
		if (err.reason === "unsupported") return "newer";
		return refuse(ctx, state, msg, body, err.reason, true);
	}
	const decoded = decodePlaintext(text);
	if (!decoded.ok) {
		if (decoded.why === "unsupported") return "newer";
		return refuse(ctx, state, msg, body, "bad_plaintext", true);
	}
	const m = decoded.message;
	if (m.kind === "snapshot_request") {
		// Only a member this device still trusts is sent its vault.
		const { roster } = await ctx.vault.readLocal();
		if (!ctx.vault.current()) return "stop";
		if (activeSigKeys(roster).includes(msg.sender)) state.toAnswer[msg.sender] = m.of;
		return "ack";
	}
	if (!activeSigKeys(await ctx.vault.previewRoster(m.roster)).includes(msg.sender)) {
		noteRefused(state, msg.sender);
		return refuse(ctx, state, msg, body, "revoked_sender", false);
	}
	const applied = await ctx.vault.apply({ entries: m.entries, roster: m.roster });
	if (applied === null) return "stop";
	// Held or not, it arrived: its number is no gap.
	observed.push({ sender: msg.sender, m });
	return applied.setAside ? "hold" : "merged";
}

export async function drainInbox(ctx: MailboxContext, state: MailboxState): Promise<DrainResult> {
	const result: DrainResult = {
		merged: 0,
		held: 0,
		interrupted: false,
		deactivated: false,
		wanted: [],
	};
	const seen = new Set<string>();
	let wantedAfter: string | undefined;
	let wantedDone = false;
	for (let pages = 1; ; pages++) {
		let page: InboxResponse;
		try {
			page = await ctx.api.inbox(wantedAfter);
		} catch (err) {
			if (
				err instanceof MailboxApiError &&
				(err.code === "not_active" || err.code === "not_member" || err.code === "not_found")
			) {
				state.active = false;
				result.deactivated = true;
				return result;
			}
			throw err;
		}
		const ack = { messages: [] as string[], blobs: [] as string[], markers: [] as number[] };
		const observed: Observed[] = [];
		for (const msg of page.messages) {
			if (seen.has(msg.id)) continue;
			seen.add(msg.id);
			const until = state.held[msg.id];
			if (until !== undefined && ctx.now() < until) {
				result.held++;
				continue;
			}
			const verdict = await receive(ctx, state, msg, observed);
			if (verdict === "stop") {
				result.interrupted = true;
				break;
			}
			if (verdict === "hold" || verdict === "newer") {
				const wait = limit(ctx, verdict === "hold" ? "heldRetryMs" : "newerRetryMs");
				state.held[msg.id] = ctx.now() + wait;
				result.held++;
			} else {
				delete state.held[msg.id];
				if (verdict === "merged") result.merged++;
				ack.messages.push(msg.id);
			}
		}
		trackAll(state, observed, ctx.now());
		if (!result.interrupted) {
			for (const marker of page.markers) {
				addGap(state, marker.sender);
				ack.markers.push(marker.id);
			}
			ack.blobs = await collectBlobs(ctx, page.blobs);
		}
		if (!wantedDone) {
			result.wanted.push(...page.wanted);
			wantedAfter = page.wanted.at(-1)?.hash;
			wantedDone = !page.wantedMore || wantedAfter === undefined;
		}
		const progress = ack.messages.length + ack.blobs.length + ack.markers.length;
		if (progress > 0) await ctx.api.ack(ack);
		if (result.interrupted) return result;
		// A page of held messages makes no progress: asking again would return the same page.
		if (!(page.more && progress > 0) && wantedDone) break;
		if (pages >= limit(ctx, "drainPages")) break;
	}
	for (const [sender, t] of Object.entries(state.senders)) {
		if (hasGap(t)) addGap(state, sender);
		else delete state.uncovered[sender];
	}
	// A held message stays at the head of the inbox, so one not listed any more is gone.
	for (const id of Object.keys(state.held)) if (!seen.has(id)) delete state.held[id];
	return result;
}
