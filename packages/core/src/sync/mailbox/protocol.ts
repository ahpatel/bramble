// The mailbox wire protocol, shared by every client and both servers (docs/mailbox-service.md).
// Imports only zod: services/mailbox runs this file directly under Node, which cannot resolve
// this package's extensionless imports or @core aliases.

import { z } from "zod";

export const SIGNING_DOMAIN = "bramble-mailbox/v1";

export const HEADERS = {
	key: "x-bramble-key",
	time: "x-bramble-time",
	contentSha256: "x-bramble-content-sha256",
	sig: "x-bramble-sig",
	token: "x-bramble-token",
	/** The hosted service's account number: a bearer secret, so a header, never a URL. */
	account: "x-bramble-account",
} as const;

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** The same bound as HLC_MAX_DRIFT_MS. */
export const MAX_CLOCK_SKEW_MS = 300_000;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** A 90 MiB attachment sealed, under the Workers 100 MB request cap. */
export const MAX_BLOB_BYTES = 95_000_000;
export const INBOX_PAGE = 500;
export const MAX_LIST = 1000;
export const MAX_WANTS = 10_000;
export const MAX_MEMBERS = 64;

/** 32 bytes, base64url without padding. */
export const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** 16 bytes, base64url without padding. */
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** A roster Ed25519 verify key: 32 bytes, standard base64. */
export const SIG_KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
/** SHA-256 hex over a blob's ciphertext, the blob store's key. */
export const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

export const SigKeySchema = z.string().regex(SIG_KEY_RE);
export const MailboxIdSchema = z.string().regex(MAILBOX_ID_RE);
export const MessageIdSchema = z.string().regex(MESSAGE_ID_RE);
export const BlobHashSchema = z.string().regex(BLOB_HASH_RE);
const RetentionDaysSchema = z.int().min(1).max(3650);
const keys = (min = 0) => z.array(SigKeySchema).min(min).max(MAX_MEMBERS);

export const CreateMailboxBodySchema = z.object({
	members: keys(1),
	retentionDays: RetentionDaysSchema.optional(),
});
export type CreateMailboxBody = z.infer<typeof CreateMailboxBodySchema>;

export const SettingsBodySchema = z.object({ retentionDays: RetentionDaysSchema });
export type SettingsBody = z.infer<typeof SettingsBodySchema>;

export const MembersBodySchema = z.object({ add: keys().default([]), remove: keys().default([]) });
export type MembersBody = z.infer<typeof MembersBodySchema>;

export const ActivationBodySchema = z.object({ active: z.boolean() });
export type ActivationBody = z.infer<typeof ActivationBodySchema>;

/** Recipients' keys, comma-separated (URL-encode them). */
const recipients = z
	.string()
	.transform((s) => s.split(","))
	.pipe(keys(1));

/**
 * A post's query string. The request body is the sealed envelope itself, raw bytes, which the
 * server streams into storage against the signed content hash and never decodes. `to` lists the
 * recipients; without it, every other active member.
 */
export const PostMessageQuerySchema = z.object({
	id: MessageIdSchema,
	to: recipients.optional(),
});
export type PostMessageQuery = z.infer<typeof PostMessageQuerySchema>;

/** A blob upload's query string: who it is for, always named. */
export const BlobPutQuerySchema = z.object({ to: recipients });

/** Compaction: the caller's earlier messages a snapshot it posted replaces, for its recipients. */
export const ReplacesBodySchema = z.object({
	replaces: z.array(MessageIdSchema).min(1).max(MAX_LIST),
});
export type ReplacesBody = z.infer<typeof ReplacesBodySchema>;

export const AckBodySchema = z.object({
	messages: z.array(MessageIdSchema).max(MAX_LIST).default([]),
	blobs: z.array(BlobHashSchema).max(MAX_LIST).default([]),
	markers: z.array(z.int().min(1)).max(MAX_LIST).default([]),
});
export type AckBody = z.infer<typeof AckBodySchema>;

export const WantsBodySchema = z.object({ hashes: z.array(BlobHashSchema).max(MAX_WANTS) });
export type WantsBody = z.infer<typeof WantsBodySchema>;

export const MemberStatusSchema = z.enum(["eligible", "active"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

export const MembersResponseSchema = z.object({
	members: z.array(
		z.object({
			sigKey: SigKeySchema,
			status: MemberStatusSchema,
			lastCheckedDay: z.int().nullable(),
		}),
	),
});
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

export const PostResponseSchema = z.object({ stored: z.boolean(), recipients: z.int().min(0) });
export type PostResponse = z.infer<typeof PostResponseSchema>;

export const InboxResponseSchema = z.object({
	messages: z
		.array(
			z.object({ id: MessageIdSchema, sender: SigKeySchema, size: z.int(), createdAt: z.int() }),
		)
		.max(INBOX_PAGE),
	blobs: z
		.array(
			z.object({ hash: BlobHashSchema, size: z.int(), uploader: SigKeySchema, createdAt: z.int() }),
		)
		.max(INBOX_PAGE),
	/** Hashes other active members want and have no delivery for, held or not, in hash order. */
	wanted: z.array(z.object({ hash: BlobHashSchema, by: keys(1) })).max(INBOX_PAGE),
	/** More wanted hashes follow the last one: ask again with `wantedAfter` set to it. */
	wantedMore: z.boolean(),
	markers: z
		.array(z.object({ id: z.int(), sender: SigKeySchema, count: z.int(), expiredAt: z.int() }))
		.max(INBOX_PAGE),
	/** More messages or blobs wait for the caller: collect and acknowledge these, then ask again. */
	more: z.boolean(),
	retentionDays: z.int(),
	usedBytes: z.int(),
	quotaBytes: z.int().nullable(),
	serverTime: z.int(),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const InboxQuerySchema = z.object({ wantedAfter: BlobHashSchema.optional() });
export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const MAILBOX_ERROR_CODES = [
	"bad_request",
	"bad_signature",
	"stale_time",
	"token_required",
	"not_member",
	"not_active",
	"not_eligible",
	"not_found",
	"exists",
	"id_conflict",
	"too_large",
	"quota_exceeded",
	"hash_mismatch",
	"collect_only",
	"account_required",
	"account_unknown",
	"rate_limited",
] as const;
export const MailboxErrorCodeSchema = z.enum(MAILBOX_ERROR_CODES);
export type MailboxErrorCode = z.infer<typeof MailboxErrorCodeSchema>;

/**
 * An app built with `--mode sandbox` uses the sandbox mailbox, whose accounts are bought with Stripe
 * test cards on the website's sandbox build (`pnpm --filter website deploy:sandbox`). Vite replaces
 * MODE at build, so a release build holds only the real addresses. Optional: the mailbox server
 * imports this file outside Vite, where import.meta.env doesn't exist.
 */
const SANDBOX = import.meta.env?.MODE === "sandbox";

/** Bramble's hosted mailbox. */
export const HOSTED_MAILBOX_URL = SANDBOX
	? "https://mailbox-sandbox.bramble.sh"
	: "https://mailbox.bramble.sh";
/** Where a hosted account is opened and paid for (docs/mailbox-service.md, "Buying from the apps"). */
export const ACCOUNT_PAGE_URL = SANDBOX
	? "https://sandbox.bramble-website-chc.pages.dev/account"
	: "https://bramble.sh/account";
export const ACCOUNT_DIGITS = 25;

/** "12345 67890 …" from 25 digits. */
export function formatAccountNumber(digits: string): string {
	return digits.replace(/(\d{5})(?=\d)/g, "$1 ");
}

/** An account number however it is spaced or dashed, as five groups of five; null for anything else. */
export function parseAccountNumber(input: string): string | null {
	const digits = input.replace(/[\s-]/g, "");
	return new RegExp(`^\\d{${ACCOUNT_DIGITS}}$`).test(digits) ? formatAccountNumber(digits) : null;
}

/** The account page, the number in its fragment: browsers never send a fragment to a server. */
export function accountPageUrl(number?: string): string {
	const parsed = number ? parseAccountNumber(number) : null;
	return parsed ? `${ACCOUNT_PAGE_URL}#n=${parsed.replace(/ /g, "")}` : ACCOUNT_PAGE_URL;
}

/** The number an account page's fragment carries, or null. */
export function accountFromFragment(hash: string): string | null {
	const digits = /^#?n=(\d+)$/.exec(hash)?.[1];
	return digits ? parseAccountNumber(digits) : null;
}

/** What is kept of an account number where it needn't be read back: a hash of its digits. */
export async function accountKeyOf(number: string): Promise<string> {
	return sha256Hex(number.replace(/\D/g, ""));
}

/** The hosted service's answer about an account (`GET /v1/accounts/status`). */
export const AccountStatusResponseSchema = z.object({
	paidThrough: z.int().min(0),
	frozen: z.boolean(),
	usedBytes: z.int().min(0),
	quotaBytes: z.int().min(0),
});
export type AccountStatusResponse = z.infer<typeof AccountStatusResponseSchema>;

export const ErrorResponseSchema = z.object({
	error: MailboxErrorCodeSchema,
	serverTime: z.int().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** The string a request's Ed25519 signature covers. */
export function canonicalRequest(r: {
	method: string;
	pathAndQuery: string;
	time: number;
	contentSha256: string;
}): string {
	return [
		SIGNING_DOMAIN,
		r.method.toUpperCase(),
		r.pathAndQuery,
		String(r.time),
		r.contentSha256,
	].join("\n");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
	);
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
