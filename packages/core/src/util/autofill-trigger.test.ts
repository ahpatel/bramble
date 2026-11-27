import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTOFILL_TRIGGER,
	isAutofillTrigger,
	normalizeAutofillTrigger,
} from "./autofill-trigger";

describe("normalizeAutofillTrigger", () => {
	it("defaults a missing value to the quiet icon mode", () => {
		expect(DEFAULT_AUTOFILL_TRIGGER).toBe("icon");
		expect(normalizeAutofillTrigger(undefined)).toBe("icon");
		expect(normalizeAutofillTrigger(null)).toBe("icon");
	});

	it("keeps every mode this build understands", () => {
		for (const mode of ["icon", "focus", "shortcut"] as const) {
			expect(isAutofillTrigger(mode)).toBe(true);
			expect(normalizeAutofillTrigger(mode)).toBe(mode);
		}
	});

	it("does not map the fork-only 'auto' name", () => {
		// No released build wrote "auto", so it follows the default like any other unknown value.
		expect(normalizeAutofillTrigger("auto")).toBe("icon");
	});

	it("falls back for a value written by another build", () => {
		expect(isAutofillTrigger("hover")).toBe(false);
		expect(normalizeAutofillTrigger("hover")).toBe("icon");
		expect(normalizeAutofillTrigger(3)).toBe("icon");
	});
});
