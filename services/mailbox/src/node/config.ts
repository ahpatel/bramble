// The self-hosted server's environment, validated with zod. A bad value stops the server before it
// listens, and the message names the variable, never its value (one of them is a secret).

import { readFileSync } from "node:fs";
import { z } from "zod";

export const ConfigSchema = z.object({
	PORT: z.coerce.number().int().min(0).max(65535).default(7401),
	DATA_DIR: z.string().min(1).default("./data"),
	/** The app's rule (packages/core/src/sync/mailbox/config.ts): at least 16 of A-Z a-z 0-9 _ -. */
	MAILBOX_TOKEN: z
		.string()
		.regex(/^[A-Za-z0-9_-]{16,}$/)
		.optional(),
	RETENTION_MAX_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
	QUOTA_BYTES: z.coerce.number().int().positive().optional(),
});

/** Secrets that can also come from a file, `<NAME>_FILE`, so they stay out of the environment. */
const FILE_SECRETS = ["MAILBOX_TOKEN"] as const;

export interface Config {
	port: number;
	dataDir: string;
	token: string | null;
	retentionMaxDays: number;
	quotaBytes: number | null;
}

export class ConfigError extends Error {
	/** `detail` is an error code such as EACCES: never a value, which may be the secret. */
	constructor(variable: string, problem = "Invalid", detail?: string) {
		super(`${problem} ${variable}${detail ? ` (${detail})` : ""}; see services/mailbox/README.md`);
		this.name = "ConfigError";
	}
}

/** A Node error's code (ENOENT, EACCES), for a message that says why without saying what. */
export function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : undefined;
}

export function parseConfig(
	env: Record<string, string | undefined>,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
	// An empty variable means unset, as it does to a shell.
	const set = (k: string) => (env[k] === "" ? undefined : env[k]);
	const present: Record<string, string> = {};
	for (const k of Object.keys(ConfigSchema.shape)) {
		const v = set(k);
		if (v !== undefined) present[k] = v;
	}
	for (const name of FILE_SECRETS) {
		const path = set(`${name}_FILE`);
		if (path === undefined) continue;
		if (present[name] !== undefined)
			throw new ConfigError(`${name} and ${name}_FILE`, "Set only one of");
		let contents: string;
		try {
			contents = readFile(path);
		} catch (err) {
			throw new ConfigError(`${name}_FILE`, "Unreadable", errorCode(err));
		}
		// The newline `echo` and most editors end a file with.
		const value = contents.replace(/\r?\n$/, "");
		if (!ConfigSchema.shape[name].safeParse(value).success)
			throw new ConfigError(`${name}_FILE`, "Invalid token in");
		present[name] = value;
	}
	const parsed = ConfigSchema.safeParse(present);
	if (!parsed.success)
		throw new ConfigError(String(parsed.error.issues[0]?.path[0] ?? "configuration"));
	const c = parsed.data;
	return {
		port: c.PORT,
		dataDir: c.DATA_DIR,
		token: c.MAILBOX_TOKEN ?? null,
		retentionMaxDays: c.RETENTION_MAX_DAYS,
		quotaBytes: c.QUOTA_BYTES ?? null,
	};
}
