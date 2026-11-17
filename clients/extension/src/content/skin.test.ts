/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrast, dropdownSkin, parseColor, skinKey } from "./skin";

// The skin is read from page CSS, so its parsing is the security-relevant half: every colour is
// re-serialized, every length clamped, and the font stripped before it reaches a declaration. The
// renderer tests cover the applied result; these cover what the page is allowed to hand over.

function makeField(css: string, parentCss = ""): HTMLInputElement {
	const parent = document.createElement("div");
	parent.style.cssText = parentCss;
	const input = document.createElement("input");
	input.style.cssText = css;
	parent.appendChild(input);
	document.body.appendChild(parent);
	vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
		width: 320,
		height: 44,
		top: 0,
		left: 0,
		right: 320,
		bottom: 44,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
	return input;
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("parseColor", () => {
	it("reads the forms computed style and canvas produce", () => {
		expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
		expect(parseColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
		expect(parseColor("#10203080")).toEqual({ r: 16, g: 32, b: 48, a: 128 / 255 });
	});

	it("treats transparent as a zero-alpha colour and rejects non-colours", () => {
		expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
		expect(parseColor("url(https://example.com/x.png)")).toBeNull();
		expect(parseColor("inherit")).toBeNull();
	});
});

describe("dropdownSkin", () => {
	it("borrows a square field's geometry, border, surface and font", () => {
		const field = makeField(
			"border: 1px solid rgb(185, 192, 201); border-radius: 0; background: rgb(255, 255, 255); color: rgb(23, 32, 43); font-family: Georgia, serif;",
		);
		const skin = dropdownSkin(field);
		expect(skin.radius).toBe(0);
		expect(skin.border).toBe("rgb(185 192 201)");
		expect(skin.surface).toBe("rgb(255 255 255)");
		expect(skin.ink).toBe("rgb(23 32 43)");
		expect(skin.font).toContain("Georgia");
		expect(skin.dark).toBe(false);
	});

	it("follows a rounded field, and caps a pill so the menu cannot become a lozenge", () => {
		expect(dropdownSkin(makeField("border-top-left-radius: 12px; background: #fff;")).radius).toBe(
			12,
		);
		expect(dropdownSkin(makeField("border-top-left-radius: 999px; background: #fff;")).radius).toBe(
			10,
		);
	});

	it("finds the surface through a transparent field", () => {
		const field = makeField(
			"background: transparent; color: rgb(240, 240, 240); border: 0;",
			"background: rgb(20, 20, 20);",
		);
		const skin = dropdownSkin(field);
		expect(skin.surface).toBe("rgb(24 24 25)");
		expect(skin.dark).toBe(true);
		expect(skin.border).toBe("");
	});

	it("keeps text legible when the page's own colour has no contrast with its surface", () => {
		const skin = dropdownSkin(
			makeField("background: rgb(255, 255, 255); color: rgb(250, 250, 250);"),
		);
		// Falls back to the dark ink rather than painting near-white on white.
		expect(skin.ink).toBe("rgb(23 32 43)");
	});

	it("keeps secondary text at 4.5:1 on a light and a dark surface", () => {
		for (const css of [
			"background: rgb(255, 255, 255); color: rgb(23, 32, 43);",
			"background: rgb(24, 24, 26); color: rgb(240, 240, 240);",
		]) {
			const skin = dropdownSkin(makeField(css));
			const surface = parseColor(skin.surface)!;
			const muted = parseColor(skin.muted)!;
			expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("keys the render cache on the skin", () => {
		const square = dropdownSkin(makeField("border-radius: 0; background: #fff;"));
		const rounded = dropdownSkin(makeField("border-top-left-radius: 12px; background: #fff;"));
		expect(skinKey(square)).not.toBe(skinKey(rounded));
		expect(skinKey(square)).toBe(
			skinKey(dropdownSkin(makeField("border-radius: 0; background: #fff;"))),
		);
	});
});
