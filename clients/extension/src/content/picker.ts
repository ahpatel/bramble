/// <reference types="chrome" />

import { api } from "./content-api";
import { anchorIsLive, deepActiveElement } from "./detection";
import { type FieldSkin, sampleFieldSkin, skinKey } from "./field-skin";
import { hostOffset } from "./host-offset";
import { type AliasRowState, dropdownAlias } from "./html/dropdown-alias";
import { dropdownItem } from "./html/dropdown-item";
import { dropdownLocked } from "./html/dropdown-locked";
import { dropdownNewLogin } from "./html/dropdown-new-login";
import { dropdownStyles } from "./html/dropdown-styles";
import { dropdownSuggest } from "./html/dropdown-suggest";
import { EARLY_CLICK_MS, isLegible } from "./legibility";
import { onTeardown } from "./lifecycle";
import type { MatchSummary } from "./types";

// The autofill picker: an extension-origin iframe (primary) with a closed-shadow
// dropdown as the COEP fallback. This module hides the iframe-vs-shadow decision,
// the postMessage bridge + origin checks, the clickjacking guard, positioning,
// and keyboard nav behind the `picker` facade at the bottom.

// User actions are reported via callbacks so this module never messages the
// background or touches the page's display policy directly.
let pickCb: ((entryId: string, otpOnly: boolean) => void) | null = null;
// Reports the field the unlock was requested from: clicking the locked row dismisses the picker,
// so the content policy needs the anchor to re-surface matches on it once the vault unlocks.
let unlockCb: ((field: HTMLInputElement | null) => void) | null = null;
let dismissCb: (() => void) | null = null;
// The generated-password suggestion row reports through its own callbacks so the
// content policy owns generation and the fill (this module never touches secrets).
let onSuggestedCb: (() => void) | null = null;
let regenerateCb: (() => void) | null = null;
// The alias row reports the same way, so this module never learns what an alias is or who makes
// one; the content policy owns the round trip and the fill.
let aliasCb: (() => void) | null = null;
// The "new login" row opens the create form; the content policy owns that request.
let newLoginCb: (() => void) | null = null;

// A suggest option threads a generated password to whichever renderer is active.
type SuggestOpt = { password: string };

/** Row options threaded to whichever renderer is active. */
type RowOpts = {
	otpOnly?: boolean;
	suggest?: SuggestOpt;
	alias?: AliasRowState;
	carriedId?: string;
	newLogin?: boolean;
	/** The anchor field's look, sampled once when the picker opens. */
	skin?: FieldSkin;
};

/**
 * Cache key for a rendered match set plus its optional extra rows.
 *
 * The alias row's STATE is part of the key, and has to be: the cache exists so a re-query on
 * every DOM mutation does not reflicker an identical dropdown, and it compares content. The
 * suggested-password row is static content, so its password sufficed. An alias row changes from
 * invitation to spinner to error without the matches moving, and keyed on content alone the
 * dropdown would render once and then sit frozen on whichever state it was first drawn in.
 */
function renderKey(matches: MatchSummary[], opts?: RowOpts): string {
	const alias = opts?.alias;
	const a = alias
		? `a:${alias.state}:${alias.state === "error" ? (alias.message ?? "") : ""}\0`
		: "";
	// The carried id is part of the content: the same rows with a different card marked is a
	// different dropdown, and keyed on ids alone the badge would stay where it was first drawn.
	const c = opts?.carriedId ? `c:${opts.carriedId}\0` : "";
	const n = opts?.newLogin ? "n\0" : "";
	const s = opts?.skin ? `k:${skinKey(opts.skin)}\0` : "";
	return (
		a + c + n + s + (opts?.suggest ? `s:${opts.suggest.password}\0` : "") + matchesKey(matches)
	);
}

// Anchor field shared by both renderers (the page input the picker sits under).
let anchorField: HTMLInputElement | null = null;

// The field whose native autocomplete we overrode while taking it over, plus its original
// value, so we can put it back when we let go.
let suppressedField: HTMLInputElement | null = null;
let suppressedAutocomplete: string | null = null;

// Tokens we would blind ourselves by overwriting. `one-time-code` is the strongest rung of OTP
// detection, and on a segmented widget it is often the ONLY thing marking the boxes; `cc-*` is
// the first rung of card detection and on a hosted-fields frame the field's name is frequently
// just "number" (see docs/field-detection.md). Writing over either takes the field out of the
// model at the next re-parse, and the user's pick is then refused as landing on nothing: the
// dropdown opens, clicking it does nothing, and the field is never offered again.
//
// A payment modal makes it worse than a no-op. Paymentus ships a Credit tab and a Debit tab,
// each with a full set of cc-* fields and only one displayed; strip the token off the visible
// card-number box and `ccByToken` resolves to the hidden tab's copy, so the model now points at
// a field nobody can see. That was reported as "it proposed autofill, I clicked my card, it
// didn't fill at all, and then it stopped offering".
//
// The cost is that a browser's own card / code dropdown may render over ours on these fields.
// That is the right way round: an overlapping suggestion is a nuisance, a fill that silently
// does nothing is a broken feature. Password tokens are still suppressed, because no rung of
// login detection depends on them (the password's nearest preceding text input carries it).
const LOAD_BEARING_TOKEN_RE = /\bone-time-code\b|\bcc-[a-z]+(-[a-z]+)*\b/i;

// Route every anchorField change through here so the browser's native autofill is
// suppressed on exactly the field Bramble is handling and restored the moment we release
// it - otherwise the native dropdown renders on top of ours. The MutationObserver watches
// childList/subtree only (not attributes), so this write never invalidates the field-model
// cache directly; our own host insertion does, and the re-parse that follows reads whatever
// is on the field then. Best-effort: autocomplete="off" reliably suppresses Firefox and
// generic Chrome autofill; Chrome's own password UI on a recognized login field may persist.
function setAnchorField(field: HTMLInputElement | null): void {
	anchorField = field;
	// A new anchor is reachable until its own hit test says otherwise.
	lastHitTest = Number.NaN;
	anchorUnreachable = false;
	if (suppressedField && suppressedField !== field) {
		if (suppressedAutocomplete === null) suppressedField.removeAttribute("autocomplete");
		else suppressedField.setAttribute("autocomplete", suppressedAutocomplete);
		suppressedField = null;
		suppressedAutocomplete = null;
	}
	if (field && field !== suppressedField) {
		const declared = field.getAttribute("autocomplete");
		// Nothing to gain and everything to lose: a browser has no stored one-time code to
		// offer on a desktop, so there is no native dropdown here to get out of the way of.
		if (declared && LOAD_BEARING_TOKEN_RE.test(declared)) return;
		suppressedField = field;
		suppressedAutocomplete = declared;
		field.setAttribute("autocomplete", "off");
	}
}

// Clipping is the one way of hiding a field that leaves it attached, styled visible, and still
// measuring a box: an ancestor collapsed to nothing with `overflow: hidden`, which is how a fair
// number of modals close. No style answers that, and neither does an IntersectionObserver, which
// looks like the tool for it and is not - a LIVE observer never fires when only an ancestor's
// clip changes, while a fresh one on the identical page reports zero. A hit test at the field's
// own centre does answer it, and catches an overlay dropped on top of the field for free.
//
// Rate-limited rather than run per frame: it forces a hit test, and a dismissal does not need
// 60Hz. `getRootNode()` keeps it correct for a field inside a shadow root, where the document's
// own elementFromPoint would answer with the host and never with the field.
const HIT_TEST_MS = 150;
let lastHitTest = Number.NaN;
let anchorUnreachable = false;

function anchorIsReachable(field: HTMLInputElement, rect: DOMRect): boolean {
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	// Nothing to hit outside the viewport. A field merely scrolled out of sight keeps its
	// picker, which rides along with it, as it always has.
	if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true;
	const root = field.getRootNode() as Node & Partial<DocumentOrShadowRoot>;
	// No hit testing to be had (jsdom, and any engine without CSSOM View): fail open, the way
	// isVisibleCss does without checkVisibility. Never dismiss on a question we cannot ask.
	if (typeof root.elementFromPoint !== "function") return true;
	const top = root.elementFromPoint(x, y);
	if (!top) return false;
	// elementFromPoint answers with the DEEPEST element at the point, so a field that is
	// really there answers with itself, or with an icon painted inside it. An ANCESTOR coming
	// back means the point fell through to whatever is behind: `<body>` contains the field
	// too, so accepting ancestors here would accept every clipped-away field there is.
	return top === field || field.contains(top);
}

function matchesKey(matches: MatchSummary[]): string {
	let out = "";
	for (const m of matches) out += `${m.id}\0`;
	return out;
}

/** True when a click landed on the anchor field or a `<label>` that routes to it. */
function clickIsOnAnchor(target: Node): boolean {
	if (!anchorField) return false;
	if (target === anchorField || anchorField.contains(target)) return true;
	if (target instanceof Element) {
		const label = target.closest("label");
		if (label) {
			if (anchorField.id && label.htmlFor === anchorField.id) return true;
			if (label.contains(anchorField)) return true;
		}
	}
	return false;
}

/** Match the field width for an integrated look; floored so it stays substantial
 *  on narrow fields and capped so very wide fields don't sprawl. Never wider than the
 *  viewport, which a 320px field on a 360px phone used to overflow. */
function pickerWidth(fieldWidth: number): number {
	const viewport = Math.max(200, window.innerWidth - 16);
	return Math.min(Math.max(fieldWidth, 260), 420, viewport);
}

/** The rendered height of whichever host is being positioned, before it has one (0). */
function hostHeight(el: HTMLElement): number {
	if (el === iframeHostEl && iframeEl) return Number.parseFloat(iframeEl.style.height) || 0;
	const h = el.getBoundingClientRect().height;
	return Number.isFinite(h) ? h : 0;
}

/** Anchor a host to `field` via a compositor-friendly transform (no layout). Flips above
 *  the field when there is no room below, and shifts left rather than running off-screen. */
function positionHostElement(el: HTMLElement, field: HTMLInputElement): void {
	const rect = field.getBoundingClientRect();
	const offset = hostOffset(el);
	const width = pickerWidth(rect.width);
	const viewLeft = offset.x;
	const viewTop = offset.y;
	const viewRight = viewLeft + window.innerWidth;
	const viewBottom = viewTop + window.innerHeight;
	let x = rect.left + offset.x;
	const maxX = viewRight - 8 - width;
	if (x > maxX) x = Math.max(viewLeft + 8, maxX);
	let y = rect.bottom + offset.y + 2;
	const height = hostHeight(el);
	// Only flip when the menu actually fits above; otherwise below is the better scroll box.
	if (height > 0 && height < window.innerHeight - 24) {
		const above = rect.top + offset.y - 2 - height;
		if (y + height > viewBottom - 8 && above >= viewTop + 8) y = above;
	}
	// translate (compositor-only) instead of top/left (layout) so the per-frame
	// tracker doesn't thrash layout; write only on change. `0px`, not `0`: the style
	// declaration serializes a bare zero to `0px`, and comparing against `0` made every
	// frame look like a move - which reset the early-click guard forever.
	const transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0px)`;
	const widthPx = `${Math.round(width)}px`;
	if (el.style.transform === transform && el.style.width === widthPx) return;
	el.style.transform = transform;
	el.style.width = widthPx;
	markPickerMoved();
}

// A page that can open or move the picker can put it under a click the user is already making
// (a double-click lure). Clicks before it has sat still this long are dropped; keys are not timed.
let pickerSettledAt = Number.NEGATIVE_INFINITY;

function markPickerMoved(): void {
	pickerSettledAt = performance.now();
}

function clickIsEarly(): boolean {
	return performance.now() - pickerSettledAt < EARLY_CLICK_MS;
}

// Per-frame position tracking while a picker is visible. window 'scroll' is
// composed:false and doesn't bubble, so it never fires for scrolls inside a
// shadow root or a nested modal scroller (e.g. Reddit's login modal). The rAF
// loop keeps the picker pinned; transform writes keep the common case smooth.
let trackingRaf: number | null = null;
let lastAnchor: HTMLInputElement | null = null;
// Hidden mid-scroll: JS tracking trails the compositor inside a modal/shadow
// scroller, so we hide while the field moves and snap back once it settles.
let scrollHidden = false;
let lastMoveTs = 0;
const SCROLL_SETTLE_MS = 120;

function startPositionTracking(): void {
	if (trackingRaf !== null) return;
	// Fresh loop: clear the baseline so the first frame doesn't read as a scroll.
	lastAnchor = null;
	scrollHidden = false;
	const tick = (ts: number): void => {
		const host = activeHost();
		if (!host || !anchorField) {
			trackingRaf = null;
			return;
		}
		const rect = anchorField.getBoundingClientRect();
		if (Number.isNaN(lastHitTest) || ts - lastHitTest >= HIT_TEST_MS) {
			lastHitTest = ts;
			anchorUnreachable = !anchorIsReachable(anchorField, rect);
		}
		// The anchor can go at any time: an SPA route change unmounts the form, a
		// second step replaces the first, a modal closes. Following a field that is
		// no longer there parks the picker in the page's top-left corner instead of
		// taking it down, so a lost anchor dismisses rather than repositions.
		if (!anchorIsLive(anchorField, rect) || anchorUnreachable) {
			stopPositionTracking();
			removeActiveUi();
			return;
		}
		// New field or first frame: re-baseline without treating it as a scroll.
		const rebaseline = anchorField !== lastAnchor;
		const beforeTransform = host.style.transform;
		const beforeWidth = host.style.width;
		positionHostElement(host, anchorField);
		const moved =
			!rebaseline && (beforeTransform !== host.style.transform || beforeWidth !== host.style.width);
		lastAnchor = anchorField;

		// A change in the field's *document* position is an internal/modal scroll
		// (a window scroll leaves document coords constant, so the picker rides
		// along natively). Hide while it moves; snap back once settled.
		if (moved) {
			lastMoveTs = ts;
			if (!scrollHidden) {
				host.style.visibility = "hidden";
				scrollHidden = true;
			}
		} else if (scrollHidden && (rebaseline || ts - lastMoveTs >= SCROLL_SETTLE_MS)) {
			host.style.visibility = "";
			scrollHidden = false;
			markPickerMoved();
		}
		trackingRaf = requestAnimationFrame(tick);
	};
	trackingRaf = requestAnimationFrame(tick);
}

function stopPositionTracking(): void {
	if (trackingRaf !== null) {
		cancelAnimationFrame(trackingRaf);
		trackingRaf = null;
	}
	scrollHidden = false;
}

// --- Shadow dropdown (COEP fallback renderer) ---

const DROPDOWN_ID = "bramble-autofill-dropdown";

let dropdownEl: HTMLElement | null = null;
// Joined ids of the rendered matches; lets re-queries with the same set skip
// the remove-and-re-add cycle that caused flicker on dynamic pages.
let openMatchesKey = "";
let openDropdownKind: "matches" | "locked" | null = null;
// Keyboard navigation for the fallback renderer. The iframe has had this all along; the
// shadow dropdown only ever took a mouse, which meant the shortcut did nothing on a COEP page.
let shadowRows: HTMLElement[] = [];
let shadowHighlight = -1;
let shadowOtpOnly = false;
const SHADOW_ROW_SELECTOR =
	"[data-entry-id], [data-tp-suggest], [data-tp-alias], [data-tp-popout], [data-tp-new-login]";

function removeDropdown(): void {
	if (dropdownEl) {
		dropdownEl.remove();
		dropdownEl = null;
	}
	setAnchorField(null);
	openMatchesKey = "";
	openDropdownKind = null;
	shadowRows = [];
	shadowHighlight = -1;
	shadowOtpOnly = false;
}

function positionDropdown(field: HTMLInputElement): void {
	if (!dropdownEl) return;
	positionHostElement(dropdownEl, field);
}

/** Apply the anchor field's look to the fallback renderer's own box. */
function applySkin(el: HTMLElement, skin: FieldSkin): void {
	el.style.setProperty("--tp-surface", skin.surface);
	el.style.setProperty("--tp-foreground", skin.foreground);
	el.style.setProperty("--tp-muted", skin.muted);
	el.style.setProperty("--tp-border", skin.border);
	el.style.setProperty("--tp-radius", `${skin.radius}px`);
	el.style.setProperty("--tp-row-radius", `${skin.radius <= 2 ? 4 : 8}px`);
	el.style.setProperty("--tp-font-family", skin.fontFamily);
	el.style.setProperty("--tp-font-size", `${skin.fontSize}px`);
	el.style.colorScheme = skin.dark ? "dark" : "light";
}

function mountDropdown(
	field: HTMLInputElement,
	bodyHtml: string,
	skin: FieldSkin,
	animate: boolean,
): ShadowRoot {
	removeDropdown();
	setAnchorField(field);

	const root = document.createElement("div");
	root.id = DROPDOWN_ID;
	// Inline so positioning doesn't depend on the inner stylesheet parsing first. pointer-events:
	// modals set `body { pointer-events: none }`, which the host would inherit.
	root.style.cssText =
		"position: absolute; top: 0; left: 0; z-index: 2147483647; pointer-events: auto;";
	// Closed: page gets `root.shadowRoot === null`. Listener attaches to the returned shadow.
	const shadow = root.attachShadow({ mode: "closed" });
	// Box styling lives on the inner .tp-dropdown (not :host) so the host page's
	// CSS reset can't reach it across the shadow boundary.
	shadow.innerHTML = `${dropdownStyles}<div class="tp-dropdown${animate ? " tp-enter" : ""}">${bodyHtml}</div>`;
	const box = shadow.querySelector<HTMLElement>(".tp-dropdown");
	if (box) applySkin(box, skin);

	dropdownEl = root;
	document.body.appendChild(dropdownEl);
	positionDropdown(field);
	startPositionTracking();
	return shadow;
}

function setShadowHighlight(index: number): void {
	shadowHighlight = index;
	shadowRows.forEach((row, i) => {
		row.classList.toggle("tp-active", i === index);
	});
	const row = shadowRows[index];
	if (row) row.scrollIntoView?.({ block: "nearest" });
}

/** Move the fallback highlight. `wrap` is for the cycle shortcut; arrows clamp like a menu. */
function moveShadowHighlight(delta: number, wrap: boolean): void {
	const n = shadowRows.length;
	if (n === 0) return;
	let next: number;
	if (shadowHighlight < 0) next = delta > 0 ? 0 : n - 1;
	else if (wrap) next = (shadowHighlight + delta + n) % n;
	else next = Math.max(0, Math.min(n - 1, shadowHighlight + delta));
	setShadowHighlight(next);
}

/** Fire the row's action. `pointer` is true only for a real click, which is timed. */
function activateShadowRow(row: HTMLElement, pointer: boolean): void {
	if (row.dataset.entryId) {
		if (pickAllowed(dropdownEl, pointer)) pickCb?.(row.dataset.entryId, shadowOtpOnly);
		return;
	}
	if (row.matches("[data-tp-suggest]")) {
		if (pickAllowed(dropdownEl, pointer)) onSuggestedCb?.();
		return;
	}
	if (row.matches("[data-tp-alias]")) {
		if (pickAllowed(dropdownEl, pointer)) aliasCb?.();
		return;
	}
	if (row.matches("[data-tp-new-login]")) {
		removeDropdown();
		newLoginCb?.();
		return;
	}
	if (row.matches("[data-tp-popout]")) {
		// Capture the anchor before removeDropdown() clears it, so the caller can re-surface here.
		const field = anchorField;
		removeDropdown();
		unlockCb?.(field);
	}
}

/** Arrow/Enter/Escape for the fallback renderer; returns true if the key was consumed. */
function handleShadowKey(e: KeyboardEvent): boolean {
	if (!dropdownEl || !anchorField) return false;
	if (deepActiveElement() !== anchorField) return false;
	if (shadowRows.length === 0) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		moveShadowHighlight(e.key === "ArrowDown" ? 1 : -1, false);
		return true;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		dismissCb?.();
		removeDropdown();
		return true;
	}
	// Enter only picks when a row is highlighted; otherwise the form submits normally.
	if (e.key === "Enter" && shadowHighlight >= 0) {
		const row = shadowRows[shadowHighlight];
		if (!row) return false;
		e.preventDefault();
		activateShadowRow(row, false);
		return true;
	}
	return false;
}

/** The cycle shortcut in the fallback renderer: open on the first row, then wrap. */
function cycleShadow(): boolean {
	if (!dropdownEl || shadowRows.length === 0) return false;
	moveShadowHighlight(1, true);
	return true;
}

/** Renders the match picker anchored to `field`; no-op when content is unchanged to avoid flicker. */
function buildDropdown(matches: MatchSummary[], field: HTMLInputElement, opts?: RowOpts): void {
	if (matches.length === 0 && !opts?.suggest && !opts?.alias) return;

	const skin = opts?.skin ?? sampleFieldSkin(field);
	const key = renderKey(matches, { ...opts, skin });
	// Same content/field already showing: keep the existing dropdown to avoid
	// flicker from re-queries on every DOM mutation.
	if (
		dropdownEl &&
		anchorField === field &&
		openDropdownKind === "matches" &&
		openMatchesKey === key
	) {
		positionDropdown(field);
		return;
	}

	// Suggest row (if any) leads, then the matches. Join verbatim (each piece is
	// already escaped html) rather than interpolating strings, which would re-escape.
	const parts: string[] = [];
	if (opts?.alias) parts.push(dropdownAlias(opts.alias));
	if (opts?.suggest) parts.push(dropdownSuggest(opts.suggest.password));
	for (const m of matches) parts.push(dropdownItem({ ...m, carried: m.id === opts?.carriedId }));
	if (opts?.newLogin) parts.push(dropdownNewLogin());
	// The entry animation belongs to opening, not to a keystroke that narrows the list.
	const animate = !dropdownEl;
	const root = mountDropdown(field, parts.join(""), skin, animate);
	openMatchesKey = key;
	openDropdownKind = "matches";
	shadowOtpOnly = opts?.otpOnly === true;
	shadowRows = Array.from(root.querySelectorAll<HTMLElement>(SHADOW_ROW_SELECTOR));
	shadowHighlight = -1;

	// mousedown (not click) beats the field's blur; otherwise focus leaves first
	// and the click never reaches us.
	root.addEventListener("mousedown", (e) => {
		// Only a real user mousedown may act (no synthetic events).
		if (!e.isTrusted) return;
		const target = e.target as HTMLElement | null;
		// Regenerate sits inside the suggest row, so match it before data-tp-suggest.
		if (target?.closest("[data-tp-regenerate]")) {
			e.preventDefault();
			regenerateCb?.();
			return;
		}
		const item = target?.closest<HTMLElement>(SHADOW_ROW_SELECTOR);
		if (!item) return;
		e.preventDefault();
		activateShadowRow(item, true);
	});
}

function buildLockedDropdown(field: HTMLInputElement): void {
	if (dropdownEl && anchorField === field && openDropdownKind === "locked") {
		positionDropdown(field);
		return;
	}
	const skin = sampleFieldSkin(field);
	const animate = !dropdownEl;
	const root = mountDropdown(field, dropdownLocked(), skin, animate);
	openDropdownKind = "locked";
	shadowRows = Array.from(root.querySelectorAll<HTMLElement>(SHADOW_ROW_SELECTOR));
	shadowHighlight = -1;

	// mousedown beats the field's blur; otherwise the row never gets the click.
	root.addEventListener("mousedown", (e) => {
		// Only a genuine user click opens the pop-out.
		if (!e.isTrusted) return;
		const item = (e.target as HTMLElement | null)?.closest<HTMLElement>(SHADOW_ROW_SELECTOR);
		if (!item) return;
		e.preventDefault();
		activateShadowRow(item, false);
	});
}

// --- Iframe renderer (primary); the shadow path above is the COEP fallback. ---

const AUTOFILL_UI_URL = api.runtime.getURL("autofill-ui.html");
// The extension url scheme (chrome-extension: / moz-extension:), the one thing about the iframe's
// origin we can know up front.
const EXT_SCHEME = new URL(AUTOFILL_UI_URL).protocol;
// Our end of the private channel handed to the iframe at its READY. The page shares the window
// both of us would otherwise talk on, so everything after READY rides this port. READY's origin
// pins the hand-over, and it is NOT always the origin of the url we set as src: under Chromium's
// manifest `use_dynamic_url`, getURL hands a content script a per-session GUID origin while the
// document it loads reports the extension's static one. Pinning to the src origin silently
// dropped the hand-over, and the picker fell back to its shadow renderer on every page.
let uiPort: MessagePort | null = null;

type IframeRender =
	| {
			kind: "matches";
			matches: MatchSummary[];
			otpOnly: boolean;
			suggest?: SuggestOpt;
			alias?: AliasRowState;
			carriedId?: string;
			newLogin?: boolean;
			skin: FieldSkin;
			animate: boolean;
	  }
	| { kind: "locked"; skin: FieldSkin; animate: boolean };

// "probe" until the first mount resolves to iframe (READY) or shadow (timeout).
let uiMode: "probe" | "iframe" | "shadow" = "probe";
let iframeHostEl: HTMLElement | null = null;
let iframeEl: HTMLIFrameElement | null = null;
let iframeReady = false;
let pendingRender: IframeRender | null = null;
let readinessTimer: number | null = null;
let iframeMatchesKey = "";
// Whether the iframe has a keyboard-highlighted row (drives Enter-to-pick). Tracked from the
// renders and arrows we send, which the iframe applies in order, not from its UI_HIGHLIGHT: that
// arrives a round trip late and lost the race to a quick Enter.
let iframeHasHighlight = false;
let iframeNavRows = 0;
// A cycle request that arrived before the first render landed. The shortcut opens the list and
// immediately asks for the first row, and on a cold iframe that request would be posted before
// UI_CONNECTED and dropped.
let pendingCycle = false;
// Close fade: the host is hidden rather than destroyed, so the next open is instant. The timer
// is what actually takes it out of the hit-testing tree.
let hideTimer: number | null = null;
// Ids last sent to the iframe. A pick naming anything else is dropped, as in relay-client.ts.
let iframeRenderedIds = new Set<string>();

function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Hide the iframe host (kept alive for reuse). Fades first unless reduced motion is asked for. */
function hideIframe(): void {
	if (hideTimer !== null) {
		clearTimeout(hideTimer);
		hideTimer = null;
	}
	if (iframeHostEl) {
		// Drop a mid-scroll hide with it: the next show starts a fresh tracking loop,
		// whose baseline is "not hidden", so nothing would ever clear it again.
		iframeHostEl.style.visibility = "";
		if (prefersReducedMotion()) {
			iframeHostEl.style.opacity = "";
			iframeHostEl.style.display = "none";
		} else {
			iframeHostEl.style.opacity = "0";
			const host = iframeHostEl;
			hideTimer = window.setTimeout(() => {
				hideTimer = null;
				host.style.display = "none";
				host.style.opacity = "";
			}, 120);
		}
	}
	iframeMatchesKey = "";
	iframeHasHighlight = false;
	pendingCycle = false;
	setAnchorField(null);
}

/** Tear the iframe host down entirely (extension teardown / COEP fallback). */
function destroyIframeHost(): void {
	if (readinessTimer !== null) {
		clearTimeout(readinessTimer);
		readinessTimer = null;
	}
	if (hideTimer !== null) {
		clearTimeout(hideTimer);
		hideTimer = null;
	}
	if (iframeHostEl) {
		iframeHostEl.remove();
		iframeHostEl = null;
	}
	iframeEl = null;
	iframeReady = false;
	closeUiPort();
	iframeRenderedIds = new Set();
	pendingRender = null;
	pendingCycle = false;
	iframeMatchesKey = "";
	iframeHasHighlight = false;
	setAnchorField(null);
}

/** Create the iframe host (closed-shadow wrapper around the extension-origin iframe), or un-hide it if it exists. */
function ensureIframeHost(): void {
	if (iframeHostEl) {
		if (hideTimer !== null) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		if (iframeHostEl.style.display === "none") markPickerMoved();
		iframeHostEl.style.display = "block";
		iframeHostEl.style.opacity = "1";
		return;
	}
	const host = document.createElement("div");
	// Random id: no stable selector for the page to target the host by.
	host.id = `tp-${Math.random().toString(36).slice(2, 10)}`;
	// pointer-events: modals set `body { pointer-events: none }`, which the host would inherit.
	host.style.cssText =
		"position: absolute; top: 0; left: 0; z-index: 2147483647; margin: 0; padding: 0; border: 0; pointer-events: auto; opacity: 0; transition: opacity 120ms ease;";
	const shadow = host.attachShadow({ mode: "closed" });
	const frame = document.createElement("iframe");
	frame.src = `${AUTOFILL_UI_URL}?parentOrigin=${encodeURIComponent(location.origin)}`;
	frame.setAttribute("scrolling", "no");
	// color-scheme: light dark so the iframe isn't given an opaque Canvas backdrop
	// on dark pages (that bled a halo around the card).
	frame.style.cssText =
		"display: block; width: 100%; height: 0; border: 0; margin: 0; background: transparent; color-scheme: light dark;";
	shadow.appendChild(frame);
	document.body.appendChild(host);
	iframeHostEl = host;
	iframeEl = frame;
	iframeReady = false;
	// Next frame, so the transition runs from the initial 0 rather than being coalesced.
	requestAnimationFrame(() => {
		if (iframeHostEl === host && host.style.display !== "none") host.style.opacity = "1";
	});
}

function closeUiPort(): void {
	uiPort?.close();
	uiPort = null;
}

/** Post to the iframe over its port. No-op before the handshake. */
function postToUi(message: unknown): void {
	uiPort?.postMessage(message);
}

function flushPendingRender(): void {
	if (!iframeEl?.contentWindow || !pendingRender) return;
	const render = pendingRender;
	pendingRender = null;
	iframeRenderedIds = new Set(render.kind === "matches" ? render.matches.map((m) => m.id) : []);
	// Mirrors autofill-ui.ts: a render clears the highlight, and a busy alias row takes no keys.
	iframeHasHighlight = false;
	iframeNavRows =
		render.kind === "locked"
			? 1
			: render.matches.length +
				(render.suggest ? 1 : 0) +
				(render.alias && render.alias.state !== "busy" ? 1 : 0);
	if (render.kind === "matches") {
		postToUi({
			type: "RENDER_MATCHES",
			matches: render.matches,
			otpOnly: render.otpOnly,
			suggest: render.suggest,
			alias: render.alias,
			carriedId: render.carriedId,
			newLogin: render.newLogin,
			skin: render.skin,
			animate: render.animate,
		});
	} else {
		postToUi({ type: "RENDER_LOCKED", skin: render.skin, animate: render.animate });
	}
	// A shortcut that opened the list asks for the first row as soon as it exists. The port
	// delivers in order, so the render above is applied first.
	if (pendingCycle) {
		pendingCycle = false;
		if (render.kind === "matches") {
			postToUi({ type: "UI_CYCLE" });
			iframeHasHighlight = iframeNavRows > 0;
		}
	}
}

/** First-mount fallback: if the iframe never reports ready (e.g. COEP blocks it), switch to the shadow renderer. */
function armReadinessTimeout(): void {
	if (readinessTimer !== null || iframeReady) return;
	readinessTimer = window.setTimeout(() => {
		readinessTimer = null;
		if (iframeReady) return;
		uiMode = "shadow";
		const field = anchorField;
		const render = pendingRender;
		// The shortcut may have arrived while the iframe was still starting. Carry that one
		// pending advance across to the renderer that actually took over.
		const cycle = pendingCycle;
		destroyIframeHost();
		if (field && render) {
			if (render.kind === "matches")
				buildDropdown(render.matches, field, {
					otpOnly: render.otpOnly,
					// Carried over, or falling back to the shadow renderer silently drops whichever
					// extra row was on offer: the suggestion, the alias, and the new-login row.
					suggest: render.suggest,
					alias: render.alias,
					newLogin: render.newLogin,
					carriedId: render.carriedId,
					skin: render.skin,
				});
			else buildLockedDropdown(field);
			if (cycle) cycleShadow();
		}
	}, 700);
}

function iframeShow(field: HTMLInputElement, render: IframeRender): void {
	const wasHidden = !iframeHostEl || iframeHostEl.style.display === "none";
	ensureIframeHost();
	if (!iframeHostEl) return;
	setAnchorField(field);
	positionHostElement(iframeHostEl, field);
	startPositionTracking();
	// The entry animation belongs to the transition from hidden to shown, not to every repaint:
	// a keystroke that narrows the list must not re-play it.
	const next: IframeRender = { ...render, animate: wasHidden };
	// Skip a redundant re-post when the same content is already showing here.
	// The alias state belongs in this key exactly as it does in the shadow renderer's: without it
	// idle and busy hash the same, the re-post is skipped as redundant, and the row never leaves
	// the state it was first drawn in. This is the primary renderer, so that is the whole spinner.
	const key =
		next.kind === "matches"
			? renderKey(next.matches, {
					suggest: next.suggest,
					alias: next.alias,
					carriedId: next.carriedId,
					newLogin: next.newLogin,
					skin: next.skin,
				})
			: `\0locked\0${skinKey(next.skin)}`;
	if (iframeReady && key === iframeMatchesKey) return;
	iframeMatchesKey = key;
	pendingRender = next;
	if (iframeReady) flushPendingRender();
	else armReadinessTimeout();
}

/** Gate for anything that fills: a click must also have waited out EARLY_CLICK_MS. */
function pickAllowed(host: HTMLElement | null, pointer: unknown): boolean {
	if (pointer === true && clickIsEarly()) return false;
	return pickIsTrustworthy(host);
}

/** Pick-time anti-clickjacking: reject a pick when the host is hidden, clipped, overlaid, or off-field. */
function pickIsTrustworthy(host: HTMLElement | null): boolean {
	return !!host && isLegible(host);
}

// --- The visible host (shadow or iframe), positioning, and dismissal ---

/** The host element of whichever picker is currently *visible* (shadow or iframe). */
function activeHost(): HTMLElement | null {
	if (dropdownEl) return dropdownEl;
	if (iframeHostEl && iframeHostEl.style.display !== "none") return iframeHostEl;
	return null;
}

function repositionActive(): void {
	const host = activeHost();
	if (host && anchorField) positionHostElement(host, anchorField);
}

/** Dismiss whichever picker is showing (shadow dropdown or iframe). The iframe is hidden, not destroyed, so it can be reused without re-loading. */
function removeActiveUi(): void {
	removeDropdown();
	hideIframe();
}

// --- Renderer routing: iframe is primary, shadow is the COEP fallback. ---

function showMatchesUi(matches: MatchSummary[], field: HTMLInputElement, opts?: RowOpts): void {
	if (matches.length === 0 && !opts?.suggest && !opts?.alias) return;
	const skin = opts?.skin ?? sampleFieldSkin(field);
	if (uiMode === "shadow") {
		buildDropdown(matches, field, { ...opts, skin });
		return;
	}
	iframeShow(field, {
		kind: "matches",
		matches,
		otpOnly: opts?.otpOnly === true,
		suggest: opts?.suggest,
		alias: opts?.alias,
		carriedId: opts?.carriedId,
		newLogin: opts?.newLogin,
		skin,
		animate: false,
	});
}

function showLockedUi(field: HTMLInputElement): void {
	const skin = sampleFieldSkin(field);
	if (uiMode === "shadow") {
		buildLockedDropdown(field);
		return;
	}
	iframeShow(field, { kind: "locked", skin, animate: false });
}

// Handshake: READY from OUR iframe's window on an extension origin (a page-forged postMessage has a
// different source, and a frame navigated off the extension a different scheme) gets a fresh port.
// Nothing else is taken from the window. A reloaded frame says READY again and gets a new one.
window.addEventListener("message", (e) => {
	const win = iframeEl?.contentWindow;
	if (!win || e.source !== win) return;
	if ((e.data as { type?: string } | undefined)?.type !== "AUTOFILL_UI_READY") return;
	if (!e.origin.startsWith(`${EXT_SCHEME}//`)) return;
	closeUiPort();
	const channel = new MessageChannel();
	uiPort = channel.port1;
	uiPort.onmessage = onUiMessage;
	win.postMessage({ type: "UI_CONNECT" }, e.origin, [channel.port2]);
});

// Bridge from the iframe, over the port only. Ready is the iframe's ack, not its READY, so a frame
// that never takes our port falls back to the shadow renderer like one that never loads.
function onUiMessage(e: MessageEvent): void {
	const msg = e.data as
		| { type: "UI_CONNECTED" }
		| { type: "UI_RESIZE"; height?: number }
		| { type: "UI_PICK"; entryId?: string; otpOnly?: boolean; pointer?: boolean }
		| { type: "UI_POPOUT" }
		| { type: "UI_USE_SUGGESTED"; pointer?: boolean }
		| { type: "UI_REGENERATE" }
		| { type: "UI_USE_ALIAS"; pointer?: boolean }
		| { type: "UI_NEW_LOGIN" }
		| undefined;
	switch (msg?.type) {
		case "UI_CONNECTED":
			iframeReady = true;
			uiMode = "iframe";
			if (readinessTimer !== null) {
				clearTimeout(readinessTimer);
				readinessTimer = null;
			}
			flushPendingRender();
			break;
		case "UI_RESIZE":
			if (iframeEl) {
				iframeEl.style.height = `${Math.max(0, Math.min(400, Number(msg.height) || 0))}px`;
				// The height decides whether the menu fits below the field, so re-place once it is
				// known. Without this the flip-up decision was made against a 0px frame.
				if (anchorField && iframeHostEl) positionHostElement(iframeHostEl, anchorField);
			}
			break;
		case "UI_PICK":
			if (
				typeof msg.entryId === "string" &&
				iframeRenderedIds.has(msg.entryId) &&
				pickAllowed(iframeHostEl, msg.pointer)
			) {
				pickCb?.(msg.entryId, !!msg.otpOnly);
			}
			break;
		case "UI_POPOUT": {
			// Capture the anchor before hideIframe() clears it, so the caller can re-surface here.
			const field = anchorField;
			hideIframe();
			unlockCb?.(field);
			break;
		}
		case "UI_USE_SUGGESTED":
			// Using the suggestion fills the page field, so it needs the same
			// anti-clickjacking gate as a secret pick.
			if (pickAllowed(iframeHostEl, msg.pointer)) onSuggestedCb?.();
			break;
		case "UI_REGENERATE":
			regenerateCb?.();
			break;
		case "UI_USE_ALIAS":
			// Creating an alias spends the user's allowance and fills the page field, so it takes
			// the same anti-clickjacking gate as a secret pick.
			if (pickAllowed(iframeHostEl, msg.pointer)) aliasCb?.();
			break;
		case "UI_NEW_LOGIN":
			// Opens Bramble's own window and fills nothing, so it needs no clickjacking gate.
			hideIframe();
			newLoginCb?.();
			break;
	}
}

/** Arrow/Enter/Escape navigation for the open dropdown; returns true if the key was consumed. */
function handleDropdownKey(e: KeyboardEvent): boolean {
	if (uiMode === "shadow") return handleShadowKey(e);
	if (uiMode !== "iframe" || !iframeReady || !iframeHostEl) return false;
	if (iframeHostEl.style.display === "none") return false;
	if (deepActiveElement() !== anchorField) return false;
	if (!iframeEl?.contentWindow) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		postToUi({ type: "UI_KEY", key: e.key });
		if (iframeNavRows > 0) iframeHasHighlight = true;
		return true;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		dismissCb?.();
		hideIframe();
		return true;
	}
	// Enter only picks when a row is highlighted; otherwise the form submits normally.
	if (e.key === "Enter" && iframeHasHighlight) {
		e.preventDefault();
		postToUi({ type: "UI_KEY", key: "Enter" });
		return true;
	}
	return false;
}

/**
 * Advance the highlight by one row, wrapping at the end. This is what the browser command
 * drives: the list must already be open (content.ts opens it first), and a cold iframe holds
 * the request until its first render lands. Returns false when there is nothing to cycle.
 */
function cycleUi(): boolean {
	if (uiMode === "shadow") return cycleShadow();
	// `probe` is the iframe before its handshake: the host exists and the first render is
	// pending, so the cycle has somewhere to go once it lands.
	if (!iframeHostEl) return false;
	if (iframeHostEl.style.display === "none") return false;
	if (pendingRender || !iframeReady) {
		pendingCycle = true;
		return true;
	}
	postToUi({ type: "UI_CYCLE" });
	if (iframeNavRows > 0) iframeHasHighlight = true;
	return true;
}

// Tear both renderers down when the extension context is lost.
onTeardown(() => {
	stopPositionTracking();
	removeDropdown();
	destroyIframeHost();
});

/** The autofill picker facade. Hides the iframe-vs-shadow split, the bridge, positioning, and keyboard nav. */
export const picker = {
	showMatches: showMatchesUi,
	showLocked: showLockedUi,
	reposition: repositionActive,
	remove: removeActiveUi,
	// Dismiss only the shadow-dropdown renderer (no-op in iframe mode); preserves
	// the original's removeDropdown-vs-removeActiveUi distinction at its call sites.
	removeDropdown,
	activeHost,
	/** The page field the visible picker is anchored to (the field its row belongs to). */
	anchorField: () => anchorField,
	clickIsOnAnchor,
	handleKey: handleDropdownKey,
	/** Advance the open list's highlight by one row, wrapping. False when nothing is open. */
	cycle: cycleUi,
	/** Fired with (entryId, otpOnly) when the user picks a match. */
	onPick(cb: (entryId: string, otpOnly: boolean) => void): void {
		pickCb = cb;
	},
	/** Fired when the user requests the unlock pop-out (locked row / iframe pop-out). */
	onUnlockRequest(cb: (field: HTMLInputElement | null) => void): void {
		unlockCb = cb;
	},
	/** Fired when the user dismisses the picker via the keyboard (Escape). */
	onDismiss(cb: () => void): void {
		dismissCb = cb;
	},
	/** Fired when the user chooses the generated-password suggestion row. */
	onUseSuggested(cb: () => void): void {
		onSuggestedCb = cb;
	},
	/** Fired when the user clicks the regenerate button on the suggestion row. */
	onRegenerate(cb: () => void): void {
		regenerateCb = cb;
	},
	/** Fired when the user chooses the email-alias row, in any state it accepts a click in. */
	/** Fired when the user chooses the "new login" row. */
	onNewLogin(cb: () => void): void {
		newLoginCb = cb;
	},
	onUseAlias(cb: () => void): void {
		aliasCb = cb;
	},
};
