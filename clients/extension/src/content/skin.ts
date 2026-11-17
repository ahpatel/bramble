// The menu borrows the anchor field's radius, palette and font. Every value is read from page CSS,
// so it is parsed, clamped and re-serialized before it reaches a renderer.

/** Geometry and palette a picker borrows from its anchor field. */
export interface DropdownSkin {
	/** Panel corner radius in px, clamped so a pill-shaped field doesn't produce a pill menu. */
	radius: number;
	/** The field's effective background, lifted toward the popover so the menu reads as elevated. */
	surface: string;
	/** Text colour with a contrast floor against `surface`. */
	ink: string;
	/** Secondary text colour: a softer ink that still clears 4.5:1 against `surface`. */
	muted: string;
	/** The field's border colour, or "" when it has no visible border. */
	border: string;
	/** The field's font family, sanitized. */
	font: string;
	/** True when `surface` is dark, for shadow strength and the hover tint. */
	dark: boolean;
	/** A short field wants shorter rows. */
	compact: boolean;
}

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const DEFAULT_FONT =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/** Corner-radius ceiling. autofill-ui.ts carries the same number because it cannot import this
 *  module as a value without Vite hoisting it into a chunk; template-parity.test.ts pins them
 *  equal. */
const MAX_RADIUS = 16;
const FALLBACK_SURFACE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const FALLBACK_INK: Rgba = { r: 23, g: 32, b: 43, a: 1 };

// Canvas is the only reliable way to turn any CSS colour (`oklch()`, `color()`, `lab()`, a named
// colour) into channels. Computed style serializes modern colour syntaxes as written, so a regex
// alone would miss most of the theme scale the app itself uses.
let canvasCtx: CanvasRenderingContext2D | null | undefined;
const colorCache = new Map<string, Rgba | null>();

function parseRgb(value: string): Rgba | null {
	const m = value.match(
		/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i,
	);
	if (!m) return null;
	const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] === "%" ? 100 : 1);
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number.isFinite(a) ? a : 1 };
}

function parseHex(value: string): Rgba | null {
	const m = value.match(/^#([0-9a-f]{3,8})$/i);
	if (!m) return null;
	const hex = m[1]!;
	const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16);
	if (hex.length === 3 || hex.length === 4) {
		return {
			r: expand(hex[0]!),
			g: expand(hex[1]!),
			b: expand(hex[2]!),
			a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
		};
	}
	if (hex.length === 6 || hex.length === 8) {
		return {
			r: expand(hex.slice(0, 2)),
			g: expand(hex.slice(2, 4)),
			b: expand(hex.slice(4, 6)),
			a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
		};
	}
	return null;
}

/** Parse a computed CSS colour into channels, or null when it is not a colour. */
export function parseColor(value: string): Rgba | null {
	if (colorCache.has(value)) return colorCache.get(value) ?? null;
	let out: Rgba | null = null;
	if (value === "transparent") {
		out = { r: 0, g: 0, b: 0, a: 0 };
	} else {
		out = parseRgb(value) ?? parseHex(value);
		if (!out) {
			if (canvasCtx === undefined) {
				try {
					canvasCtx = document.createElement("canvas").getContext("2d");
				} catch {
					canvasCtx = null;
				}
			}
			if (canvasCtx) {
				// A sentinel that cannot be produced by a real colour tells us whether the browser
				// accepted the value at all.
				canvasCtx.fillStyle = "#010203";
				canvasCtx.fillStyle = value;
				const normalized = String(canvasCtx.fillStyle);
				if (normalized !== "#010203") out = parseRgb(normalized) ?? parseHex(normalized);
			}
		}
	}
	if (colorCache.size > 96) colorCache.clear();
	colorCache.set(value, out);
	return out;
}

function luminance(c: Rgba): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function css(c: Rgba): string {
	const a = Math.round(Math.max(0, Math.min(1, c.a)) * 1000) / 1000;
	return a >= 1
		? `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`
		: `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${a})`;
}

/** Blend `a` toward `b` by `t` (0..1), keeping it opaque. */
function mix(a: Rgba, b: Rgba, t: number): Rgba {
	const k = Math.max(0, Math.min(1, t));
	return {
		r: a.r * (1 - k) + b.r * k,
		g: a.g * (1 - k) + b.g * k,
		b: a.b * (1 - k) + b.b * k,
		a: 1,
	};
}

/** The first ancestor background that actually paints, so a transparent field still gets a surface. */
function effectiveBackground(field: Element): Rgba {
	let node: Element | null = field;
	for (let depth = 0; node && depth < 24; depth++, node = node.parentElement) {
		const c = parseColor(getComputedStyle(node).backgroundColor);
		if (c && c.a >= 0.9) return c;
	}
	return FALLBACK_SURFACE;
}

/** A corner radius in px. A percentage or a pill is clamped to something a panel can use. */
function parseRadius(value: string, height: number): number {
	const raw = Number.parseFloat(value);
	if (!Number.isFinite(raw)) return 6;
	if (value.includes("%")) return Math.min(MAX_RADIUS, Math.max(0, height / 2));
	// A field rounded to at least half its height is a pill. A pill menu looks like a lozenge and
	// clips its rows, so cap it rather than following the field all the way.
	if (height > 0 && raw >= height / 2 - 1) return 10;
	return Math.max(0, Math.min(MAX_RADIUS, raw));
}

/** Font family only: size, weight and colour are ours, so a tiny or huge page font can't shrink
 * or blow up the menu. The value still lands in a CSS declaration, so strip the characters that
 * could end one. */
function sanitizeFont(value: string): string {
	const clean = value
		.replace(/[;{}]/g, " ")
		.replace(/url\s*\(/gi, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return clean || DEFAULT_FONT;
}

/** What a picker should borrow from `field`. */
export function dropdownSkin(field: HTMLInputElement): DropdownSkin {
	const cs = getComputedStyle(field);
	const rect = field.getBoundingClientRect();
	const fieldSurface = effectiveBackground(field);
	const dark = luminance(fieldSurface) < 0.35;
	// Borrow a hint of the site's surface, not the surface itself. A menu painted in the field's
	// own fill reads as another form control (and on a grey SaaS field it looks flat); lifting it
	// toward the popover keeps the elevation a menu needs while the radius, border and font still
	// say "this belongs to that form".
	const surface = dark
		? mix(fieldSurface, { r: 36, g: 38, b: 42, a: 1 }, 0.22)
		: mix(fieldSurface, { r: 255, g: 255, b: 255, a: 1 }, 0.72);
	const ink = parseColor(cs.color) ?? FALLBACK_INK;
	// The page's own text colour is usually right, but a form that writes white text on a white
	// field (or a theme change mid-render) would make every row invisible. The floor is 4.5:1
	// because the menu's text is 13px, not large text.
	const safeInk =
		contrast(ink, surface) >= 4.5
			? ink
			: luminance(surface) < 0.4
				? { r: 255, g: 255, b: 255, a: 1 }
				: FALLBACK_INK;
	// Secondary text: a softer ink, but never below 4.5:1 against the surface. A fixed theme grey
	// breaks on a dark field under a light OS; this follows the field's own surface.
	const mutedCandidate = mix(safeInk, surface, 0.28);
	const muted = contrast(mutedCandidate, surface) >= 4.5 ? mutedCandidate : safeInk;

	const borderWidth = Number.parseFloat(cs.borderTopWidth);
	const borderColor = parseColor(cs.borderTopColor);
	const border =
		cs.borderTopStyle !== "none" &&
		Number.isFinite(borderWidth) &&
		borderWidth >= 0.5 &&
		borderColor &&
		borderColor.a >= 0.15
			? css(borderColor)
			: "";

	return {
		radius: parseRadius(cs.borderTopLeftRadius, rect.height),
		surface: css(surface),
		ink: css(safeInk),
		muted: css(muted),
		border,
		font: sanitizeFont(cs.fontFamily),
		dark,
		compact: rect.height > 0 && rect.height < 38,
	};
}

/** Stable key for the render cache: an unchanged match set with a changed skin is a new render. */
export function skinKey(skin: DropdownSkin): string {
	return `${skin.radius}|${skin.surface}|${skin.ink}|${skin.muted}|${skin.border}|${skin.font}|${skin.dark ? 1 : 0}|${skin.compact ? 1 : 0}`;
}
