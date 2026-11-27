import { describe, expect, it } from "vitest";
import {
	MAX_MENU_HEIGHT,
	MIN_MENU_HEIGHT,
	maxMenuHeight,
	pickerWidth,
	relayWidth,
} from "./placement";

describe("maxMenuHeight", () => {
	it("never exceeds the design cap, however tall the viewport", () => {
		expect(maxMenuHeight(2000, 2000)).toBe(MAX_MENU_HEIGHT);
	});

	it("uses the larger gap when the menu does not fit on either side", () => {
		// A short viewport: 150px below, 120 above. The menu stays below but is capped to the
		// better gap instead of clipping at its full height.
		expect(maxMenuHeight(150, 120)).toBe(142);
		expect(maxMenuHeight(120, 150)).toBe(142);
	});

	it("leaves room for the gap between the field and the menu", () => {
		expect(maxMenuHeight(300, 20)).toBe(292);
	});

	it("floors at a usable menu even when both gaps are tiny", () => {
		expect(maxMenuHeight(20, 10)).toBe(MIN_MENU_HEIGHT);
		expect(maxMenuHeight(0, 0)).toBe(MIN_MENU_HEIGHT);
	});
});

describe("pickerWidth", () => {
	it("matches the field between the floor and the cap", () => {
		expect(pickerWidth(360, true, 900)).toBe(360);
		expect(pickerWidth(360, false, 900)).toBe(360);
	});

	it("floors a narrow field and caps a wide one", () => {
		expect(pickerWidth(120, true, 900)).toBe(280);
		expect(pickerWidth(120, false, 900)).toBe(300);
		expect(pickerWidth(900, true, 2000)).toBe(400);
		expect(pickerWidth(900, false, 2000)).toBe(440);
	});

	it("never exceeds the viewport, even at 200% zoom on a 320px screen", () => {
		// 320px screen at 200% zoom = 160 CSS px; the compact floor must yield to 152px.
		expect(pickerWidth(280, true, 160)).toBe(152);
		expect(pickerWidth(280, true, 320)).toBe(280);
	});

	it("keeps the relayed width inside the viewport too", () => {
		expect(relayWidth(360, 900)).toBe(360);
		expect(relayWidth(120, 900)).toBe(300);
		expect(relayWidth(900, 2000)).toBe(440);
		expect(relayWidth(300, 160)).toBe(152);
	});
});
