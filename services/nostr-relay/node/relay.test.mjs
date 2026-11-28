// The relay as a black box: started on a free port with a given environment, asked over HTTP and
// WebSocket as a client would. Run with `pnpm test:scripts` (node --test).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "relay.mjs");
const ICE = JSON.stringify([{ urls: ["stun:s.example:3478", "turn:t.example:3478"] }]);
const SECRET = "test-secret";

/** The relay on a free port, with only `env` set. */
async function start(env) {
	const child = spawn(process.execPath, [RELAY], {
		env: { PATH: process.env.PATH, PORT: "0", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	const port = await new Promise((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const match = /ws:\/\/localhost:(\d+)/.exec(out);
			if (match) resolve(Number(match[1]));
		});
		child.once("exit", (code) => reject(new Error(`relay exited with ${code}: ${out}`)));
	});
	return {
		http: `http://127.0.0.1:${port}`,
		ws: `ws://127.0.0.1:${port}`,
		async stop() {
			child.kill();
			await once(child, "exit");
		},
	};
}

/**
 * The relay started with `env`, expected to refuse: its exit code and what it printed. A relay that
 * starts instead fails the test at once, rather than hanging the suite.
 */
async function refusal(env) {
	const child = spawn(process.execPath, [RELAY], {
		env: { PATH: process.env.PATH, PORT: "0", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const timer = setTimeout(() => child.kill(), 10_000);
	const [code, signal] = await once(child, "exit");
	clearTimeout(timer);
	if (signal) throw new Error(`the relay started instead of refusing: ${output}`);
	return { code, output };
}

async function exitCode(env) {
	return (await refusal(env)).code;
}

async function ice(relay, { forwardedFor, query = "", ticket } = {}) {
	const res = await fetch(`${relay.http}/ice-servers${query}`, {
		method: "POST",
		headers: {
			...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
			...(ticket ? { "content-type": "text/plain" } : {}),
		},
		...(ticket ? { body: JSON.stringify({ ticket }) } : {}),
	});
	return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

/** A socket's ticket, as the app gets it; `publish` sends one room event, as its hello does. */
async function ticketFor(relay, { publish = true } = {}) {
	const ws = new WebSocket(relay.ws);
	await once(ws, "open");
	const next = (type) =>
		new Promise((resolve) => {
			const onMessage = (ev) => {
				const msg = JSON.parse(ev.data);
				if (msg[0] !== type) return;
				ws.removeEventListener("message", onMessage);
				resolve(msg);
			};
			ws.addEventListener("message", onMessage);
		});
	const answer = next("BRAMBLE_TICKET");
	ws.send(JSON.stringify(["BRAMBLE_TICKET"]));
	const [, ticket] = await answer;
	if (publish) {
		const ok = next("OK");
		ws.send(JSON.stringify(["EVENT", { kind: 20000, tags: [["d", "room"]], content: "hello" }]));
		await ok;
	}
	return { ticket, ws };
}

const turnOf = (body) => body.iceServers.find((s) => s.urls.some((u) => u.startsWith("turn:")));

/** Whether a socket to `url` opens (true) or is refused (false). */
function opens(url) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		ws.addEventListener("open", () => {
			ws.close();
			resolve(true);
		});
		ws.addEventListener("error", () => resolve(false));
	});
}

describe("TURN credentials", () => {
	it("last two hours, and carry a tag for their requester rather than its address", async () => {
		const relay = await start({ ICE_SERVERS: ICE, TURN_SECRET: SECRET });
		try {
			const before = Math.floor(Date.now() / 1000);
			const first = await ice(relay);
			const turn = turnOf(first.body);
			const [expiry, tag] = turn.username.split(":");
			assert.equal(first.body.ttl, 7200);
			assert.ok(Math.abs(Number(expiry) - (before + 7200)) <= 5);
			assert.match(tag, /^[0-9a-f]{16}$/);
			assert.equal(turn.credential, createHmac("sha1", SECRET).update(turn.username).digest("base64"));
			const again = turnOf((await ice(relay)).body);
			assert.equal(again.username.split(":")[1], tag);
		} finally {
			await relay.stop();
		}
	});

	it("are STUN only for a requester over its allowance", async () => {
		const relay = await start({ ICE_SERVERS: ICE, TURN_SECRET: SECRET, ICE_TICKETLESS_PER_MINUTE: "2" });
		try {
			assert.ok(turnOf((await ice(relay)).body));
			assert.ok(turnOf((await ice(relay)).body));
			const over = await ice(relay);
			assert.equal(over.status, 200);
			assert.deepEqual(over.body.iceServers, [{ urls: ["stun:s.example:3478"] }]);
		} finally {
			await relay.stop();
		}
	});

	it("ignore X-Forwarded-For unless it comes from a trusted proxy", async () => {
		const relay = await start({ ICE_SERVERS: ICE, TURN_SECRET: SECRET, ICE_TICKETLESS_PER_MINUTE: "1" });
		try {
			assert.ok(turnOf((await ice(relay, { forwardedFor: "203.0.113.1" })).body));
			// Same socket address, so the same allowance, whatever the header claims.
			assert.equal(turnOf((await ice(relay, { forwardedFor: "203.0.113.2" })).body), undefined);
		} finally {
			await relay.stop();
		}
	});

	it("count each forwarded requester apart behind a trusted proxy, an IPv6 /64 as one", async () => {
		const relay = await start({
			ICE_SERVERS: ICE,
			TURN_SECRET: SECRET,
			ICE_TICKETLESS_PER_MINUTE: "1",
			TRUST_PROXY: "127.0.0.1, ::1",
		});
		try {
			const a = turnOf((await ice(relay, { forwardedFor: "198.51.100.9, 203.0.113.1" })).body);
			const b = turnOf((await ice(relay, { forwardedFor: "203.0.113.2" })).body);
			assert.ok(a && b);
			assert.notEqual(a.username.split(":")[1], b.username.split(":")[1]);
			assert.equal(turnOf((await ice(relay, { forwardedFor: "203.0.113.1" })).body), undefined);
			assert.ok(turnOf((await ice(relay, { forwardedFor: "2001:db8:1:2::1" })).body));
			assert.equal(turnOf((await ice(relay, { forwardedFor: "2001:db8:1:2::ff" })).body), undefined);
		} finally {
			await relay.stop();
		}
	});
});

describe("tickets", () => {
	const limits = {
		ICE_SERVERS: ICE,
		TURN_SECRET: SECRET,
		ICE_REQUESTS_PER_MINUTE: "3",
		ICE_TICKETLESS_PER_MINUTE: "1",
	};

	it("give a live sync socket the full allowance", async () => {
		const relay = await start(limits);
		try {
			const { ticket, ws } = await ticketFor(relay);
			for (let i = 0; i < 3; i++) assert.ok(turnOf((await ice(relay, { ticket })).body));
			assert.equal(turnOf((await ice(relay, { ticket })).body), undefined);
			ws.close();
		} finally {
			await relay.stop();
		}
	});

	it("don't count from a socket that never published, or has closed", async () => {
		const relay = await start({ ...limits, ICE_TICKETLESS_PER_MINUTE: "2" });
		try {
			const quiet = await ticketFor(relay, { publish: false });
			assert.ok(turnOf((await ice(relay, { ticket: quiet.ticket })).body));
			const gone = await ticketFor(relay);
			gone.ws.close();
			await once(gone.ws, "close");
			assert.ok(turnOf((await ice(relay, { ticket: gone.ticket })).body));
			// Both were counted as ticketless, so the allowance of two is spent.
			assert.equal(turnOf((await ice(relay, { ticket: gone.ticket })).body), undefined);
			quiet.ws.close();
		} finally {
			await relay.stop();
		}
	});

	it("once required, leave a ticketless request STUN only", async () => {
		const relay = await start({ ...limits, ICE_REQUIRE_TICKET: "1" });
		try {
			assert.deepEqual((await ice(relay)).body.iceServers, [{ urls: ["stun:s.example:3478"] }]);
			const { ticket, ws } = await ticketFor(relay);
			assert.ok(turnOf((await ice(relay, { ticket })).body));
			ws.close();
		} finally {
			await relay.stop();
		}
	});
});

describe("relay information (NIP-11)", () => {
	const askInfo = (url) => fetch(url, { headers: { accept: "application/nostr+json" } });

	it("describes the relay and its real limits to a client that asks", async () => {
		const relay = await start({});
		try {
			const res = await askInfo(relay.http);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "application/nostr+json");
			assert.equal(res.headers.get("access-control-allow-origin"), "*");
			const info = await res.json();
			assert.deepEqual(info.supported_nips, [1, 11]);
			assert.equal(info.limitation.max_message_length, 64 * 1024);
			assert.equal(info.limitation.max_subscriptions, 8);
			assert.equal(info.limitation.max_subid_length, 64);
			assert.match(info.description, /does not verify signatures/);
		} finally {
			await relay.stop();
		}
	});

	it("still answers a plain request with the banner", async () => {
		const relay = await start({});
		try {
			const res = await fetch(relay.http);
			assert.equal(res.headers.get("content-type"), "text/plain");
			assert.equal(await res.text(), "bramble signaling relay");
		} finally {
			await relay.stop();
		}
	});

	it("is open on a private relay, like the banner", async () => {
		const relay = await start({ RELAY_TOKEN: "abcdefghijklmnop1234" });
		try {
			assert.deepEqual((await (await askInfo(relay.http)).json()).supported_nips, [1, 11]);
		} finally {
			await relay.stop();
		}
	});
});

describe("private mode", () => {
	const TOKEN = "abcdefghijklmnop1234";

	it("refuses sockets and ICE requests without the token, and keeps the health probe open", async () => {
		const relay = await start({ ICE_SERVERS: ICE, TURN_SECRET: SECRET, RELAY_TOKEN: TOKEN });
		try {
			assert.equal((await ice(relay)).status, 401);
			assert.equal((await ice(relay, { query: "?token=abcdefghijklmnop9999" })).status, 401);
			assert.ok(turnOf((await ice(relay, { query: `?token=${TOKEN}` })).body));
			assert.equal(await opens(relay.ws), false);
			assert.equal(await opens(`${relay.ws}/?token=${TOKEN}`), true);
			assert.equal((await fetch(relay.http)).status, 200);
		} finally {
			await relay.stop();
		}
	});

	it("won't start with a token too short to be a secret", async () => {
		assert.notEqual(await exitCode({ RELAY_TOKEN: "short" }), 0);
	});
});

describe("secrets from files", () => {
	const TOKEN = "abcdefghijklmnop1234";

	/** `files` written to a fresh directory; `run` gets their paths, and the directory goes after. */
	async function withFiles(files, run) {
		const dir = mkdtempSync(path.join(tmpdir(), "relay-secrets-"));
		try {
			const paths = {};
			for (const [name, contents] of Object.entries(files)) {
				paths[name] = path.join(dir, name);
				writeFileSync(paths[name], contents);
			}
			await run(paths);
		} finally {
			rmSync(dir, { recursive: true });
		}
	}

	it("reads RELAY_TOKEN_FILE and TURN_SECRET_FILE, without their final newline", async () => {
		await withFiles({ token: `${TOKEN}\n`, turn: `${SECRET}\n` }, async (f) => {
			const relay = await start({
				ICE_SERVERS: ICE,
				TURN_SECRET_FILE: f.turn,
				RELAY_TOKEN_FILE: f.token,
			});
			try {
				assert.equal(await opens(relay.ws), false);
				assert.equal(await opens(`${relay.ws}/?token=${TOKEN}`), true);
				const turn = turnOf((await ice(relay, { query: `?token=${TOKEN}` })).body);
				const expected = createHmac("sha1", SECRET).update(turn.username).digest("base64");
				assert.equal(turn.credential, expected);
			} finally {
				await relay.stop();
			}
		});
	});

	it("refuses a secret and its file together, or a file it can't read", async () => {
		await withFiles({ token: TOKEN }, async (f) => {
			const both = await refusal({ RELAY_TOKEN: TOKEN, RELAY_TOKEN_FILE: f.token });
			assert.notEqual(both.code, 0);
			assert.match(both.output, /Set only one of RELAY_TOKEN and RELAY_TOKEN_FILE/);
		});
		const missing = await refusal({ RELAY_TOKEN_FILE: "/nonexistent/relay-token" });
		assert.notEqual(missing.code, 0);
		assert.match(missing.output, /Unreadable RELAY_TOKEN_FILE \(ENOENT\)/);
	});

	it("takes a CRLF file, and refuses an empty one or one with anything around the secret", async () => {
		await withFiles({ token: `${TOKEN}\r\n` }, async (f) => {
			const relay = await start({ RELAY_TOKEN_FILE: f.token });
			try {
				assert.equal(await opens(`${relay.ws}/?token=${TOKEN}`), true);
			} finally {
				await relay.stop();
			}
		});
		const bad = {
			"": /Empty/,
			"\n": /Empty/,
			[`${TOKEN}\n\n`]: /Spaces or line breaks/,
			[` ${TOKEN}`]: /Spaces or line breaks/,
			[`\uFEFF${TOKEN}`]: /Spaces or line breaks/,
			"short\n": /RELAY_TOKEN must be/,
		};
		for (const [contents, why] of Object.entries(bad)) {
			await withFiles({ token: contents, turn: contents }, async (f) => {
				const token = await refusal({ RELAY_TOKEN_FILE: f.token });
				assert.notEqual(token.code, 0, JSON.stringify(contents));
				assert.match(token.output, why, JSON.stringify(contents));
				assert.ok(!contents.trim() || !token.output.includes(contents.trim()));
				if (why.source === "RELAY_TOKEN must be") return;
				const turn = await refusal({ ICE_SERVERS: ICE, TURN_SECRET_FILE: f.turn });
				assert.notEqual(turn.code, 0, JSON.stringify(contents));
				assert.match(turn.output, why, JSON.stringify(contents));
			});
		}
	});
});
