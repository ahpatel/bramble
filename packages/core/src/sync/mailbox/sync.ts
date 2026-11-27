// The mailbox sync engine (docs/mailbox-service.md, "Clients"): one round of activating,
// collecting, healing, posting, compacting and reconciling. A platform calls sync() on unlock, on
// a local change and on a timer; calls made while a round runs share it.

import { activeSigKeys, type RosterPayload } from "../roster";
import { MailboxApiError } from "./api";
import type { MailboxContext } from "./context";
import { syncWants, uploadWanted } from "./files";
import { ensureAccount, ensureActive, pruneMembers, reconcileMembers, switchOff } from "./members";
import { drainInbox } from "./receive";
import {
	answerRequests,
	compact,
	type PostOutcome,
	postChanges,
	refusal,
	requestSnapshot,
} from "./send";
import { forgetStrangers, type MailboxState, type MailboxStateStore, retryRefused } from "./state";

export type MailboxStatus =
	| "synced"
	| "waiting"
	| "retry"
	| "collect_only"
	| "quota_exceeded"
	| "account_required"
	| "account_unknown";

/** Activation, where a hosted mailbox that can't be created yet says why instead of failing. */
async function activate(
	ctx: MailboxContext,
	state: MailboxState,
	roster: RosterPayload,
): Promise<"active" | "waiting" | "account_required" | "account_unknown"> {
	try {
		return await ensureActive(ctx, state, roster);
	} catch (err) {
		if (
			err instanceof MailboxApiError &&
			(err.code === "account_required" || err.code === "account_unknown")
		) {
			return err.code;
		}
		throw err;
	}
}

export interface MailboxSync {
	sync(): Promise<MailboxStatus>;
	switchOff(): Promise<void>;
}

export function mailboxSync(
	deps: Omit<MailboxContext, "now" | "random"> & {
		state: MailboxStateStore;
		now?: () => number;
		random?: (n: number) => Uint8Array;
	},
): MailboxSync {
	const { state: store, ...rest } = deps;
	const ctx: MailboxContext = {
		...rest,
		now: deps.now ?? Date.now,
		random: deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
	};
	let running: Promise<MailboxStatus> | null = null;

	async function round(state: MailboxState): Promise<MailboxStatus> {
		let local = await ctx.vault.readLocal();
		const joined = await activate(ctx, state, local.roster);
		if (joined !== "active") return joined;
		// A new number the service refuses leaves the mailbox on its old account: this round still runs.
		const account = await ensureAccount(ctx, state);

		// Under collect-only or a full quota nothing can be posted, but collecting goes on.
		let refused: PostOutcome | null = null;
		const posting = async (post: () => Promise<void>) => {
			if (refused) return;
			try {
				await post();
			} catch (err) {
				refused = refusal(err);
				if (!refused) throw err;
			}
		};

		if (state.catchUp) {
			await posting(async () => {
				await requestSnapshot(ctx, state, null, local.roster);
				state.catchUp = false;
			});
		}
		const drain = await drainInbox(ctx, state);
		if (drain.deactivated) {
			// Removed, or an old deactivation replayed: activate again and finish next round.
			await activate(ctx, state, local.roster);
			return "retry";
		}
		if (drain.interrupted) return "retry";

		local = await ctx.vault.readLocal();
		forgetStrangers(state, activeSigKeys(local.roster));
		retryRefused(state, activeSigKeys(local.roster));
		for (const sender of [...state.gaps]) {
			await posting(async () => {
				await requestSnapshot(ctx, state, sender, local.roster);
				state.gaps = state.gaps.filter((g) => g !== sender);
			});
		}
		// A device revoked in what was just merged leaves before this round sends anything.
		if (drain.held === 0) await pruneMembers(ctx, state, local.roster);
		await posting(() => answerRequests(ctx, state, local));
		await uploadWanted(ctx, drain.wanted, local.roster);
		const posted = refused ?? (await postChanges(ctx, state, local));
		await store.save(state);
		await posting(() => compact(ctx, state, local));
		// Fetching always runs; the wants update is a post a collect-only or full mailbox refuses.
		await syncWants(ctx, state, local.entries, posting);

		// After a full merge, so a roster entry that rode a delta is known before membership is judged.
		const clean = drain.held === 0 && (posted === "posted" || posted === "nothing");
		if (clean && !refused) await reconcileMembers(ctx, state, local.roster);
		const outcome = refused ?? posted;
		if (account === "unknown") return "account_unknown";
		if (account === "full") return "quota_exceeded";
		return outcome === "collect_only" || outcome === "quota_exceeded" ? outcome : "synced";
	}

	async function run(): Promise<MailboxStatus> {
		const state = await store.load();
		try {
			return await round(state);
		} catch (err) {
			console.warn("[mailbox] sync stopped; the next one retries:", err);
			return "retry";
		} finally {
			await store.save(state);
		}
	}

	return {
		sync() {
			running ??= run().finally(() => {
				running = null;
			});
			return running;
		},
		async switchOff() {
			const state = await store.load();
			await switchOff(ctx, state);
			await store.save(state);
		},
	};
}
