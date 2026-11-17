// Autofill match list for the extension-origin iframe. Holds no secrets; see
// docs/autofill.md ("UI isolation"). Self-contained so the bundle stays flat.

import { html } from "./autofill-ui-template";

interface MatchSummary {
	id: string;
	name: string;
	secondary: string;
}

/** The anchor field's look, sampled by the content script. Presentation only; every value is
 * re-validated here before it reaches a CSS custom property. */
interface Skin {
	radius?: number;
	surface?: string;
	foreground?: string;
	muted?: string;
	border?: string;
	fontFamily?: string;
	fontSize?: number;
	dark?: boolean;
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
			// A trailing "new login" row, under a login field's matches (#213).
			newLogin?: boolean;
			// The card already filled elsewhere on this page: rendered with a badge, never
			// highlighted (Enter belongs to the page's form).
			carriedId?: string;
			skin?: Skin;
			animate?: boolean;
	  }
	| { type: "RENDER_LOCKED"; skin?: Skin; animate?: boolean }
	| { type: "UI_KEY"; key: string }
	| { type: "UI_CYCLE" };

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
// Relayed picks go straight to the field's frame, past the content script's early-click guard, so
// it is kept here: a click counts only once the rows have sat still this long. The host frame
// reports each move (UI_MOVED), forged ones included, and a new render restarts it too.
const EARLY_CLICK_MS = 500;
let settledAt = Number.NEGATIVE_INFINITY;

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

/** Uppercase avatar initials: first letter of the first two words, else first two letters. */
function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/);
	if (words.length >= 2 && words[0] && words[1]) {
		return (words[0][0]! + words[1][0]!).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
	"#7C3AED",
	"#2563EB",
	"#0E7490",
	"#047857",
	"#4D7C0F",
	"#A16207",
	"#C2410C",
	"#DC2626",
	"#DB2777",
];
function colorForName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

// Colours reference the local --tp-* tokens below, never literals. The tokens mirror the
// @vault/theme scale (packages/theme/theme.css); this iframe has no Bramble app shell to read a
// `.dark` class, so light/dark follows the OS via prefers-color-scheme until the content script
// sends the anchor field's own skin. That skin wins: a dark site in a light OS should get a dark
// menu, and a square field should get a square menu. Byte-identical defaults live in the shadow
// renderer's copy (content/html/dropdown-styles.ts); keep both in sync with theme.css.
const STYLE = `
	:root {
		color-scheme: light dark;
		--tp-surface: #ffffff; /* --popover */
		--tp-foreground: oklch(20.5% 0 0); /* --popover-foreground */
		--tp-muted: oklch(52% 0 0); /* --muted-foreground */
		--tp-border: oklch(87% 0 0); /* --border */
		--tp-primary: oklch(20.5% 0 0); /* --primary */
		--tp-on-primary: #ffffff; /* --primary-foreground */
		--tp-radius: 12px;
		--tp-row-radius: 8px;
		--tp-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		--tp-font-size: 13px;
		--tp-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--tp-surface: oklch(26.9% 0 0);
			--tp-foreground: oklch(97% 0 0);
			--tp-muted: oklch(70.8% 0 0);
			--tp-border: oklch(37.1% 0 0);
			--tp-primary: oklch(97% 0 0);
			--tp-on-primary: oklch(20.5% 0 0);
			--tp-shadow: 0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
		}
	}
	html[data-theme="light"] {
		color-scheme: light;
		--tp-surface: #ffffff;
		--tp-foreground: oklch(20.5% 0 0);
		--tp-muted: oklch(55.6% 0 0);
		--tp-border: oklch(87% 0 0);
		--tp-primary: oklch(20.5% 0 0);
		--tp-on-primary: #ffffff;
		--tp-shadow: 0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
	}
	html[data-theme="dark"] {
		color-scheme: dark;
		--tp-surface: oklch(26.9% 0 0);
		--tp-foreground: oklch(97% 0 0);
		--tp-muted: oklch(70.8% 0 0);
		--tp-border: oklch(37.1% 0 0);
		--tp-primary: oklch(97% 0 0);
		--tp-on-primary: oklch(20.5% 0 0);
		--tp-shadow: 0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
	}
	.tp-list {
		background: var(--tp-surface);
		border: 1px solid var(--tp-border);
		border-radius: var(--tp-radius);
		box-shadow: var(--tp-shadow);
		font-family: var(--tp-font-family);
		font-size: var(--tp-font-size);
		color: var(--tp-foreground);
		text-align: left;
		max-height: 320px;
		overflow-y: auto;
		padding: 4px;
		box-sizing: border-box;
	}
	.tp-list.tp-enter {
		animation: tp-enter 150ms cubic-bezier(0.2, 0, 0, 1);
		transform-origin: top center;
	}
	@keyframes tp-enter {
		from { opacity: 0; transform: translateY(-4px) scale(0.985); }
	}
	.tp-item {
		padding: 8px 10px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 10px;
		border-radius: var(--tp-row-radius);
		transition: background 0.12s ease;
	}
	.tp-item:hover { background: color-mix(in oklab, var(--tp-foreground) 8%, transparent); }
	.tp-item.tp-active { background: color-mix(in oklab, var(--tp-foreground) 12%, transparent); }
	.tp-avatar {
		width: 30px;
		height: 30px;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		color: #fff;
		flex-shrink: 0;
		letter-spacing: 0.3px;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.14);
	}
	.tp-avatar-locked {
		background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
		color: var(--tp-muted);
	}
	.tp-avatar-locked svg { width: 18px; height: 18px; }
	.tp-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	.tp-name {
		font-weight: 600;
		font-size: calc(var(--tp-font-size) + 1px);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--tp-foreground);
		line-height: 1.3;
	}
	.tp-user {
		color: var(--tp-muted);
		font-size: var(--tp-font-size);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 1px;
		line-height: 1.3;
	}
	.tp-badge {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2px;
		padding: 2px 7px;
		border-radius: 999px;
		color: var(--tp-muted);
		background: color-mix(in oklab, var(--tp-foreground) 10%, transparent);
	}
	.tp-launch {
		margin-left: auto;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		color: var(--tp-muted);
		transition: color 0.12s ease;
	}
	.tp-item:hover .tp-launch { color: var(--tp-foreground); }
	.tp-avatar-suggest { background: var(--tp-primary); color: var(--tp-on-primary); }
	.tp-avatar-alias { background: var(--tp-primary); color: var(--tp-on-primary); }
	.tp-avatar-alias svg { width: 18px; height: 18px; }
	.tp-alias-busy { opacity: 0.75; cursor: default; }
	.tp-alias-error .tp-user { color: var(--tp-danger, #dc2626); }
	.tp-spin { animation: tp-spin 0.9s linear infinite; }
	.tp-new-login { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 12px; border: 0; border-top: 1px solid var(--tp-border); background: none; color: var(--tp-muted); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
	.tp-new-login:hover { color: var(--tp-foreground); }
	.tp-hint { padding: 7px 10px; color: var(--tp-muted); font-size: calc(var(--tp-font-size) - 1px); }
	@keyframes tp-spin { to { transform: rotate(360deg); } }
	.tp-avatar-suggest svg { width: 18px; height: 18px; }
	.tp-suggest-pw {
		font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
		font-size: calc(var(--tp-font-size) + 1px);
		letter-spacing: 0.4px;
	}
	.tp-regenerate {
		margin-left: auto;
		flex-shrink: 0;
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
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.tp-regenerate:hover { background: color-mix(in oklab, var(--tp-foreground) 12%, transparent); color: var(--tp-foreground); }
	@media (prefers-reduced-motion: reduce) {
		.tp-list.tp-enter { animation: none; }
		.tp-item, .tp-regenerate { transition: none; }
	}
`;

function matchRow(m: MatchSummary, carried: boolean): string {
	const badge = carried ? html`<span class="tp-badge">${t("cardUsedHere")}</span>` : "";
	return html`
		<div class="tp-item" data-entry-id="${m.id}" role="option">
			<div class="tp-avatar" style="background: ${colorForName(m.name)};">${initials(m.name)}</div>
			<div class="tp-text">
				<span class="tp-name">${m.name}</span>
				<span class="tp-user">${m.secondary}</span>
			</div>
			${[badge]}
		</div>
	`;
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
		<div class="tp-item tp-alias tp-alias-error" data-tp-alias="1" role="option">
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
		<div class="tp-item tp-alias" data-tp-alias="1" role="option">
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

function suggestRow(password: string): string {
	return html`
		<div class="tp-item tp-suggest" data-tp-suggest="1" role="option">
			<div class="tp-avatar tp-avatar-suggest">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3 20 3"></path><path d="m16 6 3 3"></path><path d="m14 8 3 3"></path></svg>
			</div>
			<div class="tp-text">
				<span class="tp-name tp-suggest-pw">${password}</span>
				<span class="tp-user">${t("suggestPasswordUse")}</span>
			</div>
			<button class="tp-regenerate" data-tp-regenerate="1" type="button" aria-label="${t("suggestPasswordRegenerate")}">
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>
			</button>
		</div>
	`;
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
		<div class="tp-item tp-locked" data-tp-popout="1">
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

const SKIN_VARS = [
	"--tp-surface",
	"--tp-foreground",
	"--tp-muted",
	"--tp-border",
	"--tp-primary",
	"--tp-on-primary",
	"--tp-radius",
	"--tp-row-radius",
	"--tp-font-family",
	"--tp-font-size",
	"--tp-shadow",
] as const;

function validColor(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 80) return null;
	try {
		if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
			return CSS.supports("color", value) ? value : null;
		}
	} catch {
		return null;
	}
	return value;
}

function validLength(value: unknown, min: number, max: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(max, Math.max(min, value));
}

/** Apply the anchor field's look. Every value is checked again here: the content script is
 * trusted, but this document is the one that must never accept a malformed declaration. */
function applySkin(skin?: Skin): void {
	const root = document.documentElement;
	for (const name of SKIN_VARS) root.style.removeProperty(name);
	if (!skin) {
		root.removeAttribute("data-theme");
		return;
	}
	const surface = validColor(skin.surface);
	const foreground = validColor(skin.foreground);
	const muted = validColor(skin.muted);
	const border = validColor(skin.border);
	const radius = validLength(skin.radius, 0, 16);
	const fontSize = validLength(skin.fontSize, 11, 15);
	if (surface) root.style.setProperty("--tp-surface", surface);
	if (foreground) root.style.setProperty("--tp-foreground", foreground);
	if (muted) root.style.setProperty("--tp-muted", muted);
	if (border) root.style.setProperty("--tp-border", border);
	if (surface && foreground) {
		root.style.setProperty("--tp-primary", foreground);
		root.style.setProperty("--tp-on-primary", surface);
	}
	if (radius !== null) {
		root.style.setProperty("--tp-radius", `${Math.round(radius)}px`);
		root.style.setProperty("--tp-row-radius", `${radius <= 2 ? 4 : 8}px`);
	}
	if (
		typeof skin.fontFamily === "string" &&
		skin.fontFamily.length > 0 &&
		skin.fontFamily.length <= 200 &&
		(typeof CSS === "undefined" ||
			typeof CSS.supports !== "function" ||
			CSS.supports("font-family", skin.fontFamily))
	) {
		root.style.setProperty("--tp-font-family", skin.fontFamily);
	}
	if (fontSize !== null) root.style.setProperty("--tp-font-size", `${fontSize}px`);
	if (skin.dark === true) root.setAttribute("data-theme", "dark");
	else if (skin.dark === false) root.setAttribute("data-theme", "light");
	else root.removeAttribute("data-theme");
	root.style.setProperty(
		"--tp-shadow",
		skin.dark === true
			? "0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)"
			: "0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08)",
	);
}

/** Render body html, then report the rendered height so the parent can size the iframe. */
function render(bodyHtml: string, skin?: Skin, animate = false): void {
	document.body.innerHTML = `<style>${STYLE}</style><div class="tp-list${animate ? " tp-enter" : ""}" role="listbox">${bodyHtml}</div>`;
	applySkin(skin);
	reportHeight();
}

function reportHeight(): void {
	requestAnimationFrame(() => {
		const list = document.body.querySelector<HTMLElement>(".tp-list");
		// offsetHeight is the layout height: the entry animation's scale must not shrink the
		// measured box, or the frame clips the last row for the duration of the animation.
		postHeight(list ? list.offsetHeight : 0);
	});
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
		if (active) row.scrollIntoView?.({ block: "nearest" });
	});
	post({ type: "UI_HIGHLIGHT", active: highlight >= 0 });
}

function moveHighlight(delta: number, wrap = false): void {
	const n = rows.length;
	if (n === 0) return;
	let next: number;
	if (highlight < 0) next = delta > 0 ? 0 : n - 1;
	else if (wrap) next = (highlight + delta + n) % n;
	else next = Math.max(0, Math.min(n - 1, highlight + delta));
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
	// Regenerate lives inside the suggest row, so match it before data-tp-suggest.
	if (target?.closest("[data-tp-regenerate]")) {
		e.preventDefault();
		post({ type: "UI_REGENERATE" });
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

const CONTENT_TYPES = new Set(["RENDER_MATCHES", "RENDER_LOCKED", "UI_KEY", "UI_CYCLE"]);

window.addEventListener("message", (e) => {
	if (RELAYED) {
		// Adopt whoever sends us rows as the peer we answer. Anything in the tab can
		// post here, so this binding is not a trust decision: the peer re-checks our
		// origin, our source, and that a picked id is one it actually rendered.
		const type = (e.data as { type?: string } | undefined)?.type;
		if (type === "UI_MOVED" && e.source === window.parent) {
			settledAt = performance.now();
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
				body.push(matchRow(m, m.id === msg.carriedId));
			}
			if (msg.newLogin) body.push(newLoginRow());
			render(body.join(""), msg.skin, msg.animate === true);
			settledAt = performance.now();
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		}
		case "RENDER_LOCKED":
			rows = [{ kind: "locked" }];
			highlight = -1;
			render(lockedRow(), msg.skin, msg.animate === true);
			settledAt = performance.now();
			post({ type: "UI_HIGHLIGHT", active: false });
			break;
		case "UI_KEY":
			if (msg.key === "ArrowDown") moveHighlight(1);
			else if (msg.key === "ArrowUp") moveHighlight(-1);
			else if (msg.key === "Enter" && highlight >= 0) activate(highlight);
			break;
		case "UI_CYCLE":
			moveHighlight(1, true);
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
