import { afterEach, expect, it, vi } from "vitest";

// The switch for release B2 (docs/sync-conflicts.md, Phase B). A test build turns it on with
// VITE_COMBINE_CONCURRENT_EDITS=1 (the combining e2e does); release builds never set it.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

it("combining is off in a build that doesn't switch it on", async () => {
	vi.resetModules();
	expect((await import("./combine")).COMBINE_CONCURRENT_EDITS).toBe(false);
});

it("a build with VITE_COMBINE_CONCURRENT_EDITS=1 switches combining on", async () => {
	vi.stubEnv("VITE_COMBINE_CONCURRENT_EDITS", "1");
	vi.resetModules();
	expect((await import("./combine")).COMBINE_CONCURRENT_EDITS).toBe(true);
});
