// File blobs through the mailbox (docs/mailbox-service.md, "Files"): collect what is delivered,
// list what this device's manifest names but its store lacks, and upload what roster members want
// that this device holds. Blobs are sealed under their own file keys, so nothing here touches a key.

import type { EntriesPayload } from "../entries-payload";
import { activeSigKeys, type RosterPayload } from "../roster";
import { wantedFromPayload } from "../transport/blob-sync";
import { limit, type MailboxContext } from "./context";
import { type InboxResponse, MAX_MEMBERS, MAX_WANTS } from "./protocol";
import type { MailboxState } from "./state";

const download = async (ctx: MailboxContext, hash: string) =>
	ctx.blobs.mover.download(hash, await ctx.api.blobRequest("GET", hash));

/**
 * Collect delivered blobs; the hashes to acknowledge. A held hash is acknowledged without a
 * download, a missing one is acknowledged (the manifest will want it again), and a failed
 * download is left for the next sync.
 */
export async function collectBlobs(
	ctx: MailboxContext,
	blobs: InboxResponse["blobs"],
): Promise<string[]> {
	const acked: string[] = [];
	for (const { hash } of blobs) {
		try {
			if (!(await ctx.blobs.store.has(hash))) await download(ctx, hash);
			acked.push(hash);
		} catch (err) {
			console.warn("[mailbox] blob download failed; it stays for the next sync:", err);
		}
	}
	return acked;
}

/**
 * Send the wants list when it changed. A new want is first fetched directly: a blob the mailbox
 * already held when this device became active has no delivery for it.
 */
export async function syncWants(
	ctx: MailboxContext,
	state: MailboxState,
	local: EntriesPayload,
	/** Wraps the wants update, a post a collect-only mailbox may refuse; fetching always runs. */
	post: (send: () => Promise<void>) => Promise<void> = (send) => send(),
): Promise<void> {
	const held = new Set(await ctx.blobs.store.list());
	const missing = [...new Set(wantedFromPayload(local).map((w) => w.hash))]
		.filter((hash) => !held.has(hash))
		.sort();
	// Tried once each, a few per sync: past the cap, the rest wait for the next sync, not forever.
	const tried = new Set(state.tried.filter((hash) => missing.includes(hash)));
	const got = new Set<string>();
	for (const hash of missing.filter((h) => !tried.has(h)).slice(0, limit(ctx, "directGets"))) {
		tried.add(hash);
		try {
			if ((await download(ctx, hash)) === "stored") got.add(hash);
		} catch (err) {
			console.warn("[mailbox] direct blob fetch failed; it stays wanted:", err);
		}
	}
	state.tried = [...tried];
	const wants = missing.filter((hash) => !got.has(hash)).slice(0, MAX_WANTS);
	if (wants.join() === state.wants.join()) return;
	await post(async () => {
		await ctx.api.wants(wants);
		state.wants = wants;
	});
}

/** Upload a held blob for `to`, a part at a time past the server's per-request limit (a repeat of
 * a held hash only adds deliveries). */
export async function uploadTo(ctx: MailboxContext, hash: string, to: string[]): Promise<void> {
	for (let i = 0; i < to.length; i += MAX_MEMBERS) {
		const part = to.slice(i, i + MAX_MEMBERS);
		await ctx.blobs.mover.upload(hash, await ctx.api.blobRequest("PUT", hash, part));
	}
}

/** Upload what members of `roster` want that this device holds, to them only; stop at the first
 * failure. Any member can list a key with the server, so a wanter the roster lacks gets nothing. */
export async function uploadWanted(
	ctx: MailboxContext,
	wanted: InboxResponse["wanted"],
	roster: RosterPayload,
): Promise<void> {
	const members = new Set(activeSigKeys(roster));
	for (const { hash, by } of wanted) {
		const to = by.filter((key) => members.has(key));
		if (to.length === 0 || !(await ctx.blobs.store.has(hash))) continue;
		try {
			await uploadTo(ctx, hash, to);
		} catch (err) {
			console.warn("[mailbox] uploading a wanted blob failed; next sync tries again:", err);
			return;
		}
	}
}
