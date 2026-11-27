// Placement arithmetic for the autofill menu, kept free of the DOM so it is testable.

/** The smallest menu worth drawing: roughly one and a half normal rows, scrollable. */
export const MIN_MENU_HEIGHT = 96;
/** The design's own cap. A taller viewport does not make a taller menu. */
export const MAX_MENU_HEIGHT = 380;

/**
 * How tall the menu may be without leaving the viewport.
 *
 * The menu used to flip above only when that side was larger, and otherwise kept its full height
 * below; a menu taller than both gaps then clipped against the window edge. Cap it to the larger
 * gap instead and let the list scroll inside itself, so the bottom border and the last row are
 * always reachable.
 */
export function maxMenuHeight(spaceBelow: number, spaceAbove: number): number {
	return Math.max(MIN_MENU_HEIGHT, Math.min(MAX_MENU_HEIGHT, Math.max(spaceBelow, spaceAbove) - 8));
}

/**
 * The menu's width for a field: the layout's floor and cap, but never wider than the viewport.
 * At 200% zoom a 320px screen is a 160px CSS viewport; the 280px compact floor would otherwise
 * run off both sides.
 */
export function pickerWidth(fieldWidth: number, compact: boolean, viewportWidth: number): number {
	const floor = compact ? 280 : 300;
	const cap = compact ? 400 : 440;
	return Math.min(Math.max(fieldWidth, floor), cap, Math.max(0, viewportWidth - 8));
}

/** The relayed picker uses the ordinary two-line width (floor 300, cap 440), viewport-clamped. */
export function relayWidth(fieldWidth: number, viewportWidth: number): number {
	return Math.min(Math.max(fieldWidth, 300), 440, Math.max(0, viewportWidth - 8));
}

/** How long a picked menu takes to collapse into the mark. */
export const MENU_COLLAPSE_MS = 240;
/** Reduced-motion replacement: a short fade, no movement. */
export const MENU_FADE_MS = 120;
