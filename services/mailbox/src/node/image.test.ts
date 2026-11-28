// The Docker image copies one file from packages/core, the protocol, and installs only the
// server's dependencies. A new import on either side would build fine and fail at start.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL = fileURLToPath(
	new URL("../../../../packages/core/src/sync/mailbox/protocol.ts", import.meta.url),
);

const specifiers = (file: string) =>
	[
		...readFileSync(file, "utf8").matchAll(
			/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g,
		),
	]
		.map((m) => m[1])
		.concat([...readFileSync(file, "utf8").matchAll(/\bimport\(\s*"([^"]+)"/g)].map((m) => m[1]));

describe("what the Docker image copies", () => {
	it("the protocol file needs nothing but zod", () => {
		expect(new Set(specifiers(PROTOCOL))).toEqual(new Set(["zod"]));
	});

	it("the server takes nothing else from packages/core", () => {
		const fromCore = new Set<string>();
		for (const dir of ["core", "node"]) {
			for (const name of readdirSync(join(SRC, dir))) {
				if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
				for (const s of specifiers(join(SRC, dir, name)))
					if (s?.startsWith("@vault/core")) fromCore.add(s);
			}
		}
		expect([...fromCore]).toEqual(["@vault/core/src/sync/mailbox/protocol.ts"]);
	});
});
