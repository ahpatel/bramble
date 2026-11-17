// The page field's own look, sampled so the picker can sit in it rather than on top of it.
//
// A Bramble dropdown with its own 16px corners and a heavy shadow reads as an overlay on a
// site whose inputs are square, and as a light card on a dark site whose fields are dark. The
// skin is a small, validated description of the field's surface: corner radius, background,
// text colour, hairline and font. Both renderers apply it, so the shadow fallback and the
// iframe look the same.
//
// SECURITY: this is presentation only, derived from CSS the page already controls. No entry
// data, ids or secrets are involved. Everything that reaches the iframe is parsed into a
// number or an `rgba()` string first, never passed through as a raw declaration, so a page
// cannot use a colour value to smuggle markup into the extension document.

export interface FieldSkin {
	/** Corner radius in px, 0..12. A square field gets a square menu. */
	radius: number;
	surface: string;
	foreground: string;
	muted: string;
	border: string;
	fontFamily: string;
	fontSize: number;
	dark: boolean;
}

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const MAX_RADIUS = 12;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const NEAR_BLACK: Rgba = { r: 17, g: 17, b: 17, a: 1 };
const NEAR_WHITE: Rgba = { r: 245, g: 245, b: 245, a: 1 };
const DARK_SURFACE: Rgba = { r: 28, g: 28, b: 30, a: 1 };

const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;

let colorCanvas: HTMLCanvasElement | null = null;

/**
 * Parse any computed CSS colour to sRGB. `rgb()`/`rgba()` are read directly; anything else
 * (oklch, color(), a named colour) goes through a 1x1 canvas, which resolves it without
 * touching page pixels. Returns null when the value cannot be resolved.
 */
export function parseCssColor(value: string): Rgba | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	const m = RGB_RE.exec(text);
	if (m) {
		const alphaText = m[4];
		const alpha = alphaText === undefined ? 1 : Number(alphaText) / (m[5] ? 100 : 1);
		return {
			r: clamp(Number(m[1]), 0, 255),
			g: clamp(Number(m[2]), 0, 255),
			b: clamp(Number(m[3]), 0, 255),
			a: clamp(alpha, 0, 1),
		};
	}
	if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	try {
		if (!colorCanvas) {
			colorCanvas = document.createElement("canvas");
			colorCanvas.width = 1;
			colorCanvas.height = 1;
		}
		const ctx = colorCanvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = "rgba(0,0,0,0)";
		ctx.fillStyle = text;
		ctx.fillRect(0, 0, 1, 1);
		const data = ctx.getImageData(0, 0, 1, 1).data;
		return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! / 255 };
	} catch {
		return null;
	}
}

function clamp(n: number, min: number, max: number): number {
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(c: Rgba): number {
	const channel = (v: number): number => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
	const la = luminance(a);
	const lb = luminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

/** Blend `a` over `b`; weight is `a`'s share. */
function mix(a: Rgba, b: Rgba, weight: number): Rgba {
	const t = clamp(weight, 0, 1);
	return {
		r: a.r * t + b.r * (1 - t),
		g: a.g * t + b.g * (1 - t),
		b: a.b * t + b.b * (1 - t),
		a: a.a * t + b.a * (1 - t),
	};
}

function css(c: Rgba): string {
	const r = Math.round(c.r);
	const g = Math.round(c.g);
	const b = Math.round(c.b);
	if (c.a >= 0.999) return `rgb(${r}, ${g}, ${b})`;
	return `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
}

/** A near-neutral version of a surface. A saturated brand-coloured input makes a garish menu;
 * keeping a trace of the hue keeps it related to the field. */
function neutralize(c: Rgba): Rgba {
	const max = Math.max(c.r, c.g, c.b);
	const min = Math.min(c.r, c.g, c.b);
	const saturation = max === 0 ? 0 : (max - min) / max;
	if (saturation <= 0.3) return c;
	const gray = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
	const grayColor: Rgba = { r: gray, g: gray, b: gray, a: c.a };
	return mix(c, grayColor, 0.2);
}

/** The next element up the composed tree: a shadow root's host, then its light-DOM parent. */
function composedParent(el: Element): Element | null {
	if (el.parentElement) return el.parentElement;
	const root = el.getRootNode();
	return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
}

/** The first opaque background at or above the field, else the document's colour scheme. */
function surfaceFor(field: HTMLInputElement): Rgba {
	for (let el: Element | null = field; el; el = composedParent(el)) {
		const c = parseCssColor(getComputedStyle(el).backgroundColor);
		if (c && c.a >= 0.95) return neutralize(c);
	}
	const scheme = getComputedStyle(field).colorScheme;
	const dark =
		(/dark/.test(scheme) && !/light/.test(scheme)) ||
		(typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
	return dark ? DARK_SURFACE : WHITE;
}

function fallbackForeground(surface: Rgba): Rgba {
	return luminance(surface) < 0.45 ? NEAR_WHITE : NEAR_BLACK;
}

/**
 * Sample the field's presentation. Called when the picker opens, not per frame: a page that
 * animates its own background is allowed to leave the menu where it was.
 */
export function sampleFieldSkin(field: HTMLInputElement): FieldSkin {
	const cs = getComputedStyle(field);
	const surface = surfaceFor(field);

	const declared = parseCssColor(cs.color);
	const fallback = fallbackForeground(surface);
	const foreground =
		declared && declared.a >= 0.5 && contrastRatio(declared, surface) >= 3 ? declared : fallback;
	const muted = mix(foreground, surface, 0.62);
	// A menu painted exactly in the field's colour recedes into a dark page; lifting it a
	// touch toward the field's own text colour reads as a raised surface without leaving the
	// site's palette. Light fields are already the brightest thing in the card.
	const dark = luminance(surface) < 0.45;
	const menuSurface = dark ? mix(foreground, surface, 0.06) : surface;

	const borderWidth = Number.parseFloat(cs.borderTopWidth) || 0;
	const declaredBorder = parseCssColor(cs.borderTopColor);
	const border =
		borderWidth > 0 &&
		declaredBorder &&
		declaredBorder.a > 0.2 &&
		contrastRatio(declaredBorder, surface) > 1.15
			? declaredBorder
			: mix(foreground, surface, 0.16);

	const radius = clamp(Number.parseFloat(cs.borderTopLeftRadius) || 0, 0, MAX_RADIUS);
	const fieldFontSize = clamp(Number.parseFloat(cs.fontSize) || 14, 10, 22);
	// One step smaller than the field, but never smaller than a comfortable menu row.
	const fontSize = clamp(fieldFontSize - 1, 12, 14);
	// A page's webfont is not available inside the extension iframe, so keep a generic
	// fallback behind it. Without one the menu would fall back to the browser's default serif.
	const declaredFamily = (cs.fontFamily || "").trim();
	const generic = /\b(serif|sans-serif|monospace|cursive|fantasy|system-ui)\s*$/i.test(
		declaredFamily,
	);
	const fontFamily = (
		declaredFamily
			? `${declaredFamily}${generic ? "" : ', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'}`
			: ""
	).slice(0, 200);

	return {
		radius,
		surface: css(menuSurface),
		foreground: css(foreground),
		muted: css(muted),
		border: css(border),
		fontFamily,
		fontSize,
		dark,
	};
}

/** Compact identity for the render cache: the same rows with a different skin is a different
 * dropdown, and keyed on ids alone a site's theme change would never repaint. */
export function skinKey(skin: FieldSkin): string {
	return `${skin.radius}|${skin.surface}|${skin.foreground}|${skin.border}|${skin.fontFamily}|${skin.fontSize}`;
}
