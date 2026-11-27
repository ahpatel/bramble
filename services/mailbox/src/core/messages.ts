// Posting, collecting and acknowledging sealed messages, and sender-scoped compaction
// (docs/mailbox-service.md, "Messages" to "Compaction"). The server never reads a body.

import {
	AckBodySchema,
	INBOX_PAGE,
	InboxQuerySchema,
	type InboxResponse,
	MAX_MESSAGE_BYTES,
	MailboxIdSchema,
	MessageIdSchema,
	PostMessageQuerySchema,
	type PostResponse,
	ReplacesBodySchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { and, asc, count, eq, gt, inArray, lte, ne, notExists, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Db, Env } from "./app.ts";
import { HttpError, param, query, signedJson } from "./auth.ts";
import { messageKey } from "./bodies.ts";
import { type Candidates, deleteUndelivered } from "./cleanup.ts";
import { mailboxParam, requireMember } from "./mailboxes.ts";
import {
	blobDeliveries,
	blobs,
	blobWants,
	deliveries,
	expiryMarkers,
	members,
	messages,
} from "./schema.ts";
import { chunk, IN_LIST } from "./sql.ts";
import { DAY_MS, dayOf } from "./time.ts";
import { declaredLength, storeUpload } from "./upload.ts";

/** MAX_LIST message ids of 25 JSON bytes each, with room to spare. */
const REPLACES_JSON_BYTES = 64 * 1024;
const ACK_JSON_BYTES = 256 * 1024;

/** What each stored message, blob and want costs against a quota beyond its body: rows aren't free. */
export const ROW_BYTES = 4096;

/** The bytes the mailboxes `which` picks hold: bodies, plus ROW_BYTES for every row. */
export async function heldBytes(
	db: Db,
	which: (mailboxId: AnySQLiteColumn) => SQL,
): Promise<number> {
	const sized = sql<number>`coalesce(sum(size), 0) + count(*) * ${ROW_BYTES}`;
	const m = await db.select({ total: sized }).from(messages).where(which(messages.mailboxId)).get();
	const b = await db.select({ total: sized }).from(blobs).where(which(blobs.mailboxId)).get();
	const w = await db
		.select({ total: sql<number>`count(*) * ${ROW_BYTES}` })
		.from(blobWants)
		.where(which(blobWants.mailboxId))
		.get();
	return Number(m?.total ?? 0) + Number(b?.total ?? 0) + Number(w?.total ?? 0);
}

/** The bytes one mailbox holds: its pending messages, its blobs and its wants. */
export const usedBytes = (db: Db, mailboxId: string): Promise<number> =>
	heldBytes(db, (column) => eq(column, mailboxId));

export async function checkQuota(deps: AppDeps, mailboxId: string, adding: number): Promise<void> {
	const { usedBytes, quotaBytes } = await deps.entitlement.usage(mailboxId);
	if (quotaBytes !== null && usedBytes + adding > quotaBytes) {
		throw new HttpError(507, "quota_exceeded");
	}
}

export function messageRoutes(deps: AppDeps) {
	const { db } = deps;
	const r = new Hono<Env>();

	const messageParam = param(z.object({ id: MailboxIdSchema, mid: MessageIdSchema }));

	async function senderOf(mailboxId: string, msgId: string): Promise<string | null> {
		const row = await db
			.select({ sender: messages.sender })
			.from(messages)
			.where(and(eq(messages.mailboxId, mailboxId), eq(messages.id, msgId)))
			.get();
		return row?.sender ?? null;
	}

	/** Who a post from `caller` is for: every other active member, or those of them `to` names. */
	function targets(mailboxId: string, caller: string, to: string[] | undefined) {
		return and(
			eq(members.mailboxId, mailboxId),
			eq(members.status, "active"),
			ne(members.sigKey, caller),
			to ? inArray(members.sigKey, to) : undefined,
		);
	}

	async function countOf(where: ReturnType<typeof targets>): Promise<number> {
		return (await db.select({ n: count() }).from(members).where(where).get())?.n ?? 0;
	}

	/**
	 * Deliver `msgId` to the targets as they are now, in one statement: a member removed or
	 * deactivated while the body was being written is simply not matched. Running it again fills in
	 * deliveries an earlier attempt never wrote and leaves the rest alone. Returns how many it is for.
	 */
	async function deliver(mailboxId: string, msgId: string, where: ReturnType<typeof targets>) {
		await db
			.insert(deliveries)
			.select(
				db
					.select({
						mailboxId: sql<string>`${mailboxId}`.as("mailbox_id"),
						messageId: sql<string>`${msgId}`.as("message_id"),
						member: members.sigKey,
					})
					.from(members)
					.where(where),
			)
			.onConflictDoNothing();
		return countOf(where);
	}

	r.post("/:id/messages", mailboxParam, query(PostMessageQuerySchema), async (c) => {
		const { id: mailboxId } = c.req.valid("param");
		const { id: msgId, to } = c.req.valid("query");
		const caller = c.var.sigKey;
		const declared = declaredLength(c, MAX_MESSAGE_BYTES);
		const { retentionDays } = await requireMember(deps, mailboxId, caller, "active");
		if (!(await deps.entitlement.canPost(mailboxId))) throw new HttpError(402, "collect_only");
		const where = targets(mailboxId, caller, to);

		const prior = await senderOf(mailboxId, msgId);
		if (prior !== null) {
			if (prior !== caller) throw new HttpError(409, "id_conflict");
			// A repeat: the body is stored; make sure everyone it is for has a delivery.
			return c.json({
				stored: true,
				recipients: await deliver(mailboxId, msgId, where),
			} satisfies PostResponse);
		}
		if ((await countOf(where)) === 0)
			return c.json({ stored: false, recipients: 0 } satisfies PostResponse);
		await checkQuota(deps, mailboxId, declared + ROW_BYTES);

		// Body, then row, then deliveries: a crash leaves an orphan or an undelivered row the sweep
		// removes, never a delivery without a body.
		const key = messageKey(mailboxId, msgId);
		const size = await storeUpload(
			deps,
			c,
			key,
			declared,
			c.var.contentSha256,
			new HttpError(401, "bad_signature"),
		);
		const now = deps.now();
		await db
			.insert(messages)
			.values({
				mailboxId,
				id: msgId,
				sender: caller,
				size,
				createdAt: now,
				expiresAt: now + retentionDays * DAY_MS,
			})
			.onConflictDoNothing();
		if ((await senderOf(mailboxId, msgId)) !== caller) throw new HttpError(409, "id_conflict");
		const recipients = await deliver(mailboxId, msgId, where);
		if (recipients === 0) {
			// Everyone it was for left while it was being written.
			await deleteUndelivered(deps, mailboxId, { messages: [msgId], blobs: [] });
			return c.json({ stored: false, recipients: 0 } satisfies PostResponse);
		}
		return c.json({ stored: true, recipients } satisfies PostResponse);
	});

	r.post(
		"/:id/messages/:mid/replaces",
		messageParam,
		...signedJson(ReplacesBodySchema, REPLACES_JSON_BYTES),
		async (c) => {
			const { id: mailboxId, mid } = c.req.valid("param");
			const caller = c.var.sigKey;
			await requireMember(deps, mailboxId, caller, "active");
			// Only the snapshot's sender, and only for the snapshot's recipients: a device's state only
			// grows, so its snapshot holds everything it posted before.
			if ((await senderOf(mailboxId, mid)) !== caller) throw new HttpError(404, "not_found");
			const recipients = (
				await db
					.select({ member: deliveries.member })
					.from(deliveries)
					.where(and(eq(deliveries.mailboxId, mailboxId), eq(deliveries.messageId, mid)))
			).map((row) => row.member);
			const own: string[] = [];
			for (const part of chunk(c.req.valid("json").replaces, IN_LIST)) {
				const rows = await db
					.select({ id: messages.id })
					.from(messages)
					.where(
						and(
							eq(messages.mailboxId, mailboxId),
							eq(messages.sender, caller),
							ne(messages.id, mid),
							inArray(messages.id, part),
						),
					);
				own.push(...rows.map((row) => row.id));
			}
			for (const ids of chunk(own, 40)) {
				for (const who of chunk(recipients, 40)) {
					await db
						.delete(deliveries)
						.where(
							and(
								eq(deliveries.mailboxId, mailboxId),
								inArray(deliveries.messageId, ids),
								inArray(deliveries.member, who),
							),
						);
				}
			}
			await deleteUndelivered(deps, mailboxId, { messages: own, blobs: [] });
			return c.body(null, 204);
		},
	);

	r.get("/:id/inbox", mailboxParam, query(InboxQuerySchema), async (c) => {
		const { wantedAfter } = c.req.valid("query");
		const { id: mailboxId } = c.req.valid("param");
		const caller = c.var.sigKey;
		const { retentionDays } = await requireMember(deps, mailboxId, caller, "active");
		const now = deps.now();
		await db
			.update(members)
			.set({ lastCheckedDay: dayOf(now) })
			.where(and(eq(members.mailboxId, mailboxId), eq(members.sigKey, caller)));
		const rows = await db
			.select({
				id: messages.id,
				sender: messages.sender,
				size: messages.size,
				createdAt: messages.createdAt,
			})
			.from(deliveries)
			.innerJoin(
				messages,
				and(eq(messages.mailboxId, deliveries.mailboxId), eq(messages.id, deliveries.messageId)),
			)
			.where(and(eq(deliveries.mailboxId, mailboxId), eq(deliveries.member, caller)))
			.orderBy(asc(messages.createdAt), asc(messages.id))
			.limit(INBOX_PAGE + 1);
		const markers = await db
			.select({
				id: expiryMarkers.id,
				sender: expiryMarkers.sender,
				count: expiryMarkers.count,
				expiredAt: expiryMarkers.expiredAt,
			})
			.from(expiryMarkers)
			.where(and(eq(expiryMarkers.mailboxId, mailboxId), eq(expiryMarkers.member, caller)))
			.orderBy(asc(expiryMarkers.id));
		const blobRows = await db
			.select({
				hash: blobs.hash,
				size: blobs.size,
				uploader: blobs.uploader,
				createdAt: blobs.createdAt,
			})
			.from(blobDeliveries)
			.innerJoin(
				blobs,
				and(eq(blobs.mailboxId, blobDeliveries.mailboxId), eq(blobs.hash, blobDeliveries.hash)),
			)
			.where(and(eq(blobDeliveries.mailboxId, mailboxId), eq(blobDeliveries.member, caller)))
			.orderBy(asc(blobs.createdAt), asc(blobs.hash))
			.limit(INBOX_PAGE + 1);
		// What other active members want and have no delivery for, held or not, and who wants it:
		// the caller uploads any of these it has, to those of them its roster holds.
		const wantedBy = (upTo?: string) =>
			and(
				eq(blobWants.mailboxId, mailboxId),
				ne(blobWants.member, caller),
				wantedAfter ? gt(blobWants.hash, wantedAfter) : undefined,
				upTo ? lte(blobWants.hash, upTo) : undefined,
				eq(members.status, "active"),
				notExists(
					db
						.select({ one: sql`1` })
						.from(blobDeliveries)
						.where(
							and(
								eq(blobDeliveries.mailboxId, blobWants.mailboxId),
								eq(blobDeliveries.hash, blobWants.hash),
								eq(blobDeliveries.member, blobWants.member),
							),
						),
				),
			);
		const joined = and(
			eq(members.mailboxId, blobWants.mailboxId),
			eq(members.sigKey, blobWants.member),
		);
		const wantedHashes = await db
			.selectDistinct({ hash: blobWants.hash })
			.from(blobWants)
			.innerJoin(members, joined)
			.where(wantedBy())
			.orderBy(asc(blobWants.hash))
			.limit(INBOX_PAGE + 1);
		const page = wantedHashes.slice(0, INBOX_PAGE);
		const last = page.at(-1)?.hash;
		// The page is a run of hashes in order, so its wanters come from one range, not a long list.
		const wanters = last
			? await db
					.select({ hash: blobWants.hash, member: blobWants.member })
					.from(blobWants)
					.innerJoin(members, joined)
					.where(wantedBy(last))
					.orderBy(asc(blobWants.hash), asc(blobWants.member))
			: [];
		const by = new Map<string, string[]>();
		for (const w of wanters) by.set(w.hash, [...(by.get(w.hash) ?? []), w.member]);
		const response: InboxResponse = {
			messages: rows.slice(0, INBOX_PAGE),
			blobs: blobRows.slice(0, INBOX_PAGE),
			wanted: page.map((w) => ({ hash: w.hash, by: by.get(w.hash) ?? [] })),
			markers,
			wantedMore: wantedHashes.length > INBOX_PAGE,
			more: rows.length > INBOX_PAGE || blobRows.length > INBOX_PAGE,
			retentionDays,
			...(await deps.entitlement.usage(mailboxId)),
			serverTime: now,
		};
		return c.json(response);
	});

	r.get(
		"/:id/messages/:mid",
		param(z.object({ id: MailboxIdSchema, mid: MessageIdSchema })),
		async (c) => {
			const { id: mailboxId, mid } = c.req.valid("param");
			const caller = c.var.sigKey;
			await requireMember(deps, mailboxId, caller, "active");
			const pending = await db
				.select({ one: sql`1` })
				.from(deliveries)
				.where(
					and(
						eq(deliveries.mailboxId, mailboxId),
						eq(deliveries.messageId, mid),
						eq(deliveries.member, caller),
					),
				)
				.get();
			const found = pending ? await deps.bodies.get(messageKey(mailboxId, mid)) : null;
			if (!found) throw new HttpError(404, "not_found");
			return new Response(found.body, {
				headers: {
					"content-type": "application/octet-stream",
					"content-length": String(found.size),
				},
			});
		},
	);

	r.post("/:id/acks", mailboxParam, ...signedJson(AckBodySchema, ACK_JSON_BYTES), async (c) => {
		const { id: mailboxId } = c.req.valid("param");
		const caller = c.var.sigKey;
		await requireMember(deps, mailboxId, caller, "active");
		const body = c.req.valid("json");
		// Only the caller's own deliveries: an id it was never sent changes nothing, and only what it
		// held is a candidate for deletion (a message mid-post has no deliveries yet).
		const held: Candidates = { messages: [], blobs: [] };
		for (const ids of chunk(body.messages, IN_LIST)) {
			const gone = await db
				.delete(deliveries)
				.where(
					and(
						eq(deliveries.mailboxId, mailboxId),
						eq(deliveries.member, caller),
						inArray(deliveries.messageId, ids),
					),
				)
				.returning({ id: deliveries.messageId });
			held.messages.push(...gone.map((g) => g.id));
		}
		for (const hashes of chunk(body.blobs, IN_LIST)) {
			const gone = await db
				.delete(blobDeliveries)
				.where(
					and(
						eq(blobDeliveries.mailboxId, mailboxId),
						eq(blobDeliveries.member, caller),
						inArray(blobDeliveries.hash, hashes),
					),
				)
				.returning({ hash: blobDeliveries.hash });
			held.blobs.push(...gone.map((g) => g.hash));
		}
		for (const ids of chunk(body.markers, IN_LIST)) {
			await db
				.delete(expiryMarkers)
				.where(
					and(
						eq(expiryMarkers.mailboxId, mailboxId),
						eq(expiryMarkers.member, caller),
						inArray(expiryMarkers.id, ids),
					),
				);
		}
		await deleteUndelivered(deps, mailboxId, held);
		return c.body(null, 204);
	});

	return r;
}
