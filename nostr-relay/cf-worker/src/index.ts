// Bramble signaling relay as a Cloudflare Worker + Durable Object.
//
// Behaviourally identical to signaling/relay.mjs (the node self-host version):
// a minimal Nostr subset (REQ / EVENT / CLOSE) that fans out *ephemeral* events
// (kind 20000-29999) to current subscribers and stores nothing. The vault never
// trusts it; it only relays encrypted, group-key-addressed signaling blobs.
//
// It also serves the MAILBOX (see the routes below): opaque per-recipient
// envelopes stored until picked up — ciphertext only, TTL'd, unverified here
// (the recipient checks the sender's roster signature). See ADR-0008.
//
// Why a Durable Object: Workers are stateless, so the set of connected sockets
// can't live in a module global. One global DO ("relay") owns every socket and
// does the fan-out, mirroring the node Set. Sockets are accepted as hibernatable
// (`acceptWebSocket`), so the DO is evicted from memory while idle and billed
// only when a message arrives; per-connection REQ subscriptions ride along on
// the socket attachment so they survive that eviction.

import { DurableObject } from "cloudflare:workers";

// Keepalive, in parity with node/relay.mjs and @core/sync/signaling-client. Cloudflare drops an
// idle WebSocket after a minute or two, which for a password manager syncing in the background is
// most of the time. Registered as a hibernation auto-response so the runtime answers it without
// waking (and billing) the Durable Object; the explicit branch in webSocketMessage covers a socket
// that predates the registration.
const PING = "ping";
const PONG = "pong";

// Cheap abuse guards for the dumb pipe. A signaling blob is a few KB of
// encrypted SDP/ICE, so reject anything larger before parsing: Cloudflare now
// allows WebSocket frames up to 32 MiB, and parsing attacker-sized payloads on
// a single-threaded Durable Object is the obvious cost/DoS footgun. A device
// needs ~1 room subscription, so bound subs-per-connection too (caps both the
// fan-out inner loop and the serialized attachment).
const MAX_MSG_BYTES = 64 * 1024;
const MAX_SUBS_PER_CONN = 8;

// The mailbox (ADR-0008): a store-and-forward postbox for peers that aren't
// online. The DO stores opaque per-recipient envelopes — it cannot read them
// (ciphertext) and does not verify them (the recipient checks the sender's
// roster signature on pull). Limits mirror @core/sync/mailbox.
const MAX_MAILBOX_ENVELOPE_BYTES = 256 * 1024;
const MAX_MAILBOX_PER_RECIPIENT = 64;
const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// POST /ice-servers mints short-lived Cloudflare TURN creds so peers across
// networks/VPNs can relay. See docs/p2p-sync.md. TURN usage is METERED, so this
// endpoint is the one place an open relay can cost real money: it is rate-limited
// per IP, and if the ICE_SECRET binding is set, it additionally requires
// ?k=<secret> on the request (clients put the secret in their stored ICE URL).
const TURN_TTL_SECONDS = 86400;
const ICE_LIMIT = 10; // mints per IP per window
const ICE_WINDOW_MS = 60 * 60 * 1000;
const PUSH_LIMIT = 120; // mailbox pushes per IP per window
const PUSH_WINDOW_MS = 60 * 60 * 1000;
const WS_EVENTS_LIMIT = 120; // broadcasts per connection per window
const WS_EVENTS_WINDOW_MS = 60 * 1000;
// Global mailbox row cap: kills the "unlimited recipients" storage-fill vector.
// Oldest rows are evicted first — sync rebroadcasts, so nothing permanent is lost.
const MAX_MAILBOX_ROWS = 4096;

// Abuse damping, in-memory (resets on DO eviction: fine for damping, not for
// correctness). Single-threaded DO, so no locking needed.
const iceHits = new Map<string, number[]>();
const pushHits = new Map<string, number[]>();

/** Sliding-window limiter: records a hit for key, returns true if within limit. */
function withinLimit(
	map: Map<string, number[]>,
	key: string,
	limit: number,
	windowMs: number,
	now: number,
): boolean {
	const hits = (map.get(key) ?? []).filter((t) => now - t < windowMs);
	if (hits.length >= limit) {
		map.set(key, hits);
		return false;
	}
	hits.push(now);
	map.set(key, hits);
	if (map.size > 10_000) {
		// Bound the map itself: drop the oldest key entirely.
		const first = map.keys().next().value;
		if (first !== undefined) map.delete(first);
	}
	return true;
}
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

// TURN secrets are `wrangler secret put`, so absent from the generated Env.
interface RelayEnv extends Env {
	TURN_KEY_TOKEN_ID?: string;
	TURN_KEY_API_TOKEN?: string;
	/** Optional: when set, /ice-servers requires ?k=<secret> on the request.
	 * Unset = open (self-host default), still rate-limited. */
	ICE_SECRET?: string;
}

const jsonCors = (body: string, status = 200): Response =>
	new Response(body, { status, headers: { "Content-Type": "application/json", ...CORS } });

// Empty list on any failure → client falls back to host-only candidates.
async function handleIceServers(env: RelayEnv): Promise<Response> {
	const { TURN_KEY_TOKEN_ID: id, TURN_KEY_API_TOKEN: token } = env;
	if (!id || !token) return jsonCors(JSON.stringify({ iceServers: [] }));
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
		},
	);
	if (!res.ok) return jsonCors(JSON.stringify({ iceServers: [], error: `turn ${res.status}` }));
	return jsonCors(await res.text());
}

/** A subscriber's REQ filters, keyed by subscription id. Stored as the socket
 *  attachment so it persists across hibernation. */
type Subs = Record<string, NostrFilter[]>;
type NostrFilter = {
	kinds?: number[];
	authors?: string[];
	[tag: `#${string}`]: string[] | undefined;
};
type NostrEvent = {
	id?: string;
	kind: number;
	pubkey?: string;
	tags?: string[][];
	content?: string;
};

/** True if `event` matches a single REQ `filter` (kinds, authors, #<tag>). */
function matches(filter: NostrFilter, event: NostrEvent): boolean {
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !(event.pubkey && filter.authors.includes(event.pubkey))) return false;
	for (const [key, vals] of Object.entries(filter)) {
		if (!key.startsWith("#") || !Array.isArray(vals)) continue;
		const tag = key.slice(1);
		const present = event.tags?.filter((t) => t[0] === tag).map((t) => t[1]) ?? [];
		// key starts with "#", so this is a tag filter: values are strings.
		if (!(vals as string[]).some((v) => present.includes(v))) return false;
	}
	return true;
}

export class Relay extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Answered while hibernating, so an idle-but-alive client costs nothing to keep.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	async fetch(req: Request): Promise<Response> {
		// Non-WebSocket hits (health probe, mailbox or ICE API) get handled here.
		if (req.headers.get("Upgrade") !== "websocket") {
			const { pathname } = new URL(req.url);
			if (pathname === "/ice-servers") {
				return this.iceServers(req);
			}
			const mailbox = /^\/mailbox\/([^/]+)\/([^/]+)$/.exec(pathname);
			if (mailbox) {
				const [, room, recipient] = mailbox;
				switch (req.method) {
					case "POST":
						return this.mailboxPush(decodeURIComponent(room), decodeURIComponent(recipient), req);
					case "GET":
						return this.mailboxPull(decodeURIComponent(room), decodeURIComponent(recipient));
					default:
						return new Response("method not allowed", { status: 405 });
				}
			}
			return new Response("bramble signaling relay", { status: 200 });
		}

		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server); // hibernatable
		server.serializeAttachment({} satisfies Subs);
		return new Response(null, { status: 101, webSocket: client });
	}

	// --- mailbox (ADR-0008): opaque per-recipient envelopes, pop on pull ---

	#ensureSchema(): void {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS mailbox (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				room TEXT NOT NULL,
				recipient TEXT NOT NULL,
				envelope TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`,
		);
	}

	/** Mint short-lived TURN credentials. Rate-limited per IP; requires
	 * ?k=ICE_SECRET when that secret is configured (unset = open, the
	 * self-host default). TURN usage is metered, so this endpoint is the one
	 * place abuse can cost real money. */
	async iceServers(req: Request): Promise<Response> {
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}
		if (req.method !== "POST") {
			return new Response("method not allowed", { status: 405, headers: CORS });
		}
		const url = new URL(req.url);
		const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
		const secret = (this.env as RelayEnv).ICE_SECRET;
		if (secret && url.searchParams.get("k") !== secret) {
			return new Response("unauthorized", { status: 401 });
		}
		if (!withinLimit(iceHits, ip, ICE_LIMIT, ICE_WINDOW_MS, Date.now())) {
			return jsonCors(JSON.stringify({ iceServers: [], error: "rate limited" }), 429);
		}
		return handleIceServers(this.env as RelayEnv);
	}

	#purgeExpired(now: number): void {
		this.#ensureSchema();
		this.ctx.storage.sql.exec("DELETE FROM mailbox WHERE created_at < ?", now - MAILBOX_TTL_MS);
	}

	async mailboxPush(room: string, recipient: string, req: Request): Promise<Response> {
		const now = Date.now();
		this.#purgeExpired(now);
		const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
		if (!withinLimit(pushHits, ip, PUSH_LIMIT, PUSH_WINDOW_MS, now)) {
			return new Response("rate limited", { status: 429 });
		}
		const body = await req.text();
		if (body.length > MAX_MAILBOX_ENVELOPE_BYTES) {
			return new Response("envelope too large", { status: 413 });
		}
		// Per-queue cap: evict the OLDEST entry rather than rejecting. A spammer
		// saturating a queue they know just gets their own junk dropped; legitimate
		// mail (sent after their burst) still lands.
		const overflow = this.ctx.storage.sql
			.exec(
				"SELECT seq FROM mailbox WHERE room = ? AND recipient = ? ORDER BY seq DESC LIMIT -1 OFFSET ?",
				room,
				recipient,
				MAX_MAILBOX_PER_RECIPIENT - 1,
			)
			.toArray();
		for (const r of overflow) {
			this.ctx.storage.sql.exec("DELETE FROM mailbox WHERE seq = ?", r.seq as number);
		}
		// Global row cap: evict oldest rows across all queues, so the
		// "unlimited recipients" storage-fill vector dies. Sync rebroadcasts, so
		// evicted mail re-arrives.
		const total = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM mailbox").toArray();
		const over = ((total[0]?.n as number) ?? 0) - MAX_MAILBOX_ROWS;
		if (over > 0) {
			this.ctx.storage.sql.exec(
				"DELETE FROM mailbox WHERE seq IN (SELECT seq FROM mailbox ORDER BY seq LIMIT ?)",
				over,
			);
		}
		this.ctx.storage.sql.exec(
			"INSERT INTO mailbox (room, recipient, envelope, created_at) VALUES (?, ?, ?, ?)",
			room,
			recipient,
			body,
			now,
		);
		return new Response(null, { status: 204 });
	}

	async mailboxPull(room: string, recipient: string): Promise<Response> {
		this.#purgeExpired(Date.now());
		const rows = this.ctx.storage.sql
			.exec(
				"SELECT seq, envelope FROM mailbox WHERE room = ? AND recipient = ? ORDER BY seq",
				room,
				recipient,
			)
			.toArray();
		const envelopes = rows.map((r) => r.envelope as string);
		// Pop on pull: sync rebroadcasts continuously while peers are online, so a
		// delivery lost between this response and the client re-arrives via a live
		// push. Keeping it would need acks; not worth the state.
		this.ctx.storage.sql.exec(
			"DELETE FROM mailbox WHERE room = ? AND recipient = ?",
			room,
			recipient,
		);
		return new Response(JSON.stringify(envelopes), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		if ((typeof raw === "string" ? raw.length : raw.byteLength) > MAX_MSG_BYTES) return;
		if (raw === PING) return void ws.send(PONG); // normally the auto-response; see PING

		let msg: unknown;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;

		switch (msg[0]) {
			case "REQ": {
				const [, subId, ...filters] = msg;
				const subs = ws.deserializeAttachment() as Subs;
				if (!(subId in subs) && Object.keys(subs).length >= MAX_SUBS_PER_CONN) return;
				subs[subId] = filters;
				ws.serializeAttachment(subs);
				ws.send(JSON.stringify(["EOSE", subId])); // no stored events: ephemeral only
				return;
			}
			case "CLOSE": {
				const subs = ws.deserializeAttachment() as Subs;
				delete subs[msg[1]];
				ws.serializeAttachment(subs);
				return;
			}
			case "EVENT": {
				const event = msg[1] as NostrEvent;
				if (!event || event.kind < 20000 || event.kind >= 30000) {
					ws.send(JSON.stringify(["OK", event?.id ?? "", false, "only ephemeral kinds"]));
					return;
				}
				// Per-connection broadcast limit: stored on the attachment so it
				// survives hibernation. Exceeding it silently drops (the sender's
				// periodic re-broadcast recovers); sustained abuse just gets ignored.
				const rate = (ws.deserializeAttachment() as Subs & { __rate?: number[] }) ?? {};
				const now = Date.now();
				const hits = (rate.__rate ?? []).filter((t) => now - t < WS_EVENTS_WINDOW_MS);
				if (hits.length >= WS_EVENTS_LIMIT) {
					rate.__rate = hits;
					ws.serializeAttachment(rate);
					ws.send(JSON.stringify(["OK", event.id ?? "", false, "rate limited"]));
					return;
				}
				hits.push(now);
				rate.__rate = hits;
				ws.serializeAttachment(rate);
				// Fan out to every other socket's matching subscription; store nothing.
				for (const peer of this.ctx.getWebSockets()) {
					if (peer === ws) continue;
					const subs = peer.deserializeAttachment() as Subs | null;
					if (!subs) continue;
					for (const [subId, filters] of Object.entries(subs)) {
						if (filters.some((f) => matches(f, event))) {
							peer.send(JSON.stringify(["EVENT", subId, event]));
							break;
						}
					}
				}
				ws.send(JSON.stringify(["OK", event.id ?? "", true, ""]));
				return;
			}
		}
	}
}

export default {
	// Signaling WS → the global DO; POST /ice-servers handled here in the Worker.
	async fetch(req: Request, env: RelayEnv): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (req.headers.get("Upgrade") !== "websocket") {
			// Mailbox routes go to the DO; the health probe stays here.
			if (pathname.startsWith("/mailbox/")) {
				return env.RELAY.getByName("relay").fetch(req);
			}
			if (pathname === "/ice-servers" || pathname.startsWith("/mailbox/")) {
				return env.RELAY.getByName("relay").fetch(req);
			}
			return new Response("bramble signaling relay", { status: 200 });
		}
		return env.RELAY.getByName("relay").fetch(req);
	},
} satisfies ExportedHandler<RelayEnv>;
