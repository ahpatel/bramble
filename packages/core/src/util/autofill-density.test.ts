import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTOFILL_DENSITY,
	isAutofillDensity,
	normalizeAutofillDensity,
} from "./autofill-density";

describe("autofill density", () => {
	it("defaults to comfortable, so a saved title is readable before anything is set", () => {
		expect(DEFAULT_AUTOFILL_DENSITY).toBe("comfortable");
		expect(normalizeAutofillDensity(undefined)).toBe("comfortable");
		expect(normalizeAutofillDensity("auto")).toBe("comfortable");
	});

	it("accepts the two row layouts and nothing else", () => {
		expect(isAutofillDensity("compact")).toBe(true);
		expect(isAutofillDensity("comfortable")).toBe(true);
		expect(isAutofillDensity("auto")).toBe(false);
		expect(isAutofillDensity(null)).toBe(false);
		expect(normalizeAutofillDensity("compact")).toBe("compact");
		expect(normalizeAutofillDensity("comfortable")).toBe("comfortable");
	});
});
