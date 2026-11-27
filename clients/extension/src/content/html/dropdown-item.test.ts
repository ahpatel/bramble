import { beforeEach, describe, expect, it, vi } from "vitest";

// dropdownItem -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
});

async function render(over: { id?: string; name?: string; secondary?: string; carried?: boolean }) {
	const { dropdownItem } = await import("./dropdown-item");
	return dropdownItem({ id: "a", name: "My Visa", secondary: "•••• 1234", ...over });
}

describe("dropdownItem", () => {
	it("marks the entry already used on this site", async () => {
		const html = await render({ carried: true });
		expect(html).toContain('class="tp-badge"');
		expect(html).toContain("usedHere");
	});

	it("draws no badge for an ordinary row", async () => {
		const html = await render({});
		expect(html).not.toContain("tp-badge");
		expect(html).not.toContain("usedHere");
	});

	it("draws the monogram in the field's ink, not a per-entry colour", async () => {
		const html = await render({});
		expect(html).not.toMatch(/style="background/);
	});

	it("puts the badge and the open action in one trailing slot", async () => {
		const html = await render({ carried: true });
		const trail = html.match(/<div class="tp-trail">([\s\S]*?)<\/div>/);
		expect(trail?.[1]).toContain('class="tp-badge"');
		expect(trail?.[1]).toContain('class="tp-open"');
	});

	it("keeps an emoji-first name whole and uses the surname", async () => {
		const fox = await render({ name: "🦊 Fox" });
		expect(fox).toContain("🦊F");
		expect(fox).not.toContain("\uFFFD");

		const montgomery = await render({ name: "Christopher Alexander Montgomery III" });
		expect(montgomery).toContain("CM");
	});

	it("still escapes the entry's own text", async () => {
		const html = await render({ name: '<img src=x onerror="alert(1)">', carried: true });
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});
});
