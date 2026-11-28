import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.ts";

describe("parseConfig", () => {
	it("defaults to port 7401, ./data, 365 days, no token and no quota", () => {
		expect(parseConfig({})).toEqual({
			port: 7401,
			dataDir: "./data",
			token: null,
			retentionMaxDays: 365,
			quotaBytes: null,
		});
	});

	it("reads every variable", () => {
		expect(
			parseConfig({
				PORT: "9000",
				DATA_DIR: "/var/lib/mailbox",
				MAILBOX_TOKEN: "a-private-token-0123",
				RETENTION_MAX_DAYS: "30",
				QUOTA_BYTES: "1073741824",
			}),
		).toEqual({
			port: 9000,
			dataDir: "/var/lib/mailbox",
			token: "a-private-token-0123",
			retentionMaxDays: 30,
			quotaBytes: 1073741824,
		});
	});

	it("treats an empty variable as unset", () => {
		expect(parseConfig({ QUOTA_BYTES: "", MAILBOX_TOKEN: "" }).quotaBytes).toBeNull();
	});

	it("refuses a short token without echoing it", () => {
		expect(() => parseConfig({ MAILBOX_TOKEN: "short-secret" })).toThrow(ConfigError);
		try {
			parseConfig({ MAILBOX_TOKEN: "short-secret" });
		} catch (e) {
			expect(String(e)).toContain("MAILBOX_TOKEN");
			expect(String(e)).not.toContain("short-secret");
		}
	});

	it("refuses a retention outside 1 to 3650 days and a non-numeric quota", () => {
		expect(() => parseConfig({ RETENTION_MAX_DAYS: "0" })).toThrow(ConfigError);
		expect(() => parseConfig({ RETENTION_MAX_DAYS: "3651" })).toThrow(ConfigError);
		expect(() => parseConfig({ QUOTA_BYTES: "lots" })).toThrow(/QUOTA_BYTES/);
	});
	describe("MAILBOX_TOKEN_FILE", () => {
		const files = (map: Record<string, string>) => (path: string) => {
			const contents = map[path];
			if (contents === undefined) throw new Error(`ENOENT: ${path}`);
			return contents;
		};

		it("reads the token from the file, without the newline it ends with", () => {
			const read = files({ "/run/secrets/mailbox-token": "a-private-token-0123\n" });
			expect(parseConfig({ MAILBOX_TOKEN_FILE: "/run/secrets/mailbox-token" }, read).token).toBe(
				"a-private-token-0123",
			);
		});

		it("reads a real file", () => {
			const dir = mkdtempSync(join(tmpdir(), "mailbox-config-"));
			const path = join(dir, "token");
			writeFileSync(path, "a-private-token-0123\r\n");
			try {
				expect(parseConfig({ MAILBOX_TOKEN_FILE: path }).token).toBe("a-private-token-0123");
			} finally {
				rmSync(dir, { recursive: true });
			}
		});

		it("refuses both at once", () => {
			const read = files({ "/t": "a-private-token-0123" });
			expect(() =>
				parseConfig({ MAILBOX_TOKEN: "a-private-token-4567", MAILBOX_TOKEN_FILE: "/t" }, read),
			).toThrow(/Set only one of MAILBOX_TOKEN and MAILBOX_TOKEN_FILE/);
		});

		it("refuses a missing file, naming the variable and why", () => {
			expect(() => parseConfig({ MAILBOX_TOKEN_FILE: "/nowhere/mailbox-token" })).toThrow(
				/Unreadable MAILBOX_TOKEN_FILE \(ENOENT\)/,
			);
		});

		it("refuses a bad token in the file without echoing it", () => {
			for (const contents of [
				"short-secret",
				"",
				"a-private-token-0123\n\n",
				" a-private-token-0123",
				"\uFEFFa-private-token-0123",
				"\n",
			]) {
				const read = files({ "/t": contents });
				expect(() => parseConfig({ MAILBOX_TOKEN_FILE: "/t" }, read)).toThrow(
					/Invalid token in MAILBOX_TOKEN_FILE/,
				);
				try {
					parseConfig({ MAILBOX_TOKEN_FILE: "/t" }, read);
				} catch (e) {
					if (contents.trim()) expect(String(e)).not.toContain(contents.trim());
				}
			}
		});

		it("treats an empty MAILBOX_TOKEN_FILE as unset", () => {
			expect(parseConfig({ MAILBOX_TOKEN_FILE: "" }, files({})).token).toBeNull();
		});
	});
});
