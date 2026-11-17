/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio, luminance, parseCssColor, sampleFieldSkin } from "./field-skin";

const style = (over: Partial<CSSStyleDeclaration> = {}): CSSStyleDeclaration =>
	({
		color: "rgb(0, 0, 0)",
		backgroundColor: "rgb(255, 255, 255)",
		borderTopWidth: "1px",
		borderTopColor: "rgb(200, 200, 200)",
		borderTopLeftRadius: "0px",
		fontFamily: "Inter, sans-serif",
		fontSize: "16px",
		colorScheme: "light",
		...over,
	}) as CSSStyleDeclaration;

function fieldWith(over: Partial<CSSStyleDeclaration> = {}): HTMLInputElement {
	document.body.innerHTML = `<form><input id="user" type="text" /></form>`;
	const field = document.getElementById("user") as HTMLInputElement;
	vi.spyOn(window, "getComputedStyle").mockImplementation((el) =>
		el === field ? style(over) : style({ backgroundColor: "rgba(0, 0, 0, 0)" }),
	);
	return field;
}

afterEach(() => vi.restoreAllMocks());

describe("field skin: colour parsing", () => {
	it("reads rgb and rgba", () => {
		expect(parseCssColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
	});

	it("reads transparent as zero alpha", () => {
		expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
	});
});

describe("field skin: contrast", () => {
	it("scores black on white at the WCAG maximum", () => {
		const black = { r: 0, g: 0, b: 0, a: 1 };
		const white = { r: 255, g: 255, b: 255, a: 1 };
		expect(luminance(black)).toBe(0);
		expect(luminance(white)).toBeCloseTo(1);
		expect(contrastRatio(black, white)).toBeCloseTo(21, 0);
	});
});

describe("field skin: sampling", () => {
	it("gives a square field a square menu and keeps its text colour", () => {
		const skin = sampleFieldSkin(fieldWith({ borderTopLeftRadius: "0px" }));
		expect(skin.radius).toBe(0);
		expect(skin.surface).toBe("rgb(255, 255, 255)");
		expect(skin.foreground).toBe("rgb(0, 0, 0)");
		expect(skin.dark).toBe(false);
	});

	it("caps a pill field's radius so the menu does not become a capsule", () => {
		const skin = sampleFieldSkin(fieldWith({ borderTopLeftRadius: "999px" }));
		expect(skin.radius).toBe(12);
	});

	it("follows a dark field rather than the OS preference", () => {
		const skin = sampleFieldSkin(
			fieldWith({
				backgroundColor: "rgb(24, 24, 27)",
				color: "rgb(244, 244, 245)",
				borderTopColor: "rgb(63, 63, 70)",
			}),
		);
		expect(skin.dark).toBe(true);
		expect(skin.surface).toBe("rgb(37, 37, 40)");
		expect(skin.foreground).toBe("rgb(244, 244, 245)");
	});

	it("falls back to a readable foreground when the field's colour is transparent", () => {
		const skin = sampleFieldSkin(
			fieldWith({ color: "rgba(0, 0, 0, 0)", backgroundColor: "rgb(20, 20, 20)" }),
		);
		expect(skin.dark).toBe(true);
		expect(skin.foreground).toBe("rgb(245, 245, 245)");
	});

	it("keeps a saturated field from turning the menu neon", () => {
		const skin = sampleFieldSkin(fieldWith({ backgroundColor: "rgb(0, 0, 255)" }));
		// 20% of the blue plus its grey keeps a hint of the hue without a saturated menu.
		expect(skin.surface).toBe("rgb(29, 29, 76)");
	});
});
