// The in-field Bramble mark, username completion, one-time hint and pick chip, in one closed
// shadow root pinned to the field. The mark opens the list; it never fills.

import { anchorIsLive } from "./detection";
import { hostOffset } from "./host-offset";
import { t } from "./i18n";
import { effectiveOpacity } from "./legibility";
import { onTeardown } from "./lifecycle";
import { MARK_INSET } from "./mark";
import { fieldInkIsVisible, parseColor } from "./skin";

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let markEl: HTMLButtonElement | null = null;
let countEl: HTMLElement | null = null;
let ghostEl: HTMLElement | null = null;
let pickEl: HTMLElement | null = null;
let pickChipEl: HTMLElement | null = null;
let pickNumEl: HTMLElement | null = null;
let pickNameEl: HTMLElement | null = null;
let liveEl: HTMLElement | null = null;
let textMirror: HTMLSpanElement | null = null;
let hintEl: HTMLElement | null = null;
let hintTextEl: HTMLElement | null = null;
let enterKeyEl: HTMLElement | null = null;

let field: HTMLInputElement | null = null;
let visible = false;
let markAllowed = true;
let raf: number | null = null;
let lastTrackFrame = 0;
let trackingSuspended = false;
let lastRect: DOMRect | null = null;
let previewStyle: { field: HTMLInputElement; cs: CSSStyleDeclaration; at: number } | null = null;
let pickAnim: Animation | null = null;
let pickTimer: ReturnType<typeof setTimeout> | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let openCb: ((field: HTMLInputElement) => void) | null = null;
let hintShownCb: (() => void) | null = null;

// The Bramble berry, drawn rather than masked from the app PNG so it can take the field's own ink
// and carry the match count. The outline stays legible at 19px, where the filled app glyph reads
// as a plain dot; the count sits in the middle, so the mark says both "Bramble" and "how many".
const BERRY_SVG = `<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5A2.5 2.5 0 0 1 16.25 4.64 2.5 2.5 0 0 1 19.36 7.75 2.5 2.5 0 0 1 20.5 12 2.5 2.5 0 0 1 19.36 16.25 2.5 2.5 0 0 1 16.25 19.36 2.5 2.5 0 0 1 12 20.5 2.5 2.5 0 0 1 7.75 19.36 2.5 2.5 0 0 1 4.64 16.25 2.5 2.5 0 0 1 3.5 12 2.5 2.5 0 0 1 4.64 7.75 2.5 2.5 0 0 1 7.75 4.64 2.5 2.5 0 0 1 12 3.5Z"/><path fill="currentColor" stroke="none" d="M16.51 3.48 16.29 1.65 14.84 2.79ZM21.21 9.16 22.35 7.71 20.52 7.49ZM20.52 16.51 22.35 16.29 21.21 14.84ZM14.84 21.21 16.29 22.35 16.51 20.52ZM7.49 20.52 7.71 22.35 9.16 21.21ZM2.79 14.84 1.65 16.29 3.48 16.51ZM3.48 7.49 1.65 7.71 2.79 9.16ZM9.16 2.79 7.71 1.65 7.49 3.48Z"/></svg>`;

/** More than this and the mark shows "9+"; a wider label would not fit the berry. */
const COUNT_MAX = 9;

// Right-edge insets tried in order. The first clears the browser's own key/eye icon; the next
// two step left past a site's reveal-password eye or clear button that appears once the field has
// a value. The 4px fallback is for fields narrower than the normal inset, where overlapping the
// text is better than hiding the mark. A site control under the mark would eat the click, which
// is what made the second pick on a filled Wells Fargo field do nothing.
const MARK_INSETS = [MARK_INSET, MARK_INSET + 26, MARK_INSET + 52, 4];
const INSET_CHECK_MS = 150;
let insetCache: { field: HTMLInputElement; inset: number; at: number } | null = null;

/** The first inner-right spot that is not the site's own control. */
function chooseInset(target: HTMLInputElement, rect: DOMRect): number {
	const root = target.getRootNode() as (Node & Partial<DocumentOrShadowRoot>) | undefined;
	if (!root || typeof root.elementFromPoint !== "function") return MARK_INSET;
	const rtl = getComputedStyle(target).direction === "rtl";
	const y = rect.top + rect.height / 2;
	for (const inset of MARK_INSETS) {
		// The mark sits at the inline end, which is the left edge in an RTL field. Step inward
		// from that edge, not from the physical right one.
		const x = rtl ? rect.left + inset + 13 : rect.right - inset - 13;
		if (
			(rtl ? x > rect.right - 4 : x < rect.left + 4) ||
			y < 0 ||
			x < 0 ||
			x >= window.innerWidth ||
			y >= window.innerHeight
		) {
			continue;
		}
		const top = root.elementFromPoint(x, y);
		// The field itself, our own host, or a transparent wrapper around the field is free.
		if (!top || top === target || top === host) return inset;
		if (top instanceof Element && top.contains(target)) return inset;
	}
	return MARK_INSET;
}

function insetFor(target: HTMLInputElement, rect: DOMRect, refresh = true): number {
	const now = performance.now();
	if (
		insetCache &&
		insetCache.field === target &&
		(!refresh || now - insetCache.at < INSET_CHECK_MS)
	) {
		return insetCache.inset;
	}
	const inset = chooseInset(target, rect);
	insetCache = { field: target, inset, at: now };
	return inset;
}

const STYLE = `
	:host {
		all: initial;
		position: absolute;
		top: 0;
		left: 0;
		z-index: 2147483647;
		pointer-events: none;
		display: none;
		contain: layout style;
	}
	.wrap {
		position: relative;
		width: 100%;
		height: 100%;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
		container-type: inline-size;
	}
	.mark {
		position: absolute;
		inset-inline-end: var(--mark-inset, 8px);
		top: 50%;
		transform: translateY(-50%);
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: 7px;
		background: transparent;
		display: grid;
		place-items: center;
		cursor: pointer;
		pointer-events: auto;
		color: var(--mark-ink, #4b5563);
		transition: transform 120ms var(--ease-out), background 120ms var(--ease-out);
		animation: tp-mark-in 0.14s var(--ease-out) both;
	}
	.mark:focus-visible { outline: none; }
	/* The rest opacity is on the glyph, not the button: the 8.5px count inside it stays at full
	   ink, where it can clear 4.5:1. A 0.55 button opacity put the count at ~2.6:1. */
	.mark .glyph { opacity: 0.75; transition: opacity 120ms var(--ease-out); }
	.mark:active { transform: translateY(-50%) scale(0.96); }
	.no-mark .mark { display: none; }
	.glyph {
		display: block;
		width: 19px;
		height: 19px;
	}
	@media (hover: hover) and (pointer: fine) {
		.mark:hover { background: color-mix(in oklab, currentColor 10%, transparent); }
		.mark:hover .glyph { opacity: 1; }
	}
	/* The number of entries the mark would show, drawn inside the berry. */
	.count {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		pointer-events: none;
		color: var(--mark-ink, #4b5563);
		font-size: 8.5px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.2px;
		font-variant-numeric: tabular-nums;
	}
	.count:empty { display: none; }
	.ghost {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		white-space: pre;
		pointer-events: none;
		opacity: 0.38;
		overflow: hidden;
		text-overflow: clip;
		max-width: calc(100% - 88px);
		display: none;
	}
	.ghost.show { display: block; }
	/* The key that accepts the completion. Shown only while the ghost is, so the field never
	   carries a keyboard hint with nothing to accept. Tab is deliberately not this key: it keeps
	   its native focus move. */
	.enter-key {
		position: absolute;
		inset-inline-end: calc(var(--mark-inset, 8px) + 32px);
		top: 50%;
		transform: translateY(-50%);
		display: none;
		padding: 2px 4px;
		border: 1px solid color-mix(in oklab, currentColor 22%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, currentColor 7%, transparent);
		color: var(--mark-ink, #4b5563);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		font-size: 9px;
		font-weight: 600;
		line-height: 1;
		pointer-events: none;
	}
	.enter-key.show { display: block; }
	/* The entry name extends out of the mark, holds, then scrolls back into it. It sits to the
	   left of the berry, inside the field's inline end, not in a tooltip under the input. */
	.pick {
		position: absolute;
		inset-inline-end: calc(var(--mark-inset, 8px) + 28px);
		top: 50%;
		transform: translateY(-50%);
		display: none;
		/* Leave room for the mark and at least 96px of the field's own value at 320px. */
		max-width: min(180px, calc(100% - var(--mark-inset, 8px) - 124px));
		height: 20px;
		overflow: hidden;
		border-radius: 5px;
		pointer-events: none;
	}
	.pick.show { display: block; }
	.pick-chip {
		display: flex;
		align-items: center;
		gap: 5px;
		height: 100%;
		max-width: 100%;
		padding: 0 8px;
		box-sizing: border-box;
		border: 1px solid color-mix(in oklab, var(--mark-ink, #4b5563) 16%, transparent);
		border-radius: 5px;
		background: color-mix(in oklab, var(--mark-ink, #4b5563) 10%, transparent);
		color: var(--mark-ink, #4b5563);
		font-family: var(--pick-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		white-space: nowrap;
		box-shadow: 0 2px 8px -4px rgba(0, 0, 0, 0.25);
	}
	.pick-n { color: currentColor; font-weight: 500; font-variant-numeric: tabular-nums; flex: none; }
	.pick-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	/* The live region is the announcement; the chip is visual only. Closed shadow root, so the
	   page cannot read the entry name it carries. */
	.live {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
	.hint {
		position: absolute;
		inset-inline-end: 0;
		top: calc(100% + 6px);
		display: none;
		align-items: center;
		gap: 6px;
		max-width: 240px;
		padding: 5px 9px;
		border-radius: 7px;
		background: #fff;
		color: #17202b;
		border: 1px solid rgba(0, 0, 0, 0.14);
		box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.35);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.25;
	}
	.hint.show { display: flex; animation: tp-hint-in 0.16s var(--ease-out) both; }
	.above .hint { top: auto; bottom: calc(100% + 6px); }
	.hint .glyph { width: 11px; height: 11px; color: #4b5563; flex: none; }
	/* The one-time hint is a sentence, not a keycap: German runs to 245px, over the 205px the
	   bubble has beside its icon, so let it wrap to two lines instead of overflowing. */
	.hint { white-space: normal; }
	.hint-text {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	/* The measuring mirror lives inside this closed root: it borrows the field's font metrics,
	   but the page cannot read the suggested username out of its own DOM. */
	.measure {
		position: absolute;
		top: 0;
		left: 0;
		visibility: hidden;
		white-space: pre;
		pointer-events: none;
	}
	@keyframes tp-mark-in { from { opacity: 0; transform: translateY(-50%) scale(0.86); } }
	@keyframes tp-hint-in { from { opacity: 0; transform: translateY(-3px); } }
	@media (prefers-reduced-motion: reduce) {
		.mark, .hint.show { animation: none; }
	}
	@media (forced-colors: active) {
		.mark, .count, .pick-n, .pick-name, .hint { color: ButtonText; }
		.pick-chip { background: ButtonFace; border-color: ButtonText; box-shadow: none; }
		.hint { background: Canvas; color: CanvasText; border-color: ButtonText; }
	}
	/* At 200% zoom on a 320px screen the field is ~152px wide. The chip cannot keep 124px of the
	   value and still be readable, so it overlays the value for its 2s confirmation instead. */
	@container (max-width: 240px) {
		.pick { max-width: calc(100% - var(--mark-inset, 8px) - 40px); }
	}
`;

function ensureHost(): ShadowRoot | null {
	if (host?.isConnected && root) return root;
	destroyHost();
	const el = document.createElement("div");
	// Random id with its own prefix: the picker hosts use `tp-`, and the e2e helpers locate them by
	// that prefix. A mark host sharing it would shadow the picker in those selectors.
	el.id = `bmk-${Math.random().toString(36).slice(2, 10)}`;
	el.style.cssText =
		"position: absolute; top: 0; left: 0; margin: 0; padding: 0; border: 0; pointer-events: none;";
	const shadow = el.attachShadow({ mode: "closed" });
	shadow.innerHTML = `<style>${STYLE}</style>
		<div class="wrap">
			<button class="mark" type="button" tabindex="-1">${BERRY_SVG}<span class="count" aria-hidden="true"></span></button>
			<span class="ghost" aria-hidden="true"></span>
			<span class="enter-key" aria-hidden="true"></span>
			<span class="measure" aria-hidden="true"></span>
			<span class="pick" aria-hidden="true"><span class="pick-chip"><span class="pick-n"></span><span class="pick-name"></span></span></span>
			<span class="live" role="status" aria-live="polite" aria-atomic="true"></span>
			<div class="hint" aria-hidden="true">${BERRY_SVG}<span class="hint-text"></span></div>
		</div>`;
	document.body.appendChild(el);
	host = el;
	root = shadow;
	markEl = shadow.querySelector<HTMLButtonElement>(".mark");
	markEl?.setAttribute("aria-label", t("autofillOpenMenu"));
	countEl = shadow.querySelector<HTMLElement>(".count");
	ghostEl = shadow.querySelector<HTMLElement>(".ghost");
	pickEl = shadow.querySelector<HTMLElement>(".pick");
	pickChipEl = shadow.querySelector<HTMLElement>(".pick-chip");
	pickNumEl = shadow.querySelector<HTMLElement>(".pick-n");
	pickNameEl = shadow.querySelector<HTMLElement>(".pick-name");
	liveEl = shadow.querySelector<HTMLElement>(".live");
	hintEl = shadow.querySelector<HTMLElement>(".hint");
	hintTextEl = shadow.querySelector<HTMLElement>(".hint-text");
	enterKeyEl = shadow.querySelector<HTMLElement>(".enter-key");
	textMirror = shadow.querySelector<HTMLSpanElement>(".measure");
	if (enterKeyEl) enterKeyEl.textContent = t("enterKey");
	el.style.setProperty("--mark-inset", `${MARK_INSET}px`);

	// preventDefault on pointerdown keeps focus where it is; focusing the field explicitly is what
	// makes the picker's arrow-key navigation work after a mark click on a hovered (unfocused)
	// field. The page sees a normal focus, which is what the user just asked for.
	markEl?.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		field?.focus({ preventScroll: true });
	});
	markEl?.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!field) return;
		clearHint();
		openCb?.(field);
	});
	return root;
}

function destroyHost(): void {
	clearPick();
	restoreFieldAria();
	textMirror?.remove();
	if (host) host.remove();
	host = null;
	root = null;
	markEl = null;
	countEl = null;
	ghostEl = null;
	pickEl = null;
	pickChipEl = null;
	pickNumEl = null;
	pickNameEl = null;
	liveEl = null;
	textMirror = null;
	hintEl = null;
	hintTextEl = null;
	enterKeyEl = null;
}

/** Write the host's position from the field's box. Returns false when the field is gone. */
let lastLiveCheck = Number.NaN;
let liveField = true;
const LIVE_CHECK_MS = 150;
// The mark is a small icon pinned to a field: 30fps is plenty for following a scroll and halves
// the per-frame rect read. The picker keeps 60fps while its menu is open.
const TRACK_FRAME_MS = 30;
function position(rectOverride?: DOMRect, liveKnown = false): boolean {
	if (!field || !host) return false;
	const rect = rectOverride ?? field.getBoundingClientRect();
	lastRect = rect;
	// `anchorIsLive` reads computed visibility and client rects; the field's *position* must be
	// followed every frame, but its liveness does not. Check it at ~7Hz, like the picker's hit test.
	// When the picker's tracker supplies the rect it has already done the live check.
	if (!liveKnown) {
		const now = performance.now();
		if (Number.isNaN(lastLiveCheck) || now - lastLiveCheck >= LIVE_CHECK_MS) {
			lastLiveCheck = now;
			liveField = anchorIsLive(field, rect);
		}
	}
	// The field's text box can be much shorter than its visual wrapper: Yahoo's is 17.5px inside a
	// 42px control. The mark only needs enough room for its centre line, so use the same floor as
	// `isRendered`, not the control's height. A narrow field (a site's small user/password boxes
	// are often under 88px) still gets the mark: the 26px button overlaps the text, and the user
	// types to the left of it.
	if (!liveField || field.disabled || field.readOnly || rect.width < 34 || rect.height < 12) {
		hide();
		return false;
	}
	const offset = hostOffset(host);
	const transform = `translate3d(${rect.left + offset.x}px, ${rect.top + offset.y}px, 0)`;
	const width = `${rect.width}px`;
	const height = `${rect.height}px`;
	if (host.style.transform !== transform) host.style.transform = transform;
	if (host.style.width !== width) host.style.width = width;
	if (host.style.height !== height) host.style.height = height;
	const markInset = `${insetFor(field, rect)}px`;
	if (host.style.getPropertyValue("--mark-inset") !== markInset) {
		host.style.setProperty("--mark-inset", markInset);
	}
	host.classList.toggle("above", rect.bottom + 64 > window.innerHeight);
	return true;
}

/** The picker's tracker owns the field rect while a menu is open; feed it to the mark so there is
 *  one loop and one `getBoundingClientRect`, not two. */
function reposition(rect: DOMRect): void {
	if (visible && trackingSuspended) position(rect, true);
}

function tick(ts: number): void {
	raf = null;
	if (!visible || !field || !host) return;
	if (ts - lastTrackFrame < TRACK_FRAME_MS) {
		raf = requestAnimationFrame(tick);
		return;
	}
	lastTrackFrame = ts;
	if (!position()) return;
	raf = requestAnimationFrame(tick);
}

function startTracking(): void {
	if (trackingSuspended || raf !== null) return;
	raf = requestAnimationFrame(tick);
}

function stopTracking(): void {
	if (raf !== null) {
		cancelAnimationFrame(raf);
		raf = null;
	}
}

/** While a picker is open its tracker follows the field; the mark's own loop would be a second
 *  rect read per frame. The picker feeds `reposition` instead. */
function suspendTracking(): void {
	trackingSuspended = true;
	stopTracking();
}

function resumeTracking(): void {
	trackingSuspended = false;
	if (visible) startTracking();
}

const PICK_ENTER_MS = 100;
// Deliberately slow: the entry name is a confirmation the user reads, not a transient toast.
const PICK_EXIT_MS = 2000;
const PICK_HOLD_MS = 2000;
// A keyboard cycle repeats rapidly, so it gets a short hold and a fade, not the 2s slide.
const CYCLE_HOLD_MS = 800;
const CYCLE_EXIT_MS = 160;
// Reduced motion keeps the 2s read but replaces the 2s fade with a short one.
const REDUCED_EXIT_MS = 200;

function clearPick(): void {
	if (pickTimer !== null) {
		clearTimeout(pickTimer);
		pickTimer = null;
	}
	if (pickAnim) {
		pickAnim.cancel();
		pickAnim = null;
	}
	pickEl?.classList.remove("show");
	if (pickChipEl) pickChipEl.style.transform = "";
	if (pickNameEl) pickNameEl.textContent = "";
	if (pickNumEl) {
		pickNumEl.textContent = "";
		pickNumEl.hidden = true;
	}
}

function clearHint(): void {
	if (hintTimer !== null) {
		clearTimeout(hintTimer);
		hintTimer = null;
	}
	hintEl?.classList.remove("show");
}

function clearGhost(): void {
	ghostEl?.classList.remove("show");
	if (ghostEl) ghostEl.textContent = "";
	enterKeyEl?.classList.remove("show");
}

function hide(): void {
	stopTracking();
	visible = false;
	if (host) host.style.display = "none";
	if (field) restoreFieldAria(field);
	field = null;
	lastRect = null;
	previewStyle = null;
	clearGhost();
	clearPick();
	clearHint();
	setCount(0);
}

/** The count drawn inside the berry: how many entries this field would show. `0` draws nothing. */
function setCount(count: number | undefined): void {
	if (!countEl) return;
	const n = Math.floor(count ?? 0);
	countEl.textContent = n > 0 ? (n > COUNT_MAX ? `${COUNT_MAX}+` : String(n)) : "";
	// The count is `aria-hidden` inside the button, so put it in the accessible name too: a
	// screen-reader user should know how many entries the mark offers before opening it.
	markEl?.setAttribute(
		"aria-label",
		n > 0
			? `${t("autofillOpenMenu")} (${n > COUNT_MAX ? `${COUNT_MAX}+` : n})`
			: t("autofillOpenMenu"),
	);
}

/**
 * Announce a short confirmation through the visually hidden live region. Clearing first makes a
 * repeated identical message (the same entry picked twice) announce again instead of being
 * swallowed as an unchanged node.
 */
function announce(text: string): void {
	if (!liveEl || !text) return;
	liveEl.textContent = "";
	queueMicrotask(() => {
		if (liveEl) liveEl.textContent = text;
	});
}

// The field is a real combobox while the mark is up. The menu lives in an iframe (or a closed
// shadow root), so `aria-controls`/`aria-activedescendant` cannot reference its rows across the
// boundary; the open/closed state rides `aria-expanded` and the active row is announced through
// the live region instead. Save the page's own values and put them back on hide.
type SavedAria = { haspopup: string | null; expanded: string | null };
const savedAria = new WeakMap<HTMLInputElement, SavedAria>();
let ariaField: HTMLInputElement | null = null;

function decorateFieldAria(next: HTMLInputElement): void {
	if (ariaField === next) return;
	if (ariaField) restoreFieldAria(ariaField);
	ariaField = next;
	savedAria.set(next, {
		haspopup: next.getAttribute("aria-haspopup"),
		expanded: next.getAttribute("aria-expanded"),
	});
	next.setAttribute("aria-haspopup", "listbox");
	if (savedAria.get(next)?.expanded === null) next.setAttribute("aria-expanded", "false");
}

function restoreFieldAria(target: HTMLInputElement | null = ariaField): void {
	if (!target) return;
	const saved = savedAria.get(target);
	if (!saved) return;
	if (saved.haspopup === null) target.removeAttribute("aria-haspopup");
	else target.setAttribute("aria-haspopup", saved.haspopup);
	if (saved.expanded === null) target.removeAttribute("aria-expanded");
	else target.setAttribute("aria-expanded", saved.expanded);
	savedAria.delete(target);
	if (ariaField === target) ariaField = null;
}

function setExpanded(open: boolean): void {
	ariaField?.setAttribute("aria-expanded", open ? "true" : "false");
}

/** True when a page click at viewport (x, y) lands inside the mark's 26px button on `target`.
 *  The host is the click target when it is there; this covers the moment it is not (a menu is
 *  collapsing, or the pointer just arrived on the field), where the click reaches the input. */
/** The 26px mark zone, or its half away from the row's open button when the menu covers it. */
function markZoneAt(
	rect: DOMRect,
	rtl: boolean,
	x: number,
	y: number,
	inset: number,
	half: "full" | "switch",
): boolean {
	const edge = rtl ? rect.left + inset : rect.right - inset;
	const centerY = rect.top + rect.height / 2;
	const inX =
		half === "full"
			? rtl
				? x >= edge && x <= edge + 26
				: x >= edge - 26 && x <= edge
			: rtl
				? x >= edge + 12 && x <= edge + 26
				: x >= edge - 26 && x <= edge - 12;
	return inX && y >= centerY - 13 && y <= centerY + 13;
}

function isMarkZone(target: HTMLInputElement, x: number, y: number): boolean {
	const rect = target.getBoundingClientRect();
	const rtl = getComputedStyle(target).direction === "rtl";
	return markZoneAt(rect, rtl, x, y, insetFor(target, rect), "full");
}

/** The left half of the mark button. Used when the menu covers the field: the row's own open
 *  button sits over the mark's right half, so only the left half means "switch fields" and the
 *  button keeps the rest of its hit area. */
function isMarkSwitchZone(target: HTMLInputElement, x: number, y: number): boolean {
	const rect = target.getBoundingClientRect();
	const rtl = getComputedStyle(target).direction === "rtl";
	// The menu covers the field here; reuse the inset the mark was last drawn at rather than
	// hit-testing through the menu.
	return markZoneAt(rect, rtl, x, y, insetFor(target, rect, false), "switch");
}

/** Attach the host to `next` and start tracking it. Shared by the mark, the pick chip and the
 *  hint: all live in the same shadow root, so they need the same attach/position/track block. */
function attach(next: HTMLInputElement): boolean {
	const shadow = ensureHost();
	if (!shadow || !host) return false;
	const changed = field !== next;
	field = next;
	visible = true;
	host.style.display = "block";
	if (changed) {
		lastLiveCheck = Number.NaN;
		liveField = true;
		clearGhost();
		clearPick();
		clearHint();
	}
	try {
		const cs = getComputedStyle(next);
		host.style.setProperty(
			"--mark-ink",
			cs.color && cs.color !== "transparent" ? cs.color : "#4b5563",
		);
		// The entry-name chip borrows the field's font family, so it reads as part of the form.
		if (cs.fontFamily) host.style.setProperty("--pick-font", cs.fontFamily);
		else host.style.removeProperty("--pick-font");
		// The mark sits at the inline end; the chip slides in from that end. In RTL the chip is
		// on the other side of the berry, so the hidden offset is negative.
		host.style.setProperty("--pick-shift", cs.direction === "rtl" ? "-100%" : "100%");
	} catch {
		host.style.setProperty("--mark-ink", "#4b5563");
		host.style.setProperty("--pick-shift", "100%");
	}
	host.classList.toggle("no-mark", !markAllowed);
	if (!position()) return false;
	startTracking();
	return true;
}

/** Show the mark on `field`. `hint` is a one-time explanation, already localized; `count` is the
 *  number of entries the field would show, drawn inside the berry. */
function show(next: HTMLInputElement, opts?: { hint?: string; count?: number }): void {
	if (!markAllowed) {
		// Shortcut-only mode has no mark to extend from; a flash still draws the chip.
		hide();
		return;
	}
	if (!attach(next)) return;
	decorateFieldAria(next);
	setCount(opts?.count);
	// Show the hint whenever it is due, not only when the field changed: on a cold page the mark
	// can paint from the cached result before the query that carries `hint` has landed, and the
	// second `show` for the same field is the one that has it.
	if (opts?.hint && !hintEl?.classList.contains("show")) showHint(opts.hint);
}

function showHint(text: string): void {
	if (!hintEl || !hintTextEl) return;
	hintTextEl.textContent = text;
	hintEl.classList.add("show");
	if (hintTimer !== null) clearTimeout(hintTimer);
	hintTimer = setTimeout(() => {
		hintTimer = null;
		hintEl?.classList.remove("show");
	}, 5000);
	hintShownCb?.();
}

/** The username completion: `remainder` is the part the user has not typed. Returns true only
 *  when the ghost was actually drawn: the caller keeps its Enter state only then, so a completion
 *  the user cannot see cannot be accepted. */
function preview(next: HTMLInputElement, remainder: string): boolean {
	if (!visible || !host || !ghostEl || next !== field || !remainder) {
		clearGhost();
		return false;
	}
	try {
		// One `getComputedStyle` per field per second, not one per keystroke: the font, ink and
		// direction a completion borrows do not change between keystrokes, and this call can force
		// style resolution on a busy page. The tracker already has the rect from this frame.
		const now = performance.now();
		const cs =
			previewStyle && previewStyle.field === next && now - previewStyle.at < 1000
				? previewStyle.cs
				: getComputedStyle(next);
		previewStyle = { field: next, cs, at: now };
		// Right-to-left fields place the caret at the other end; a left-anchored completion would
		// land in the wrong place, so leave it out rather than paint something misleading.
		if (cs.direction === "rtl") {
			clearGhost();
			return false;
		}
		const rect = lastRect ?? next.getBoundingClientRect();
		const paddingLeft = Number.parseFloat(cs.paddingLeft) || 0;
		const borderLeft = Number.parseFloat(cs.borderLeftWidth) || 0;
		const left = Math.max(
			0,
			borderLeft + paddingLeft + textWidth(next.value, cs) - next.scrollLeft,
		);
		const width = textWidth(remainder, cs);
		// Leave room for the mark and the Enter keycap at the inline end; a completion clipped in the
		// middle of an address is worse than no completion.
		if (left + width > rect.width - 88) {
			clearGhost();
			return false;
		}
		ghostEl.style.left = `${left}px`;
		ghostEl.style.fontFamily = cs.fontFamily;
		ghostEl.style.fontSize = cs.fontSize;
		ghostEl.style.fontWeight = cs.fontWeight;
		ghostEl.style.fontStyle = cs.fontStyle;
		ghostEl.style.letterSpacing = cs.letterSpacing;
		ghostEl.style.color = cs.color;
		ghostEl.textContent = remainder;
		ghostEl.classList.add("show");
		enterKeyEl?.classList.add("show");
		return true;
	} catch {
		clearGhost();
		return false;
	}
}

/** Show the Enter keycap for a fully typed saved username, with no ghost. Returns true when it
 *  was drawn: the exact-match Enter fill only fires while this confirmation is visible. */
function previewExact(next: HTMLInputElement): boolean {
	if (!visible || !host || next !== field) {
		clearGhost();
		return false;
	}
	if (ghostEl) {
		ghostEl.classList.remove("show");
		ghostEl.textContent = "";
	}
	enterKeyEl?.classList.add("show");
	return true;
}

/** Width of `text` in the field's own font. The mirror span lives inside the closed shadow root:
 *  it borrows the page's font metrics, but the page cannot read the suggested username out of its
 *  own DOM. One span is reused, so a keystroke does not append and remove nodes. */
function textWidth(text: string, cs: CSSStyleDeclaration): number {
	const mirror = textMirror;
	if (!mirror) return 0;
	mirror.textContent = text;
	mirror.style.fontFamily = cs.fontFamily;
	mirror.style.fontSize = cs.fontSize;
	mirror.style.fontWeight = cs.fontWeight;
	mirror.style.fontStyle = cs.fontStyle;
	mirror.style.letterSpacing = cs.letterSpacing;
	return mirror.getBoundingClientRect().width;
}

/**
 * The entry name as an extension of the mark: it extends out of the berry, holds, then scrolls
 * back into it and hides. Transform only, so the field's own text and the menu are untouched.
 *
 * `quick` is the keyboard cycle's variant: a short hold and a plain fade, because the cycle is a
 * repeated shortcut and the 2s slide would be motion on a high-frequency action. The mouse/Enter
 * pick keeps the deliberate 2s hold + 2s slide the design asks for.
 */
function flash(
	next: HTMLInputElement,
	name: string,
	counter?: string,
	opts?: { quick?: boolean },
): void {
	if (!attach(next)) return;
	if (!pickEl || !pickChipEl || !pickNumEl || !pickNameEl) return;
	clearHint();
	clearPick();
	pickNumEl.textContent = counter ?? "";
	pickNumEl.hidden = !counter;
	pickNameEl.textContent = name;
	pickEl.classList.add("show");
	// The live region is the screen-reader confirmation; the chip is the visual one.
	announce(counter ? `${counter} ${name}` : name);
	const quick = opts?.quick === true;
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
	const shift =
		window.getComputedStyle(pickChipEl).getPropertyValue("--pick-shift").trim() || "100%";
	const enter = quick || reduced ? 0 : PICK_ENTER_MS;
	const hold = quick ? CYCLE_HOLD_MS : PICK_HOLD_MS;
	const exit = quick ? CYCLE_EXIT_MS : reduced ? REDUCED_EXIT_MS : PICK_EXIT_MS;
	const total = enter + hold + exit;
	if (typeof pickChipEl.animate === "function") {
		if (quick || reduced) {
			// No slide: a hold, then a short fade. Reduced motion keeps the 2s read, not the 2s fade.
			pickAnim = pickChipEl.animate(
				[{ opacity: 1 }, { opacity: 1, offset: (enter + hold) / total }, { opacity: 0 }],
				{ duration: total, easing: "ease-out", fill: "forwards" },
			);
		} else {
			pickAnim = pickChipEl.animate(
				[
					{ transform: `translateX(${shift})` },
					{ transform: "translateX(0)", offset: enter / total },
					{ transform: "translateX(0)", offset: (enter + hold) / total },
					{ transform: `translateX(${shift})` },
				],
				{ duration: total, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
			);
		}
		pickAnim.onfinish = () => {
			pickAnim = null;
			pickEl?.classList.remove("show");
			if (pickChipEl) pickChipEl.style.transform = "";
			if (!markAllowed && visible) hide();
		};
	}
	// The timer is the fallback (and the only path in jsdom): hide even if WAAPI is throttled.
	if (pickTimer !== null) clearTimeout(pickTimer);
	pickTimer = setTimeout(() => {
		pickTimer = null;
		pickEl?.classList.remove("show");
		if (pickChipEl) pickChipEl.style.transform = "";
		if (!markAllowed && visible) hide();
	}, total + 60);
}

/** Whether the mark is actually painted where the user can see it. The Enter fill paths use this
 *  as their trust gate: a page that hides, fades, covers, moves or camouflages the mark cannot turn
 *  a stray Enter into a credential fill. The host is pointer-events: none except for the button, so
 *  the hit test is taken at the button and resolves to the host (closed shadow content is
 *  retargeted). */
function markTrustworthy(): boolean {
	if (!visible || !markAllowed || !host || !markEl?.isConnected || !field) return false;
	const fieldRect = field.getBoundingClientRect();
	const rect = markEl.getBoundingClientRect();
	if (rect.width < 16 || rect.height < 16) return false;
	// The mark's centre must still be on its field: a page that moves the host elsewhere has not
	// drawn a confirmation for this field, whatever the button's own box says.
	const cx = rect.left + rect.width / 2;
	const cy = rect.top + rect.height / 2;
	if (cx < fieldRect.left || cx > fieldRect.right || cy < fieldRect.top || cy > fieldRect.bottom) {
		return false;
	}
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= window.innerHeight ||
		rect.left >= window.innerWidth
	) {
		return false;
	}
	const hostCs = getComputedStyle(host);
	if (hostCs.visibility === "hidden" || hostCs.display === "none") return false;
	if (effectiveOpacity(host) < 0.9) return false;
	if (
		(hostCs.filter && hostCs.filter !== "none") ||
		(hostCs.mixBlendMode && hostCs.mixBlendMode !== "normal") ||
		(hostCs.clipPath && hostCs.clipPath !== "none")
	) {
		return false;
	}
	// A page can set --mark-ink on the host. A transparent or camouflaged mark is not a
	// confirmation, even though the button is still hit-testable. The mark's own inline colour
	// wins when present; jsdom does not resolve the shadow stylesheet's var() in
	// getComputedStyle, so fall back to the host's inline value there.
	const computedInk = getComputedStyle(markEl).color;
	const inlineInk = markEl.style.color;
	const ink = parseColor(inlineInk)
		? inlineInk
		: parseColor(computedInk)
			? computedInk
			: host.style.getPropertyValue("--mark-ink") || "#4b5563";
	if (!fieldInkIsVisible(field, ink)) return false;
	// jsdom and engines without CSSOM View: fail open, the way the picker's reachability test does.
	if (typeof document.elementFromPoint !== "function") return true;
	const top = document.elementFromPoint(cx, cy);
	if (!top) return false;
	return top === host || host.contains(top);
}

/** Shortcut-only mode: no mark, no ghost, but the pick chip still reports a fill. */
function setMarkAllowed(allowed: boolean): void {
	markAllowed = allowed;
	host?.classList.toggle("no-mark", !allowed);
	if (!allowed) {
		clearGhost();
		if (visible) hide();
	}
}

onTeardown(() => {
	stopTracking();
	destroyHost();
});

/** The in-field affordance facade. */
export const affordance = {
	show,
	hide,
	preview,
	previewExact,
	clearPreview: clearGhost,
	dismissPick: clearPick,
	flash,
	setMarkAllowed,
	markTrustworthy,
	dismissHint: clearHint,
	/** Reflect the menu's open state on the field for screen readers. */
	setExpanded,
	isMarkZone,
	isMarkSwitchZone,
	/** Announce a picker row or a fill through the persistent live region. */
	announce,
	/** The picker's tracker owns the field rect while a menu is open; the mark follows it. */
	suspendTracking,
	resumeTracking,
	reposition,
	visibleFor: (): HTMLInputElement | null => (visible ? field : null),
	/** True when `node` is the affordance host (a pointer event's retargeted target). */
	ownsNode: (node: Node): boolean => !!host && (node === host || host.contains(node)),
	/** The mark's viewport rect, for a menu that collapses back into it. Null when the mark is
	 *  not drawn (shortcut-only mode, hidden field), so the caller can close instantly. */
	markRect: (): DOMRect | null => {
		if (!visible || !markAllowed || !markEl?.isConnected) return null;
		return markEl.getBoundingClientRect();
	},
	onOpen(cb: (field: HTMLInputElement) => void): void {
		openCb = cb;
	},
	onHintShown(cb: () => void): void {
		hintShownCb = cb;
	},
};

/**
 * Test seam: the closed shadow root, which `host.shadowRoot` hides from the page by design.
 * Only code that can import this module reaches it; the page still cannot.
 */
export function __shadowRootForTest(): ShadowRoot | null {
	return root;
}
