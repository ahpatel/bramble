import { describe, expect, it } from "vitest";
import { config } from "zod";

// Every extension entry (background, popup/options via shell, offscreen) imports
// ../platform-api, so importing it here is what those bundles do transitively.
import "./platform-api";

// Extension pages run under MV3 CSP with no unsafe-eval: zod v4's `allowsEval` probe
// (a caught `new Function("")`) still logs a securitypolicyviolation on every page,
// which reads like a breakage to anyone opening DevTools. The `jitless` config is
// zod's supported way to skip the probe; this pins that it is set before first use.
describe("the zod jitless config", () => {
	it("is set so the CSP report never fires in extension pages", () => {
		expect(config().jitless).toBe(true);
	});
});
