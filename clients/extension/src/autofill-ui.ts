// Autofill match list for the extension-origin iframe. Holds no secrets; see
// docs/autofill.md ("UI isolation"). Self-contained so the bundle stays flat.

import { html } from "./autofill-ui-template";
import type { DropdownSkin } from "./content/skin";

// Keep in step with content/skin.ts. Imported as a value it would make Vite hoist skin.ts into a
// chunk shared with the content script, which loads as a classic script. template-parity.test.ts
// asserts the two constants stay equal.
const MAX_RADIUS = 16;
// A click this soon after the rows appear or move may have been aimed at whatever was there
// before. The content script enforces the same window for the local renderer; a relayed pick
// never passes through it, so the UI holds its own.
const EARLY_CLICK_MS = 500;

interface MatchSummary {
	id: string;
	name: string;
	secondary: string;
}

/** Twin of content/html/dropdown-alias.ts's type. Declared here rather than imported, like
 * MatchSummary above and for the same reason: this entry stays self-contained. */
type AliasRowState = { state: "idle" } | { state: "busy" } | { state: "error"; message?: string };

type Inbound =
	| {
			type: "RENDER_MATCHES";
			matches: MatchSummary[];
			otpOnly?: boolean;
			suggest?: { password: string };
			alias?: AliasRowState;
			// The card already filled elsewhere on this page: rendered with a badge, never
			// highlighted (Enter belongs to the page's form).
			carriedId?: string;
			// Geometry and palette borrowed from the anchor field. See content/skin.ts.
			skin?: DropdownSkin;
			// True only for a fresh open; a filtered re-render stays still.
			animate?: boolean;
			// The menu was placed above the field, so it unfolds from the field's top edge.
			above?: boolean;
			// The tallest the list may draw in the current viewport, so it scrolls instead of
			// clipping against the window edge.
			maxHeight?: number;
			// The match list was capped; draw the "keep typing" note after the rows.
			more?: boolean;
			// A trailing "new login" row, under a login field's matches (#213).
			newLogin?: boolean;
	  }
	| {
			type: "RENDER_LOCKED";
			skin?: DropdownSkin;
			animate?: boolean;
			above?: boolean;
			maxHeight?: number;
	  }
	| { type: "UI_MAX_HEIGHT"; maxHeight?: number }
	| { type: "UI_HIDDEN" }
	| { type: "UI_KEY"; key: string; open?: boolean };

// Page origin (from the iframe src): READY is pinned to it, and only the content script's
// UI_CONNECT is taken from it. The page shares that window, so everything after rides the port.
const PARENT_ORIGIN = new URLSearchParams(location.search).get("parentOrigin") ?? "";
let parentPort: MessagePort | null = null;
// Relayed mode: our element is hosted by the top frame but the field lives in some
// other frame, which answers our probe and becomes the peer we exchange rows and picks
// with. The host frame only ever gets our height. See docs/autofill.md.
const RELAY_ID = new URLSearchParams(location.search).get("relayId") ?? "";
const RELAYED = RELAY_ID.length > 0;
const HERE = "tp-ui-here";
// The announcement has to come FROM here: our host parks us in a closed shadow root,
// and `window.frames` exposes only document-tree child browsing contexts, so the
// field's frame cannot reach us by index. We can still walk outward from the top.
const ANNOUNCE_INTERVAL_MS = 100;
const ANNOUNCE_ATTEMPTS = 25;
const MAX_FRAME_DEPTH = 8;
const MAX_FRAMES_VISITED = 128;
let peer: { win: Window; origin: string } | null = null;

let otpOnly = false;
// Navigable rows in render order: an optional leading "suggest a password" row,
// the login/card matches, or (alone) the locked row. Keyboard + click share this.
type NavRow =
	| { kind: "alias" }
	| { kind: "suggest" }
	| { kind: "match"; id: string }
	| { kind: "locked" };
let rows: NavRow[] = [];
let highlight = -1;
let settledAt = performance.now();

function post(message: unknown): void {
	if (RELAYED) {
		// Pinned to the peer's exact origin, so rows reach that frame and nothing else.
		if (peer) peer.win.postMessage(message, peer.origin);
		return;
	}
	parentPort?.postMessage(message);
}

/** Our rendered height, always to the frame that owns our element (never the peer). */
function postHeight(height: number): void {
	const message = { type: "UI_RESIZE", height };
	if (!RELAYED) {
		parentPort?.postMessage(message);
		return;
	}
	if (!PARENT_ORIGIN) return;
	window.parent.postMessage(message, PARENT_ORIGIN);
}

type GraphemeSegmenter = new (
	locales?: string | string[],
	options?: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

const SEGMENTER = (() => {
	const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenter }).Segmenter;
	if (!Segmenter) return null;
	try {
		return new Segmenter(undefined, { granularity: "grapheme" });
	} catch {
		return null;
	}
})();

function graphemes(text: string): string[] {
	if (SEGMENTER) return [...SEGMENTER.segment(text)].map((part) => part.segment);
	return Array.from(text);
}

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/** Uppercase avatar initials from grapheme clusters: first + last significant word, else the
 *  first two graphemes of a single-word name. Twin of content/html/dropdown-item.ts. */
function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/).filter(Boolean);
	const significant = words.filter((word) => !NAME_SUFFIXES.has(word.toLowerCase()));
	const firstWord = significant[0] ?? words[0] ?? "";
	const lastWord = significant.length > 1 ? significant[significant.length - 1]! : "";
	if (lastWord) {
		return (graphemes(firstWord)[0]! + graphemes(lastWord)[0]!).toUpperCase();
	}
	return graphemes(firstWord).slice(0, 2).join("").toUpperCase() || "??";
}

// Colours reference the local --tp-* tokens below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); this iframe has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme. Byte-identical to the
// shadow renderer's copy (content/html/dropdown-styles.ts); keep both in sync with theme.css.
const STYLE = `
		html, body { margin: 0; padding: 0; background: transparent; }
			:root {
				color-scheme: light dark;
				--tp-surface: #ffffff; /* --popover */
				--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
				--tp-muted: oklch(55.6% 0 0); /* --muted-foreground */
				--tp-border: oklch(87% 0 0); /* --border */
				--tp-radius: 16px;
				--tp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			}
			@media (prefers-color-scheme: dark) {
				:root {
					--tp-surface: oklch(26.9% 0 0);
					--tp-foreground: oklch(97% 0 0);
					--tp-muted: oklch(70.8% 0 0);
					--tp-border: oklch(37.1% 0 0);
				}
			}
			.tp-list {
				container-type: inline-size;
				background: var(--tp-surface);
				border: 1px solid var(--tp-border);
				border-radius: var(--tp-radius);
				box-shadow:
					0 20px 48px -22px rgba(0, 0, 0, 0.38),
					0 3px 10px rgba(0, 0, 0, 0.06);
				font-family: var(--tp-font);
				font-size: 13px;
				color: var(--tp-foreground);
				text-align: left;
				letter-spacing: normal;
				text-transform: none;
				font-style: normal;
				text-indent: 0;
				max-height: 380px;
				overflow-y: auto;
				margin: 0;
				padding: 4px;
				box-sizing: border-box;
				transform-origin: top center;
			}
			.tp-list.tp-dark {
				box-shadow:
					0 24px 56px -20px rgba(0, 0, 0, 0.72),
					0 3px 10px rgba(0, 0, 0, 0.28);
			}
			.tp-list.tp-animate {
				animation: tp-unfold 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both;
			}
			.tp-item {
				box-sizing: border-box;
				padding: 8px 10px;
				cursor: pointer !important;
				display: flex;
				align-items: center;
				gap: 10px;
				border-radius: max(0px, calc(var(--tp-radius) - 4px));
				transition: background 0.1s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover {
					background: color-mix(in oklab, var(--tp-foreground) 7%, transparent);
				}
			}
			/* One monogram treatment, tinted from the field's own ink: the avatar the vault list
			   draws. A per-entry colour put nine fixed hues on a menu that otherwise borrows the
			   site's palette, and the initials already identify the row. */
			.tp-avatar {
				width: 40px;
				height: 40px;
				border-radius: 11px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 15px;
				font-weight: 700;
				color: var(--tp-muted);
				background: color-mix(in oklab, var(--tp-foreground) 8%, transparent);
				flex-shrink: 0;
			}
			.tp-avatar-locked svg {
				width: 20px;
				height: 20px;
			}
			.tp-text {
				display: flex;
				flex-direction: column;
				min-width: 0;
				flex: 1;
			}
			.tp-name {
				font-weight: 600;
				font-size: 15px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				color: var(--tp-foreground);
				line-height: 1.3;
				unicode-bidi: plaintext;
			}
			/* Comfortable rows give the title the full row and let it take a second line when it
			   needs one, so a distinguishing suffix is not the part that gets clipped. */
			.tp-item:not(.tp-item-compact) .tp-name {
				white-space: normal;
				display: -webkit-box;
				-webkit-line-clamp: 2;
				-webkit-box-orient: vertical;
				overflow-wrap: anywhere;
			}
			.tp-user {
				color: var(--tp-muted);
				font-size: 13px;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				margin-top: 2px;
				line-height: 1.3;
				unicode-bidi: plaintext;
			}
			.tp-badge {
				font-size: 11px;
				font-weight: 500;
				letter-spacing: 0.2px;
				padding: 3px 8px;
				border-radius: 999px;
				color: var(--tp-foreground);
				background: color-mix(in oklab, var(--tp-foreground) 7%, transparent);
				transition: opacity 0.08s ease;
			}
			/* The trailing slot. The carried badge and the open action share one cell and swap on
			   hover or row highlight, the way the vault list's rows do, so the right edge never
			   moves. Touch has no hover to swap on, so both stay visible there. */
			.tp-trail {
				margin-inline-start: auto;
				flex-shrink: 0;
				display: grid;
				place-items: center end;
			}
			.tp-trail > * {
				grid-area: 1 / 1;
			}
			.tp-item:hover .tp-badge,
			.tp-item.tp-active .tp-badge {
				opacity: 0;
			}
			/* Compact rows are one line: a text badge ("Hier verwendet", 102px) leaves the name
			   almost nothing at 320px. A dot keeps the meaning (and the title/accessible text)
			   without stealing the width; normal rows keep the words. */
			.tp-item-compact .tp-badge {
				width: 8px;
				height: 8px;
				padding: 0;
				border-radius: 999px;
				font-size: 0;
				color: transparent;
				background: var(--tp-muted);
			}
			.tp-open {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 28px;
				height: 28px;
				padding: 0;
				border: 0;
				border-radius: 7px;
				background: transparent;
				color: var(--tp-muted);
				cursor: pointer !important;
				opacity: 0;
				pointer-events: none;
				transition: opacity 0.1s ease, background 0.12s ease, color 0.12s ease;
			}
			.tp-open:focus-visible {
				opacity: 1;
				pointer-events: auto;
				color: var(--tp-foreground);
			}
			.tp-item:hover .tp-open,
			.tp-item.tp-active .tp-open {
				opacity: 1;
				pointer-events: auto;
				transition-delay: 0.04s;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover .tp-open {
					color: var(--tp-foreground);
				}
				.tp-open:hover {
					background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
				}
			}
			@media (hover: none) {
				.tp-trail {
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.tp-badge,
				.tp-open {
					opacity: 1;
				}
				.tp-open {
					pointer-events: auto;
				}
			}
			.tp-open svg {
				width: 15px;
				height: 15px;
			}
			.tp-launch {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				color: var(--tp-muted);
				transition: color 0.12s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-item:hover .tp-launch {
					color: var(--tp-foreground);
				}
			}
			.tp-avatar-suggest {
				background: var(--tp-foreground);
				color: var(--tp-surface);
			}
			.tp-avatar-suggest svg {
				width: 20px;
				height: 20px;
			}
			.tp-suggest-pw {
				font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
				font-size: 14px;
				letter-spacing: 0.5px;
			}
			/* The note under a capped list. Not a row: no hover, no key target. */
			.tp-more {
				padding: 6px 10px 4px;
				text-align: center;
				font-size: 11px;
				line-height: 1.3;
				color: var(--tp-muted);
			}
			.tp-new-login {
				display: flex;
				align-items: center;
				gap: 6px;
				width: 100%;
				padding: 6px 12px;
				border: 0;
				border-top: 1px solid var(--tp-border);
				background: none;
				color: var(--tp-muted);
				font: inherit;
				font-size: 12px;
				text-align: left;
				cursor: pointer;
			}
			.tp-new-login:hover {
				color: var(--tp-foreground);
			}
			.tp-regenerate {
				margin-left: auto;
				flex-shrink: 0;
				display: flex;
				align-items: center;
				justify-content: center;
				width: 32px;
				height: 32px;
				padding: 0;
				border: 0;
				border-radius: 8px;
				background: transparent;
				color: var(--tp-muted);
				cursor: pointer !important;
				transition: background 0.12s ease, color 0.12s ease;
			}
			@media (hover: hover) and (pointer: fine) {
				.tp-regenerate:hover {
					background: color-mix(in oklab, var(--tp-foreground) 12%, transparent);
					color: var(--tp-foreground);
				}
			}
			/* Compact: one line per entry, with a small monogram so the row still reads as Bramble.
			   The old avatar-less version was faster to scan but felt like a debug list. */
			.tp-item-compact {
				padding: 8px 10px;
				gap: 8px;
				min-height: 54px;
			}
			.tp-avatar-compact {
				width: 30px;
				height: 30px;
				font-size: 11px;
				border-radius: clamp(6px, calc(var(--tp-radius) - 2px), 10px);
			}
			.tp-text-compact {
				flex-direction: row;
				align-items: baseline;
				gap: 0;
			}
			.tp-text-compact .tp-name {
				font-size: 13.5px;
			}
			.tp-text-compact .tp-user {
				font-size: 12px;
				margin: 0;
				min-width: 0;
			}
			.tp-text-compact .tp-user::before {
				content: "·";
				margin: 0 6px;
				opacity: 0.55;
			}
			.tp-text-compact .tp-user:empty::before {
				content: none;
			}
			.tp-compact .tp-item-compact + .tp-item-compact {
				margin-top: 2px;
			}
			@keyframes tp-unfold {
				from {
					opacity: 0;
					transform: translateY(-6px) scale(0.985);
				}
				to {
					opacity: 1;
					transform: none;
				}
			}
			@media (prefers-reduced-motion: reduce) {
				.tp-list.tp-animate {
					animation: none;
				}
			}
			@media (forced-colors: active) {
				.tp-list {
					background: Canvas;
					border-color: CanvasText;
					box-shadow: none;
				}
				.tp-item { color: CanvasText; }
				.tp-item.tp-active { outline: 2px solid Highlight; outline-offset: -2px; }
				.tp-badge {
					--tp-badge-dot-bg: CanvasText;
					background: Canvas;
					color: CanvasText;
					border: 1px solid CanvasText;
				}
			}
			/* The menu can be as narrow as 152px at 200% zoom on a 320px screen. The avatar and
			   the text badge are the first things to go: the entry name is the identifier. */
			@container (max-width: 320px) {
				.tp-badge {
					width: 8px;
					height: 8px;
					padding: 0;
					border-radius: 999px;
					font-size: 0;
					color: transparent;
					background: var(--tp-badge-dot-bg, var(--tp-muted));
				}
			}
			@container (max-width: 260px) {
				.tp-text-compact { flex-direction: column; align-items: stretch; }
				.tp-text-compact .tp-user { margin-top: 2px; }
				.tp-text-compact .tp-user::before { content: none; }
			}
			@container (max-width: 220px) {
				.tp-item { padding: 8px; gap: 8px; }
				.tp-avatar { display: none; }
			}
		`;

function matchRow(m: MatchSummary, carried: boolean, compact: boolean): string {
	// A nameless entry still needs a primary line; the username is its only identifier. A generic
	// label covers the rare row with neither. Twin of content/html/dropdown-item.ts.
	const primary = m.name || m.secondary || t("savedLogin");
	const detail = m.name ? m.secondary : "";
	const badge = carried
		? html`<span class="tp-badge" title="${t("usedHere")}">${t("usedHere")}</span>`
		: "";
	// Shares the trailing slot with the badge and appears on hover or row highlight, so the row
	// reads as one thing until you reach for the escape hatch. Twin of content/html/dropdown-item.ts.
	const open = html`<button class="tp-open" type="button" data-tp-open-entry="1" aria-label="${t("openEntryDetails")}" title="${t("openEntryDetails")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg></button>`;
	if (compact) {
		return html`
		<div class="tp-item tp-item-compact" data-entry-id="${m.id}" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-compact" aria-hidden="true">${initials(primary)}</div>
			<div class="tp-text tp-text-compact">
				<span class="tp-name" title="${primary}">${primary}</span>
				<span class="tp-user" title="${detail}">${detail}</span>
			</div>
			<div class="tp-trail">${[badge, open]}</div>
		</div>
	`;
	}
	return html`
		<div class="tp-item" data-entry-id="${m.id}" role="option" aria-selected="false">
			<div class="tp-avatar" aria-hidden="true">${initials(primary)}</div>
			<div class="tp-text">
				<span class="tp-name" title="${primary}">${primary}</span>
				<span class="tp-user" title="${detail}">${detail}</span>
			</div>
			<div class="tp-trail">${[badge, open]}</div>
		</div>
	`;
}

/** Apply the field's skin. Values are validated here as well as in the content script: the UI
 *  document is reachable by anything in the tab, so it treats its input as untrusted plumbing. */
function applySkin(el: HTMLElement, skin?: DropdownSkin): void {
	if (!skin) return;
	const radius = Number(skin.radius);
	if (Number.isFinite(radius)) {
		el.style.setProperty("--tp-radius", `${Math.max(0, Math.min(MAX_RADIUS, radius))}px`);
	}
	const isColor = (v: unknown): v is string =>
		typeof v === "string" &&
		/^(rgb|hsl|oklch|oklab|lab|lch|color|#)/i.test(v) &&
		!/url\s*\(/i.test(v);
	if (isColor(skin.surface)) el.style.setProperty("--tp-surface", skin.surface);
	if (isColor(skin.ink)) el.style.setProperty("--tp-foreground", skin.ink);
	if (isColor(skin.muted)) el.style.setProperty("--tp-muted", skin.muted);
	if (isColor(skin.border)) el.style.setProperty("--tp-border", skin.border);
	else if (isColor(skin.ink)) {
		el.style.setProperty("--tp-border", `color-mix(in oklab, ${skin.ink} 18%, transparent)`);
	}
	if (typeof skin.font === "string") {
		const font = skin.font
			.replace(/[;{}]/g, " ")
			.replace(/url\s*\(/gi, " ")
			.slice(0, 120)
			.trim();
		if (font) el.style.setProperty("--tp-font", font);
	}
	el.classList.toggle("tp-compact", skin.compact === true);
	el.classList.toggle("tp-dark", skin.dark === true);
	el.style.colorScheme = skin.dark ? "dark" : "light";
}

// Extension i18n: browser locale with en default_locale fallback. Kept inline (not a
// shared import) so this WAR iframe bundle stays flat. See content/i18n.ts for the
// content-script twin.
type I18n = { getMessage(key: string): string };
function t(key: string): string {
	const g = globalThis as { browser?: { i18n: I18n }; chrome?: { i18n: I18n } };
	return (g.browser ?? g.chrome)?.i18n.getMessage(key) ?? key;
}

/** Twin of content/html/dropdown-alias.ts. Both must change together; see template-parity. */
function aliasRow(row: AliasRowState): string {
	if (row.state === "busy") {
		return html`
		<div class="tp-item tp-alias tp-alias-busy">
			<div class="tp-avatar tp-avatar-alias">
				<svg class="tp-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasTitle")}</span>
				<span class="tp-user">${t("aliasWorking")}</span>
			</div>
		</div>
	`;
	}
	if (row.state === "error") {
		return html`
		<div class="tp-item tp-alias tp-alias-error" data-tp-alias="1" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-alias">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasFailed")}</span>
				<span class="tp-user">${row.message ?? t("aliasRetry")}</span>
			</div>
		</div>
	`;
	}
	return html`
		<div class="tp-item tp-alias" data-tp-alias="1" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-alias">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("aliasTitle")}</span>
				<span class="tp-user">${t("aliasUse")}</span>
			</div>
		</div>
	`;
}

/** First and last few characters, not the whole secret. Twin of
 *  content/html/dropdown-suggest.ts's previewPassword; both must change together. */
function previewPassword(password: string): string {
	if (password.length <= 12) return password;
	return `${password.slice(0, 6)}…${password.slice(-4)}`;
}

function suggestRow(password: string): string {
	return html`
		<div class="tp-item tp-suggest" data-tp-suggest="1" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-suggest">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 20 3"></path><path d="m16 6 3 3"></path><path d="m14 8 3 3"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name tp-suggest-pw">${previewPassword(password)}</span>
				<span class="tp-user">${t("suggestPasswordUse")}</span>
			</div>
			<button class="tp-regenerate" data-tp-regenerate="1" type="button" aria-label="${t("suggestPasswordRegenerate")}">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>
			</button>
		</div>
	`;
}

/** The note after a capped match list. Not a row: it takes no keys and no clicks. */
function moreRow(): string {
	return html`<div class="tp-more" id="tp-more-note" role="note">${t("menuMore")}</div>`;
}

/** Twin of content/html/dropdown-new-login.ts. Both must change together; see template-parity.
 * A small link, not a row: clicked, never reached by the arrow keys, so Enter never opens a window. */
function newLoginRow(): string {
	return html`
		<button type="button" class="tp-new-login" data-tp-new-login="1">
			<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
			${t("newLoginTitle")}
		</button>
	`;
}

function lockedRow(): string {
	return html`
		<div class="tp-item tp-locked" data-tp-popout="1" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-locked">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2.4"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name">${t("vaultLocked")}</span>
				<span class="tp-user">${t("vaultLockedUnlockHint")}</span>
			</div>
			<span class="tp-launch">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4l-8.5 8.5"></path><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path></svg>
			</span>
		</div>
	`;
}

/** Render body html, then report the rendered height so the parent can size the iframe.
 *
 * The stylesheet and the list element are created once and reused: rebuilding them on every
 * keystroke re-parsed the CSS and restarted the entrance animation, which is exactly the flicker
 * the render cache exists to avoid. `animate` is true only for a fresh open, so a filtered re-render
 * is instant. */
let sizeObserver: ResizeObserver | null = null;
function render(
	bodyHtml: string,
	skin?: DropdownSkin,
	animate = false,
	above = false,
	maxHeight?: number,
): void {
	let list = document.body.querySelector<HTMLElement>(".tp-list");
	if (!list) {
		document.body.innerHTML = `<style>${STYLE}</style><div class="tp-list" role="listbox" aria-label="${t("autofillOpenMenu")}"></div>`;
		list = document.body.querySelector<HTMLElement>(".tp-list");
	}
	if (!list) return;
	// Clamp what the content script sends: this document is reachable by anything in the tab, so
	// it treats its input as untrusted plumbing. The default stylesheet cap applies when absent.
	if (typeof maxHeight === "number" && Number.isFinite(maxHeight)) {
		list.style.maxHeight = `${Math.max(96, Math.min(380, maxHeight))}px`;
	}
	list.innerHTML = bodyHtml;
	// The note is a description of the list, not an option: point the listbox at it instead of
	// leaving a note role inside the option set where some screen readers drop it.
	const more = list.querySelector(".tp-more");
	if (more) list.setAttribute("aria-describedby", "tp-more-note");
	else list.removeAttribute("aria-describedby");
	list.style.transformOrigin = above ? "bottom center" : "top center";
	applySkin(list, skin);
	// A webfont, a browser zoom or a scrollbar can change the list's height after the first paint.
	// Without this the parent keeps the pre-font height and the last row (or the bottom border) is
	// cut off on exactly the sites whose form fonts arrive late.
	if (!sizeObserver && typeof ResizeObserver !== "undefined") {
		sizeObserver = new ResizeObserver(() => reportHeight());
		sizeObserver.observe(list);
	}
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
	if (animate && !reduced && typeof list.animate === "function") {
		list.animate(
			[
				{
					opacity: 0,
					transform: above ? "translateY(6px) scale(0.985)" : "translateY(-6px) scale(0.985)",
				},
				{ opacity: 1, transform: "none" },
			],
			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}
	reportHeight();
}

/** Report the list's height plus a small inset. The inset is the iframe's bottom margin for the
 *  list's own border: a viewport sized exactly to the border-box clips that last pixel at some
 *  device pixel ratios, which reads as a missing bottom border. */
const BOTTOM_INSET = 2;
let lastReportedHeight = -1;
function reportHeight(): void {
	// A timer, not rAF: the iframe is 0px tall until this first report, and a zero-height frame
	// can have its animation frames throttled, so the report that gives it a height would never
	// run. A 0ms timer runs after layout and gives the frame its first height.
	setTimeout(() => {
		const list = document.body.querySelector(".tp-list");
		const height = list ? Math.ceil(list.getBoundingClientRect().height) + BOTTOM_INSET : 0;
		// The host re-posts its gap cap on every height report. Without this dedupe that becomes
		// cap -> report -> cap, a loop for as long as the menu is open.
		if (height === lastReportedHeight) return;
		lastReportedHeight = height;
		postHeight(height);
	}, 0);
}

// Chromium can vouch that this frame is unobscured and unfiltered on screen (IntersectionObserver
// v2), which catches a pointer-events: none decoy over us that no hit test sees. Clicks wait for
// it; keys don't. Engines without it (Firefox) leave clicks to the content script's checks.
const TRACKS_VISIBILITY =
	typeof IntersectionObserver !== "undefined" &&
	"trackVisibility" in IntersectionObserver.prototype;
let vouchedVisible = false;
if (TRACKS_VISIBILITY) {
	new IntersectionObserver(
		(entries) => {
			const last = entries[entries.length - 1] as IntersectionObserverEntry & {
				isVisible?: boolean;
			};
			vouchedVisible = last?.isVisible === true;
		},
		{ threshold: [0], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
	).observe(document.body);
}

/** Whether a click may fill; when it may not, say how to fill from the keyboard instead. */
function clickAllowed(): boolean {
	if (RELAYED && performance.now() - settledAt < EARLY_CLICK_MS) return false;
	// A relayed pick is checked by the relay host's watchdog in the page that hosts it; this
	// document cannot see that page's compositing (a filtered section around the frame would
	// otherwise refuse every click), so the browser-vouched check is for the local renderer.
	if (RELAYED) return true;
	if (!TRACKS_VISIBILITY || vouchedVisible) return true;
	const list = document.body.querySelector(".tp-list");
	if (list && !list.querySelector(".tp-hint")) {
		list.insertAdjacentHTML(
			"beforeend",
			html`<div class="tp-hint" role="status">${t("pickerUseKeyboard")}</div>`,
		);
		reportHeight();
	}
	return false;
}

/** Move the keyboard highlight and tell the parent whether a row is selected (gates Enter-to-pick). */
function setHighlight(index: number): void {
	highlight = index;
	const rows = document.body.querySelectorAll<HTMLElement>(".tp-item");
	rows.forEach((row, i) => {
		const active = i === highlight;
		row.classList.toggle("tp-active", active);
		row.setAttribute("aria-selected", active ? "true" : "false");
		if (active) row.scrollIntoView({ block: "nearest" });
	});
	// The parent keeps focus in the page field (typing filters), so the active row is announced
	// through its live region. The id lets Ctrl/Cmd+Enter reach the row's secondary action.
	const active = rows[highlight] ?? null;
	post({
		type: "UI_HIGHLIGHT",
		active: highlight >= 0,
		entryId: active?.dataset.entryId,
		label: active?.textContent?.trim() || undefined,
	});
}

function moveHighlight(delta: number): void {
	const n = rows.length;
	if (n === 0) return;
	const next =
		highlight < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, highlight + delta));
	setHighlight(next);
}

/** Fire the action for the row at `i`: pick a match, use the suggestion, or open the pop-out. */
function activate(i: number): void {
	const row = rows[i];
	if (!row) return;
	if (row.kind === "match") post({ type: "UI_PICK", entryId: row.id, otpOnly });
	else if (row.kind === "suggest") post({ type: "UI_USE_SUGGESTED" });
	else if (row.kind === "alias") post({ type: "UI_USE_ALIAS" });
	else post({ type: "UI_POPOUT" });
}

// preventDefault keeps focus on the page field; the page can't reach this listener.
document.addEventListener("mousedown", (e) => {
	if (!e.isTrusted) return;
	const target = e.target as HTMLElement | null;
	// Let the content script see where this click landed in the page. A click on the left half of
	// another field's mark switches the menu to that field instead of picking the row under it.
	post({ type: "UI_POINTER", x: e.clientX, y: e.clientY });
	// Regenerate lives inside the suggest row, so match it before data-tp-suggest.
	if (target?.closest("[data-tp-regenerate]")) {
		e.preventDefault();
		post({ type: "UI_REGENERATE" });
		return;
	}
	// The row's "open in Bramble" action. It is inside the row, so match it before the entry id or
	// the row would treat this as a fill.
	const open = target?.closest<HTMLElement>("[data-tp-open-entry]");
	if (open) {
		e.preventDefault();
		const row = open.closest<HTMLElement>("[data-entry-id]");
		if (row?.dataset.entryId && clickAllowed()) {
			post({ type: "UI_OPEN_ENTRY", entryId: row.dataset.entryId, pointer: true });
		}
		return;
	}
	// Anything that fills is marked as a click, so the content script can time it.
	const item = target?.closest<HTMLElement>("[data-entry-id]");
	if (item?.dataset.entryId) {
		e.preventDefault();
		if (clickAllowed()) {
			post({ type: "UI_PICK", entryId: item.dataset.entryId, otpOnly, pointer: true });
		}
		return;
	}
	if (target?.closest("[data-tp-suggest]")) {
		e.preventDefault();
		if (clickAllowed()) post({ type: "UI_USE_SUGGESTED", pointer: true });
		return;
	}
	if (target?.closest("[data-tp-alias]")) {
		e.preventDefault();
		if (clickAllowed()) post({ type: "UI_USE_ALIAS", pointer: true });
		return;
	}
	if (target?.closest("[data-tp-new-login]")) {
		e.preventDefault();
		post({ type: "UI_NEW_LOGIN" });
		return;
	}
	if (target?.closest("[data-tp-popout]")) {
		e.preventDefault();
		post({ type: "UI_POPOUT" });
	}
});

const CONTENT_TYPES = new Set(["RENDER_MATCHES", "RENDER_LOCKED", "UI_MAX_HEIGHT", "UI_KEY"]);

window.addEventListener("message", (e) => {
	if (RELAYED) {
		// Adopt whoever sends us rows as the peer we answer. Anything in the tab can
		// post here, so this binding is not a trust decision: the peer re-checks our
		// origin, our source, and that a picked id is one it actually rendered.
		const type = (e.data as { type?: string } | undefined)?.type;
		// The host frame (our parent) sends only geometry: a move resets the click guard, and the
		// gap cap limits the list. Neither may become the peer, or picks would go to the host
		// instead of the frame that owns the field.
		if (e.source === window.parent && (type === "UI_MOVED" || type === "UI_MAX_HEIGHT")) {
			if (type === "UI_MOVED") settledAt = performance.now();
			else handleInbound(e.data as Inbound | undefined);
			return;
		}
		if (!e.source || !type || !CONTENT_TYPES.has(type)) return;
		peer = { win: e.source as Window, origin: e.origin };
		handleInbound(e.data as Inbound | undefined);
		return;
	}
	// First port wins. If the page races the content script to it, our answers go to the
	// page's port and the content script never hears a pick: a dead picker, never a fill.
	if (parentPort || e.source !== window.parent) return;
	if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
	if ((e.data as { type?: string } | undefined)?.type !== "UI_CONNECT" || !e.ports[0]) return;
	parentPort = e.ports[0];
	parentPort.onmessage = (m) => handleInbound(m.data as Inbound | undefined);
	parentPort.postMessage({ type: "UI_CONNECTED" });
});

function handleInbound(msg: Inbound | undefined): void {
	switch (msg?.type) {
		case "RENDER_MATCHES": {
			otpOnly = !!msg.otpOnly;
			highlight = -1;
			rows = [];
			const body: string[] = [];
			if (msg.alias) {
				// Busy takes no click, so it is not a navigable row either.
				if (msg.alias.state !== "busy") rows.push({ kind: "alias" });
				body.push(aliasRow(msg.alias));
			}
			if (msg.suggest) {
				rows.push({ kind: "suggest" });
				body.push(suggestRow(msg.suggest.password));
			}
			for (const m of msg.matches) {
				rows.push({ kind: "match", id: m.id });
				body.push(matchRow(m, m.id === msg.carriedId, msg.skin?.compact === true));
			}
			if (msg.more) body.push(moreRow());
			if (msg.newLogin) body.push(newLoginRow());
			render(body.join(""), msg.skin, msg.animate === true, msg.above === true, msg.maxHeight);
			settledAt = performance.now();
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		}
		case "RENDER_LOCKED":
			rows = [{ kind: "locked" }];
			highlight = -1;
			render(lockedRow(), msg.skin, msg.animate === true, msg.above === true, msg.maxHeight);
			settledAt = performance.now();
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		case "UI_MAX_HEIGHT": {
			// The viewport changed under an open menu (a phone URL bar, a window resize). Re-cap the
			// list and report the new height so the host can re-place it.
			const list = document.body.querySelector<HTMLElement>(".tp-list");
			const cap = Number(msg.maxHeight);
			if (list && Number.isFinite(cap)) {
				list.style.maxHeight = `${Math.max(96, Math.min(380, cap))}px`;
				reportHeight();
			}
			break;
		}
		case "UI_HIDDEN":
			// The host hid the menu. Forget the last reported height: the next open must report it
			// again, even when the list happens to be the same height as before.
			lastReportedHeight = -1;
			break;
		case "UI_KEY":
			if (msg.key === "ArrowDown") moveHighlight(1);
			else if (msg.key === "ArrowUp") moveHighlight(-1);
			else if (msg.key === "Enter" && highlight >= 0) {
				const row = rows[highlight];
				// Ctrl/Cmd+Enter is the row's secondary action: open the entry, never fill it.
				if (msg.open === true && row?.kind === "match") {
					post({ type: "UI_OPEN_ENTRY", entryId: row.id });
				} else {
					activate(highlight);
				}
			}
			break;
	}
}

/**
 * Announce ourselves to every frame in the tab. Carries only our relay id, and the
 * receiver decides whether to trust it by checking our origin, which it can do and we
 * cannot forge. Repeats briefly because the field's frame may still be starting up.
 */
function announce(): void {
	const message = { __tp: HERE, relayId: RELAY_ID };
	let visited = 0;
	const walk = (win: Window, depth: number): void => {
		if (depth > MAX_FRAME_DEPTH || visited >= MAX_FRAMES_VISITED) return;
		let length = 0;
		try {
			length = win.length;
		} catch {
			return;
		}
		for (let i = 0; i < length; i++) {
			if (visited >= MAX_FRAMES_VISITED) return;
			let child: Window | null = null;
			try {
				child = win[i] ?? null;
			} catch {
				continue;
			}
			if (!child || child === window) continue;
			visited++;
			try {
				child.postMessage(message, "*");
			} catch {
				// Frames come and go mid-walk.
			}
			walk(child, depth + 1);
		}
	};
	let root: Window = window;
	try {
		root = window.top ?? window;
	} catch {
		root = window;
	}
	if (root !== window) {
		try {
			root.postMessage(message, "*");
		} catch {
			// Ignore.
		}
	}
	walk(root, 0);
}

if (RELAYED) {
	// Stop as soon as a peer starts talking to us; otherwise give the field's frame a
	// short window to come up.
	let left = ANNOUNCE_ATTEMPTS;
	announce();
	const timer = setInterval(() => {
		if (peer || --left <= 0) {
			clearInterval(timer);
			return;
		}
		announce();
	}, ANNOUNCE_INTERVAL_MS);
} else {
	// Tell the parent we're live so the content script can hand over its port.
	if (PARENT_ORIGIN) window.parent.postMessage({ type: "AUTOFILL_UI_READY" }, PARENT_ORIGIN);
}
