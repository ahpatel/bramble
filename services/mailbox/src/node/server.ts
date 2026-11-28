// The self-hosted mailbox: the shared app over SQLite and a directory of bodies, with the sweep
// once at start and hourly after.

import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AppDeps, createApp } from "../core/app.ts";
import { selfHostedEntitlement } from "../core/entitlement.ts";
import { sweep } from "../core/sweep.ts";
import { ConfigError, errorCode, parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { diskBodies } from "./disk-bodies.ts";

const SWEEP_EVERY_MS = 3_600_000;

export async function startServer(
	env: Record<string, string | undefined>,
): Promise<{ url: string; close(): Promise<void> }> {
	const config = parseConfig(env);
	try {
		await mkdir(config.dataDir, { recursive: true });
		// A directory owned by someone else (a bind mount the container's user can't write) is a
		// setup mistake to name, not a database error to dump.
		await access(config.dataDir, constants.W_OK);
	} catch (err) {
		throw new ConfigError("DATA_DIR", "Can't write to", errorCode(err));
	}
	const { db, close: closeDb } = openDb(join(config.dataDir, "mailbox.db"));
	const deps: AppDeps = {
		db,
		bodies: diskBodies(join(config.dataDir, "bodies")),
		// A self-hosted mailbox has no billing: posting is never gated.
		entitlement: selfHostedEntitlement(db, config.quotaBytes),
		now: Date.now,
		config: {
			retentionMaxDays: config.retentionMaxDays,
			token: config.token,
		},
	};

	const runSweep = () =>
		sweep(deps).catch((err: unknown) => {
			console.error(`mailbox sweep failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	await runSweep();
	const timer = setInterval(runSweep, SWEEP_EVERY_MS);
	timer.unref();

	const app = createApp(deps);
	const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
		(resolve) => {
			const s = serve({ fetch: app.fetch, port: config.port }, (info) =>
				resolve({ server: s, port: info.port }),
			);
		},
	);
	const url = `http://localhost:${port}`;
	console.log(`mailbox listening on ${url}`);

	return {
		url,
		async close() {
			clearInterval(timer);
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
			closeDb();
		},
	};
}
