// The small Bramble mark inside a username/password field.
//
// It is not a child of the input (inputs cannot have children): it is a 16-28px host
// positioned over the field's inner-right edge, in a closed shadow root. The page can see that
// a host exists, but cannot style it or read the glyph; the click only asks for the picker, it
// never fills. Filling still requires a row pick or the keyboard command.
//
// The icon appears only while its field is focused (or while the picker it opened is up), so
// the page stays quiet otherwise. A field narrower than 80px gets no icon: a one-character
// segmented OTP box has no room for one, and the keyboard shortcut is the better affordance
// there.

import { anchorIsLive, deepActiveElement } from "./detection";
import { sampleFieldSkin } from "./field-skin";
import { brambleGlyphDataUrl } from "./html/bramble-glyph-data";
import { t } from "./i18n";
import { onTeardown } from "./lifecycle";

const ICON_Z = 2147483646;
const MIN_FIELD_WIDTH = 80;
const SIZE_MIN = 16;
const SIZE_MAX = 28;
// Right-edge insets tried in order. The first is the native spot; the others step left past a
// site's own reveal-password eye or clear button.
const INSETS = [6, 32, 58];

type Options = {
	onToggle: () => void;
};

let field: HTMLInputElement | null = null;
let host: HTMLElement | null = null;
let button: HTMLButtonElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let opts: Options | null = null;
let active = false;
let raf: number | null = null;
let lastTransform = "";
let lastSize = 0;
// The hit test that picks a free inset is expensive (it forces layout). The field moves every
// frame while scrolling, but which spot is free changes rarely, so ask at the picker's rate.
const INSET_CHECK_MS = 150;
let lastInsetCheck = Number.NEGATIVE_INFINITY;
let cachedInset = INSETS[0]!;

function iconStyles(size: number): string {
	return `
		:host { all: initial; }
		.b {
			width: ${size}px;
			height: ${size}px;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			margin: 0;
			border: 0;
			border-radius: 50%;
			background: transparent;
			color: inherit;
			cursor: pointer;
			pointer-events: auto;
			opacity: 0.45;
			transition: opacity 120ms ease, background-color 120ms ease, transform 120ms ease;
			animation: tp-icon-in 140ms cubic-bezier(0.2, 0, 0, 1);
			-webkit-tap-highlight-color: transparent;
		}
		.b:hover, .b:focus-visible, .b.tp-active {
			opacity: 0.9;
			background: color-mix(in oklab, currentColor 10%, transparent);
		}
		.b:active { transform: scale(0.92); }
		.g {
			width: ${Math.max(13, Math.round(size * 0.86))}px;
			height: ${Math.max(13, Math.round(size * 0.86))}px;
			background: currentColor;
			/* The app mark is a scalloped RING, not a filled berry: cutting the centre out of the
			   glyph keeps it legible at 20px, where the solid form reads as a plain dot. */
			-webkit-mask-image: url(${brambleGlyphDataUrl}),
				radial-gradient(circle at 50% 50%, transparent 0 36%, #000 37%);
			-webkit-mask-size: contain, 100% 100%;
			-webkit-mask-repeat: no-repeat, no-repeat;
			-webkit-mask-position: center, center;
			-webkit-mask-composite: source-in;
			mask-image: url(${brambleGlyphDataUrl}),
				radial-gradient(circle at 50% 50%, transparent 0 36%, #000 37%);
			mask-size: contain, 100% 100%;
			mask-repeat: no-repeat, no-repeat;
			mask-position: center, center;
			mask-composite: intersect;
		}
		@keyframes tp-icon-in {
			from { opacity: 0; transform: scale(0.82); }
		}
		@media (prefers-reduced-motion: reduce) {
			.b { animation: none; transition: none; }
		}
	`;
}

function createHost(size: number): void {
	host = document.createElement("div");
	// Random id: no stable selector for the page to target.
	host.id = `tp-i-${Math.random().toString(36).slice(2, 10)}`;
	host.style.cssText = `position: absolute; top: 0; left: 0; z-index: ${ICON_Z}; margin: 0; padding: 0; border: 0; pointer-events: none;`;
	const shadowRoot = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = iconStyles(size);
	styleEl = style;
	button = document.createElement("button");
	button.type = "button";
	button.className = "b";
	button.tabIndex = -1;
	button.setAttribute("aria-label", t("autofillOpen"));
	button.title = t("autofillOpen");
	const glyph = document.createElement("span");
	glyph.className = "g";
	button.appendChild(glyph);
	shadowRoot.append(style, button);
	document.body.appendChild(host);

	// mousedown (not click) beats the field's blur, and preventDefault keeps focus in the
	// field so the picker's anchor stays live. stopPropagation keeps the page's own handlers
	// from treating the icon click as a click on the form. pointerdown is stopped too, because
	// the content script's own cancellation listeners run on that event and would otherwise
	// treat a mark click as a click somewhere else on the page.
	button.addEventListener("pointerdown", (e) => {
		if (!e.isTrusted) return;
		e.stopPropagation();
	});
	button.addEventListener("mousedown", (e) => {
		if (!e.isTrusted) return;
		e.preventDefault();
		e.stopPropagation();
		opts?.onToggle();
	});
	button.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
}

/** The first inner-right spot that is not already occupied by the site's own control. */
function chooseInset(rect: DOMRect, size: number): number {
	const root = field?.getRootNode() as (Node & Partial<DocumentOrShadowRoot>) | undefined;
	if (!root || typeof root.elementFromPoint !== "function") return INSETS[0]!;
	const y = rect.top + rect.height / 2;
	for (const inset of INSETS) {
		const x = rect.right - inset - size / 2;
		if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
		const top = root.elementFromPoint(x, y);
		// The field itself, our own icon, or a transparent wrapper around the field is free.
		// A sibling button/svg is not, and we step left past it.
		if (!top || top === field || top === host) return inset;
		if (top instanceof Element && top.contains(field!)) return inset;
	}
	return INSETS[1]!;
}

function position(): void {
	if (!host || !field) return;
	const rect = field.getBoundingClientRect();
	const size = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, rect.height - 10)));
	if (size !== lastSize) {
		lastSize = size;
		lastInsetCheck = Number.NEGATIVE_INFINITY;
		if (styleEl) styleEl.textContent = iconStyles(size);
	}
	const inset = (() => {
		const now = performance.now();
		if (now - lastInsetCheck >= INSET_CHECK_MS) {
			lastInsetCheck = now;
			cachedInset = chooseInset(rect, size);
		}
		return cachedInset;
	})();
	const x = rect.right - inset - size + window.scrollX;
	const y = rect.top + (rect.height - size) / 2 + window.scrollY;
	const transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0px)`;
	if (transform === lastTransform) return;
	lastTransform = transform;
	host.style.transform = transform;
}

function tick(): void {
	if (!host || !field) {
		raf = null;
		return;
	}
	const rect = field.getBoundingClientRect();
	const focused = deepActiveElement() === field;
	if (
		!field.isConnected ||
		field.ownerDocument !== document ||
		!anchorIsLive(field, rect) ||
		rect.width < MIN_FIELD_WIDTH ||
		(!focused && !active) ||
		!document.hasFocus()
	) {
		detach();
		return;
	}
	position();
	raf = requestAnimationFrame(tick);
}

/** Show the mark on `target`, replacing any mark on another field. */
function attach(target: HTMLInputElement, next: Options): void {
	if (field === target && host) {
		opts = next;
		position();
		return;
	}
	detach();
	field = target;
	opts = next;
	active = false;
	lastTransform = "";
	lastSize = 0;
	lastInsetCheck = Number.NEGATIVE_INFINITY;
	cachedInset = INSETS[0]!;
	const rect = target.getBoundingClientRect();
	const size = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, rect.height - 10)));
	createHost(size);
	if (!host) return;
	lastSize = size;
	// The glyph sits in the field, so it should read as part of the field's own text.
	if (button) button.style.color = sampleFieldSkin(target).foreground;
	position();
	raf = requestAnimationFrame(tick);
}

/** Take the mark down and stop tracking. */
function detach(): void {
	if (raf !== null) {
		cancelAnimationFrame(raf);
		raf = null;
	}
	host?.remove();
	host = null;
	button = null;
	styleEl = null;
	field = null;
	opts = null;
	active = false;
	lastTransform = "";
	lastSize = 0;
	lastInsetCheck = Number.NEGATIVE_INFINITY;
	cachedInset = INSETS[0]!;
}

function setActive(next: boolean): void {
	active = next;
	button?.classList.toggle("tp-active", next);
	button?.setAttribute("aria-expanded", next ? "true" : "false");
}

onTeardown(detach);

export const inlineIcon = {
	attach,
	detach,
	setActive,
	/** Test seam: the field the mark belongs to, or null. */
	current: (): HTMLInputElement | null => field,
};
