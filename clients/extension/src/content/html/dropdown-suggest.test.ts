import { beforeEach, describe, expect, it, vi } from "vitest";

// dropdownSuggest -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
});

async function render(password: string): Promise<string> {
	const { dropdownSuggest } = await import("./dropdown-suggest");
	return dropdownSuggest(password);
}

describe("the generated-password row", () => {
	it("shows only the first six and last four characters of a long password", async () => {
		const row = await render("abcdefghijklmnop");
		expect(row).toContain("abcdef…mnop");
		expect(row).not.toContain("abcdefghijklmnop");
	});

	it("shows a short password whole", async () => {
		expect(await render("short-pw-12")).toContain("short-pw-12");
	});
});
