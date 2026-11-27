/// <reference types="chrome" />

// Content-script entry: bootstraps autofill and wires DOM events to the picker,
// capture, fill, and corner-prompt modules. Holds the page-level display policy
// (the cached query result and the auto-open silence flag); the picker reports
// user actions back through callbacks.

import type { AutofillDensity } from "@core/util/autofill-density";
import type { AutofillTrigger } from "@core/util/autofill-trigger";
import { affordance } from "./affordance";
import { maybeCommitCapture, onPasswordEnter } from "./capture";
import { api } from "./content-api";
import { handleCornerField, handleCornerPromptShow, queryCornerPrompt } from "./corner-prompt";
import {
	anchorIsLive,
	cardFieldsPresent,
	composedTarget,
	couldBeCandidate,
	deepActiveElement,
	hasInteractiveCaptcha,
	isCandidate,
	isRendered,
	kindOf,
	pageUsesShadowDom,
} from "./detection";
import { getPageFields, invalidatePageFields } from "./field-model";
import {
	fillCard,
	fillCustomFields,
	fillForm,
	fillOtp,
	fillPasswordFields,
	fillTextField,
	getLastFilledPassword,
	isFilling,
	submitFromField,
} from "./fill";
import { installFrameRelay, type RelayRect } from "./frame-relay";
import type { AliasRowState } from "./html/dropdown-alias";
import { t } from "./i18n";
import { hostIsTrustworthy } from "./legibility";
import { onTeardown, safeRequest, safeSendMessage } from "./lifecycle";
import {
	holdGeneratedPassword,
	requestGeneratedPassword,
	takeGeneratedPassword,
} from "./password-gen";
import { picker } from "./picker";
import {
	closeRelayed,
	installRelayClient,
	keyToRelayed,
	relayedPickerIsLive,
	relayedPickerIsOpen,
	repositionRelayed,
	showRelayed,
} from "./relay-client";
import { closeRelayHost, destroyRelayHost, relayHostContains, showRelayHost } from "./relay-host";
import {
	isAccountCreationForm,
	isOnAccountCreationForm,
	shouldSuggestAlias,
	shouldSuggestPassword,
	signupPasswordFields,
} from "./signup-detect";
import { type DropdownSkin, dropdownSkin } from "./skin";
import type {
	AliasCreateResponse,
	AutofillQueryResponse,
	AutofillSelectResponse,
	AutofillSubmitRevalidationResponse,
	CornerPromptPayload,
	FillPayload,
	MatchSummary,
	QueryResult,
} from "./types";

/** The entries a field's kind would show, before the typed-login filter and the card carry. */
function entriesForKind(result: QueryResult, kind: ReturnType<typeof kindOf>): MatchSummary[] {
	if (kind === "card") return result.cards;
	if (kind === "otp") return result.otps ?? [];
	return result.logins;
}

let mutationObserver: MutationObserver | null = null;

// `null` until the first query response: distinguishes "unknown" from "queried,
// came back empty" (a locked default would flash "Vault locked" on every load).
let cachedResult: QueryResult | null = null;
// The user turned page autofill off (Settings -> General). Learned from a query response, or
// pushed by the background when the toggle flips. While set, this frame shows no dropdown of any
// kind - matches, the "Vault locked" row, and the generated-password suggestion alike - and stops
// querying until it's turned back on. The background refuses the same requests regardless; this
// is what keeps a disabled page from asking, and from drawing anything the answer can't reach.
let autofillDisabled = false;
// What a click into a candidate field does. "icon" (the default) shows the in-field mark and keeps
// the list closed until it is clicked; "focus" opens the list; "shortcut" draws nothing. Learned
// from every query response and pushed when the setting changes.
let autofillTrigger: AutofillTrigger = "icon";
// The list's row layout. "comfortable" gives the title its own row and the username the next;
// "compact" puts both on one line. Learned from every query response and pushed on change.
let autofillDensity: AutofillDensity = "comfortable";

// Local copies of the guards and defaults. The types come from @core, but a runtime import of
// those modules would make Vite hoist them into a chunk shared with the background entry, and
// this content script loads as a classic script that cannot import one. Keep in step with
// packages/core/src/util/autofill-trigger.ts and autofill-density.ts.
function isAutofillTrigger(value: unknown): value is AutofillTrigger {
	return value === "icon" || value === "focus" || value === "shortcut";
}
function isAutofillDensity(value: unknown): value is AutofillDensity {
	return value === "compact" || value === "comfortable";
}
// The one-time "what is this mark?" hint is due. Cleared the first time it is shown, and
// `autofillHintShown` keeps an in-flight query from setting the hint due again after the ack.
let autofillHintDue = false;
let autofillHintShown = false;
// The username completion currently painted, so Enter knows what it is accepting.
let inlineSuggestion: {
	field: HTMLInputElement;
	entryId: string;
	name: string;
	/** The login's full username, so an identifier-first page can take it without a round trip. */
	username: string;
} | null = null;
// A fully typed username that exactly matches a saved login, with the Enter keycap shown. The
// entry is fixed when the confirmation is painted, so a page changing the field afterwards cannot
// steer the fill to another account.
let exactSuggestion: { field: HTMLInputElement; entryId: string; name: string } | null = null;
// Set when the user explicitly closes the popover; suppresses redisplay from
// re-queries until they re-engage (focus, type, or mousedown on a field).
let silenceAutoOpen = false;
// Field to re-surface on the next query response even if it isn't focused. Set when the vault
// unlocks while a "Vault locked" picker is open: unlocking via the toolbar/pop-out moves focus
// off the page, so focusedCandidate() is null. See issue #20.
let reshowField: HTMLInputElement | null = null;
// The field the user clicked "unlock" from. Clicking the locked row dismisses the picker, so on
// unlock there's no active host to refresh; we re-surface matches on this field instead.
let pendingUnlockField: HTMLInputElement | null = null;
let lastCheck = 0;
// Pending coalesced re-query (see scheduleQuery), and whether a DOM change went
// unqueried because the tab was hidden at the time.
let queryTimer: ReturnType<typeof setTimeout> | null = null;
let missedWhileHidden = false;
let queryGeneration = 0;
let submitGeneration = 0;

type TargetKind = "login" | "card" | "otp";
type ActiveFill = {
	target: HTMLInputElement;
	targetKind: TargetKind;
	// Whether a successful login fill should re-query behind the scenes. A pick from the menu
	// does, so the next open leads with the login just used; a rapid keyboard cycle does not,
	// because reordering the list under the cycle would make the next press repeat an entry.
	refresh: boolean;
	/** A launch claim, which nobody clicked for, so a page script moving focus doesn't cancel it. */
	launch?: boolean;
};

let activeFill: ActiveFill | null = null;
/** This tab holds a launch grant the user hasn't taken over from yet. */
let launchWatch = false;

function cancelFill(): void {
	activeFill = null;
	submitGeneration++;
}

function cancelSubmit(): void {
	submitGeneration++;
}

function cancelOperations(): void {
	queryGeneration++;
	cancelFill();
}

function documentIsActive(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

/** For a launch, which nobody clicked in this document: a frame doesn't have focus on load. */
function documentIsVisible(): boolean {
	return document.visibilityState === "visible";
}

// --- Picker placement -------------------------------------------------------
// A hosted-fields card input sits in an iframe barely taller than the input, where a
// dropdown is clipped away. Then an ancestor hosts the element and this frame keeps
// the conversation with it. See docs/autofill.md.

const frameRelay = installFrameRelay({ window, document });
// The field a relayed picker belongs to; picker.anchorField() is null in that mode.
let relayedField: HTMLInputElement | null = null;
let relayedHighlight = false;

function rectOf(field: HTMLInputElement): RelayRect {
	const r = field.getBoundingClientRect();
	return {
		x: r.left,
		y: r.top,
		width: r.width,
		height: r.height,
		rtl: getComputedStyle(field).direction === "rtl",
	};
}

// The top page never brought a relayed picker up (COEP blocks the UI there, or no content script
// runs there), so this frame stops asking it for the rest of the page's life.
let relayUnavailable = false;
const RELAY_READY_MS = 2000;
let relayReadyTimer: ReturnType<typeof setTimeout> | null = null;
// Re-draws the latest relayed render here, should the relay never come up.
let relayFallback: (() => void) | null = null;

/**
 * Where a picker for `field` is drawn. In a frame, a card picker is always hosted by the top page:
 * drawn here it is subject to whatever the embedding page does around this frame (fading or
 * filtering it costs it its clicks) and never hears a click on that page. A login picker is
 * hosted there only for a same-site frame, because the top page can read a picker it hosts off
 * its own DOM. See docs/autofill.md.
 */
function placement(field: HTMLInputElement): "relay" | "local" | "none" {
	if (frameRelay.isTop()) return "local";
	const card = kindOf(getPageFields(), field) === "card";
	if (!card && cachedResult?.sameSiteAsTop !== true) return "local";
	if (!relayUnavailable) return "relay";
	// Nowhere upstairs: draw here if there is room. A dropdown clipped to nothing helps no one.
	return frameRelay.needsRelay(rectOf(field)) ? "none" : "local";
}

/** Give the top page a moment to bring the relayed picker up; if it never does, draw it here. */
function armRelayFallback(redraw: () => void): void {
	relayFallback = redraw;
	if (relayReadyTimer !== null || relayedPickerIsLive()) return;
	relayReadyTimer = setTimeout(() => {
		relayReadyTimer = null;
		if (relayedPickerIsLive() || !relayedField) return;
		relayUnavailable = true;
		const fallback = relayFallback;
		dropRelayed();
		fallback?.();
	}, RELAY_READY_MS);
}

/** The field the visible picker belongs to, whichever renderer is showing it. */
function anchorField(): HTMLInputElement | null {
	return picker.anchorField() ?? relayedField;
}

function dropRelayed(collapse = false): void {
	relayedField = null;
	relayedHighlight = false;
	relayFallback = null;
	if (relayedPickerIsOpen()) {
		closeRelayed(collapse);
		affordance.setExpanded(false);
	}
}

/** True when a picker of either kind is on screen. */
function pickerIsOpen(): boolean {
	// An exiting menu is on its way into the mark; a mark click during that 240ms must open the
	// list again, not toggle a host the user can no longer see.
	return (!!picker.activeHost() && !picker.isExiting()) || relayedPickerIsOpen();
}

/** True while the relayed picker still has a field in this frame to belong to. */
function relayedAnchorIsLive(): boolean {
	return !!relayedField && anchorIsLive(relayedField, rectOf(relayedField));
}

/** Keep whichever picker is showing pinned to its field as the page moves. */
function repositionPicker(): void {
	picker.reposition();
	if (!relayedField) return;
	// A relayed picker has no tracker of its own: the rect is pushed from here, so a
	// field that has gone would re-park it at this frame's corner. Withdraw instead.
	// picker.ts makes the same call for the pickers it hosts.
	if (!relayedAnchorIsLive()) {
		dropRelayed();
		return;
	}
	repositionRelayed(rectOf(relayedField));
}

/** Dismiss whichever picker is showing. */
function removePicker(): void {
	affordance.setExpanded(false);
	picker.remove();
	dropRelayed();
}

/**
 * The field's skin, cached briefly.
 *
 * `dropdownSkin` reads several computed styles and may parse a modern colour through a canvas. A
 * render happens on every keystroke that changes the filtered list, so repeating that work for an
 * unchanged field is waste. A one-second window still lets a theme switch land on the next render.
 */
let skinCache: { field: HTMLInputElement; skin: DropdownSkin; at: number } | null = null;
const SKIN_TTL_MS = 1000;
function skinFor(field: HTMLInputElement): DropdownSkin {
	const now = performance.now();
	if (skinCache && skinCache.field === field && now - skinCache.at < SKIN_TTL_MS) {
		return skinCache.skin;
	}
	const skin = dropdownSkin(field);
	skinCache = { field, skin, at: now };
	return skin;
}

/** The menu shows this many matches at most; the rest are reachable by typing. A site with 1,000
 *  saved logins should not put 1,000 rows in the iframe for a menu that shows six. */
const MAX_MENU_ROWS = 50;

function showMatchesFor(
	matches: MatchSummary[],
	field: HTMLInputElement,
	opts?: {
		otpOnly?: boolean;
		suggest?: { password: string };
		alias?: AliasRowState;
		carriedId?: string;
		// A trailing "new login" row, under a login field's matches (#213).
		newLogin?: boolean;
		skin?: DropdownSkin;
	},
): void {
	if (matches.length === 0 && !opts?.suggest && !opts?.alias) return;
	const shown = matches.length > MAX_MENU_ROWS ? matches.slice(0, MAX_MENU_ROWS) : matches;
	const more = shown.length < matches.length;
	const base = opts?.skin ?? skinFor(field);
	// The compact density puts the name and username on one line; comfortable gives the title its
	// own row (and a second line when it needs one). The trigger mode only decides when the list
	// opens, not how its rows are drawn.
	const skin = autofillDensity === "compact" ? { ...base, compact: true } : base;
	// A first-paint height so a low field opens above the caret rather than flashing below. The
	// UI's real height replaces it on the resize.
	const rowHeight = skin.compact ? 54 : 56;
	const estimatedHeight = Math.min(
		380,
		shown.length * rowHeight +
			(opts?.suggest ? 60 : 0) +
			(opts?.alias ? 60 : 0) +
			(more ? 24 : 0) +
			14,
	);
	const where = placement(field);
	if (where === "none") {
		removePicker();
		return;
	}
	if (where === "local") {
		dropRelayed();
		affordance.setExpanded(true);
		picker.showMatches(shown, field, { ...opts, skin, more, estimatedHeight });
		return;
	}
	picker.remove();
	affordance.setExpanded(true);
	relayedField = field;
	showRelayed(rectOf(field), {
		kind: "matches",
		matches: shown,
		otpOnly: opts?.otpOnly === true,
		suggest: opts?.suggest,
		alias: opts?.alias,
		carriedId: opts?.carriedId,
		skin,
		more,
		newLogin: opts?.newLogin === true,
	});
	armRelayFallback(() => showMatchesFor(matches, field, opts));
}

/**
 * Card rows with the tab's last-filled card first and named as such.
 *
 * On a hosted-fields checkout each box is its own frame filling only its own inputs, so the
 * expiry and CVV frames ask again from scratch. Leading with the card already used on this page
 * makes the obvious pick the consistent one. Deliberately only order and a badge: taking the
 * keyboard highlight too would turn Enter into a fill on a form where Enter submits.
 */
function cardRows(result: QueryResult): {
	matches: MatchSummary[];
	opts?: { carriedId: string };
} {
	const carriedId = result.carriedCardId;
	if (!carriedId) return { matches: result.cards };
	const carried = result.cards.find((c) => c.id === carriedId);
	if (!carried) return { matches: result.cards };
	return {
		matches: [carried, ...result.cards.filter((c) => c !== carried)],
		opts: { carriedId },
	};
}

/** Arrow/Enter/Escape for a relayed picker; the field is here, the rows are upstairs. */
function handleRelayedKey(e: KeyboardEvent): boolean {
	if (!relayedPickerIsOpen() || deepActiveElement() !== relayedField) return false;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		keyToRelayed(e.key);
		return true;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		silenceAutoOpen = true;
		dropRelayed();
		return true;
	}
	// Ctrl/Cmd+Enter opens the highlighted row's details, the same secondary action the local
	// picker offers. It must not fall through to the plain Enter fill below.
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && relayedHighlight) {
		e.preventDefault();
		keyToRelayed("Enter", true);
		return true;
	}
	// Enter only picks when a row is highlighted; otherwise the form submits normally.
	if (e.key === "Enter" && relayedHighlight) {
		e.preventDefault();
		keyToRelayed("Enter");
		return true;
	}
	return false;
}

function showLockedFor(field: HTMLInputElement): void {
	const skin = skinFor(field);
	affordance.clearPreview();
	const where = placement(field);
	if (where === "none") {
		removePicker();
		return;
	}
	if (where === "local") {
		dropRelayed();
		affordance.setExpanded(true);
		picker.showLocked(field, skin, 76);
		return;
	}
	picker.remove();
	relayedField = field;
	affordance.setExpanded(true);
	showRelayed(rectOf(field), { kind: "locked", skin });
	armRelayFallback(() => showLockedFor(field));
}

function currentTargetKind(target: HTMLInputElement): TargetKind | null {
	invalidatePageFields();
	if (
		!target.isConnected ||
		target.ownerDocument !== document ||
		target.disabled ||
		target.readOnly
	) {
		return null;
	}
	return kindOf(getPageFields(), target);
}

function isPickerInteractionTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Node)) return false;
	const host = picker.activeHost();
	return !!host && (host.contains(target) || picker.clickIsOnAnchor(target));
}

function responsePayload(v: unknown): {
	payload: FillPayload;
	isAuto: boolean;
	otpOnly: boolean;
	sessionGeneration: number;
} | null {
	if (!v || typeof v !== "object") return null;
	const data = v as Record<string, unknown>;
	if (data.isAuto !== true && data.isAuto !== false) return null;
	if (data.otpOnly !== true && data.otpOnly !== false) return null;
	if (!Number.isSafeInteger(data.sessionGeneration) || (data.sessionGeneration as number) < 0)
		return null;
	const payload = data.payload as FillPayload | undefined;
	if (!validFillPayload(payload)) return null;
	return {
		payload,
		isAuto: data.isAuto,
		otpOnly: data.otpOnly,
		sessionGeneration: data.sessionGeneration as number,
	};
}

function validCustomFields(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(field) =>
					field &&
					typeof field === "object" &&
					typeof (field as { key?: unknown }).key === "string" &&
					typeof (field as { value?: unknown }).value === "string",
			))
	);
}

function validFillPayload(payload: FillPayload | undefined): payload is FillPayload {
	if (!payload || typeof payload !== "object" || !validCustomFields(payload.customFields))
		return false;
	if (payload.kind === "login") {
		return (
			typeof payload.username === "string" &&
			typeof payload.password === "string" &&
			(payload.totp === undefined || typeof payload.totp === "string") &&
			(payload.autoSubmit === undefined || typeof payload.autoSubmit === "boolean")
		);
	}
	return (
		payload.kind === "card" &&
		typeof payload.cardholderName === "string" &&
		typeof payload.number === "string" &&
		typeof payload.expMonth === "string" &&
		typeof payload.expYear === "string" &&
		typeof payload.cvv === "string"
	);
}

function payloadMatchesTarget(
	targetKind: TargetKind,
	payload: FillPayload,
	otpOnly: boolean,
): boolean {
	if (targetKind === "card") return payload.kind === "card" && !otpOnly;
	if (targetKind === "otp") return payload.kind === "login" && otpOnly;
	return payload.kind === "login" && !otpOnly;
}

function delayedSubmitIsEligible(
	passwordField: HTMLInputElement,
	generation: number,
	pageIsLive: () => boolean = documentIsActive,
): boolean {
	invalidatePageFields();
	return (
		generation === submitGeneration &&
		pageIsLive() &&
		passwordField.isConnected &&
		passwordField.ownerDocument === document &&
		!passwordField.disabled &&
		!passwordField.readOnly &&
		getPageFields().login.password === passwordField &&
		!hasInteractiveCaptcha()
	);
}

async function continueAutoSubmit(
	passwordField: HTMLInputElement,
	generation: number,
	sessionGeneration: number,
	pageIsLive: () => boolean = documentIsActive,
): Promise<void> {
	if (!delayedSubmitIsEligible(passwordField, generation, pageIsLive)) return;
	const response = await safeRequest<AutofillSubmitRevalidationResponse>({
		type: "AUTOFILL_REVALIDATE_SUBMIT",
		sessionGeneration,
	});
	if (
		!response?.ok ||
		response.data.sessionGeneration !== sessionGeneration ||
		!delayedSubmitIsEligible(passwordField, generation, pageIsLive)
	) {
		return;
	}
	submitFromField(passwordField);
}

function applySelectResponse(
	intent: ActiveFill,
	response: AutofillSelectResponse | undefined,
	pageIsLive: () => boolean = documentIsActive,
): boolean {
	// Consume before validating or filling: a response can never be replayed locally.
	if (activeFill !== intent) return false;
	activeFill = null;
	if (!response?.ok) return false;
	const data = responsePayload(response.data);
	if (!data || !pageIsLive() || currentTargetKind(intent.target) !== intent.targetKind)
		return false;
	if (!payloadMatchesTarget(intent.targetKind, data.payload, data.otpOnly)) return false;

	picker.removeDropdown();
	if (data.payload.kind === "card") {
		fillCard(data.payload, data.isAuto);
		fillCustomFields(data.payload.customFields, data.isAuto);
		return true;
	}
	if (data.otpOnly) {
		fillOtp(data.payload.totp);
		return true;
	}
	const { filled, passwordField } = fillForm(
		data.payload.username,
		data.payload.password,
		data.isAuto,
		intent.target,
	);
	fillCustomFields(data.payload.customFields, data.isAuto);
	fillOtp(data.payload.totp);
	// The pick ends the typed-filter session. The field now holds the chosen username, so a second
	// mark click should offer every login for the site, not just the one just filled.
	const usernameField = getPageFields().login.username;
	if (usernameField) {
		typedUsernameQuery.delete(usernameField);
		updateAffordance(usernameField);
	}
	// Refresh the cache so the site's "last used" carry reaches the next menu open. `silenceAutoOpen`
	// is set by the pick, so the result updates the cache without reopening the panel.
	if (intent.refresh) queryAutofill();
	if (!filled || !data.payload.autoSubmit || !passwordField) return true;
	const generation = ++submitGeneration;
	setTimeout(() => {
		void continueAutoSubmit(passwordField, generation, data.sessionGeneration, pageIsLive);
	}, 50);
	return true;
}

/**
 * What was decided when the suggestion was first offered: the password, and whether
 * accepting it creates a login or rotates one.
 *
 * `newLogin` is settled HERE rather than at pick time because the picker rewrites the
 * anchor field's `autocomplete` to "off" to suppress the native dropdown, erasing the
 * `new-password` token that classifies the form. Re-reading the field after that scores
 * a signup as an ordinary page and turns its save into an update.
 */
interface Suggestion {
	password: string;
	newLogin: boolean;
}

// The suggestion offered on a given field, cached so re-renders don't churn a new
// one each frame. Regenerate replaces the password; the WeakMap forgets fields that
// leave the DOM.
const suggestionFor = new WeakMap<HTMLInputElement, Suggestion>();

// The alias row's state per field. Unlike the password suggestion this is not a decision cached
// once, it is where a round trip currently stands, and it is per field so leaving a form mid
// request does not paint the spinner onto the next one.
const aliasStateFor = new WeakMap<HTMLInputElement, AliasRowState>();

// Whether a field sits on a form that creates an account, decided once per field. Cached
// for the reason Suggestion is: by the time the picker has anchored, the form no longer
// describes itself. It also keeps the scoring off the per-keystroke path.
const creationFormFor = new WeakMap<HTMLInputElement, boolean>();

// Whether the generator would offer into this password field, decided once per field. The mark
// asks on every pointer move and keystroke; re-scoring the form each time would put the signup
// detector back on the per-keystroke path that issue #59 removed.
const suggestibleFor = new WeakMap<HTMLInputElement, boolean>();

/** The suggestion verdict without generating anything. `field.value` is checked live: a field the
 *  user has filled is never a suggestion target, whatever the form said when it was empty. */
function maySuggestPassword(field: HTMLInputElement, hasExistingLogins: boolean): boolean {
	if (field.type !== "password" || field.value) return false;
	const cached = suggestibleFor.get(field);
	if (cached !== undefined) return cached;
	const verdict = shouldSuggestPassword(field, { hasExistingLogins });
	suggestibleFor.set(field, verdict);
	return verdict;
}

/**
 * True while `field` belongs to a form that is making a credential rather than filling one.
 * Nothing the picker offers applies there: the user is choosing an email to sign up with,
 * and a saved login is clutter - while the "Vault locked" row is worse, since it asks for a
 * window and a master password to fill a form that fills nothing. The password box is the
 * exception and is handled before this, by the generated-password suggestion.
 */
function isCreationField(field: HTMLInputElement): boolean {
	const cached = creationFormFor.get(field);
	if (cached !== undefined) return cached;
	const verdict = isOnAccountCreationForm(field);
	creationFormFor.set(field, verdict);
	return verdict;
}

/**
 * A generated-password suggestion for `field`, or null when this isn't a
 * password-setting flow. Decides once per field and caches it.
 */
function maybeSuggest(field: HTMLInputElement, hasExistingLogins: boolean): Suggestion | null {
	if (!maySuggestPassword(field, hasExistingLogins)) return null;
	const cached = suggestionFor.get(field);
	if (cached) return cached;
	// Read the form while it still describes itself; see Suggestion.
	const suggestion = {
		password: takeGeneratedPassword(),
		newLogin: isAccountCreationForm(field),
	};
	suggestionFor.set(field, suggestion);
	// The same question creationFormFor asks, answered at the one moment it can be.
	creationFormFor.set(field, suggestion.newLogin);
	return suggestion;
}

/**
 * Swaps in a fresh password for `field`, keeping the save-vs-update decision the
 * first offer made: by now the picker has rewritten the anchor's autocomplete, so
 * re-classifying would read a form that no longer describes itself.
 *
 * Asks the background rather than spending the held password: an explicit click can afford the
 * round trip, and it means repeated clicks all follow the user's settings instead of the first
 * one draining the supply and the rest falling back.
 */
async function regenerateInto(field: HTMLInputElement): Promise<string> {
	const password = await requestGeneratedPassword();
	suggestionFor.set(field, { password, newLogin: suggestionFor.get(field)?.newLogin ?? false });
	return password;
}

/**
 * Case-insensitive, either-direction prefix match against the saved username: covers both
 * a query typed further than the stored value (`alice` -> `alice@example.com`) and a stored
 * value longer than what's typed so far. Entry name is not matched: the user is typing a
 * username into a username box, not addressing an entry by its label.
 */
const lowerSecondary = new WeakMap<MatchSummary, string>();

function filterLoginsByQuery(logins: MatchSummary[], query: string): MatchSummary[] {
	const q = query.trim().toLowerCase();
	if (!q) return logins;
	return logins.filter((m) => {
		let secondary = lowerSecondary.get(m);
		if (secondary === undefined) {
			secondary = m.secondary.toLowerCase();
			lowerSecondary.set(m, secondary);
		}
		return secondary.startsWith(q) || q.startsWith(secondary);
	});
}

// The query to filter by: the last value the user actually typed into the username field via
// a real "input" event, not whatever value the field merely holds. A page that pre-fills a
// remembered email (or an autofocus default) must not silently hide every saved login before
// the user has typed anything themselves; only a genuine keystroke should narrow the list.
const typedUsernameQuery = new WeakMap<HTMLInputElement, string>();

// One keystroke asks for the visible list three times (the mark's count, the completion, the
// menu). The answer depends only on the field, the typed query and the cached result, so keep the
// last one. A query change or a new result invalidates it by identity.
let visibleCache: {
	field: HTMLInputElement;
	query: string;
	logins: MatchSummary[];
	out: MatchSummary[];
} | null = null;

/** Logins to offer on `field`: all matches, or filtered by what the user has actually typed. */
function visibleLoginsForField(field: HTMLInputElement, logins: MatchSummary[]): MatchSummary[] {
	if (field !== getPageFields().login.username) return logins;
	const query = typedUsernameQuery.get(field);
	if (!query) return logins;
	if (
		visibleCache &&
		visibleCache.field === field &&
		visibleCache.query === query &&
		visibleCache.logins === logins
	) {
		return visibleCache.out;
	}
	const out = filterLoginsByQuery(logins, query);
	visibleCache = { field, query, logins, out };
	return out;
}

/**
 * The list as the user should see it: the site's last-used login leads, marked "Used here".
 *
 * The carry is an id the query response already contains; this only reorders and labels a row.
 * It is applied after the typed filter, so a carry the query no longer matches disappears with
 * the rest instead of being pinned into a filtered list.
 */
function loginRows(
	field: HTMLInputElement,
	logins: MatchSummary[],
): { matches: MatchSummary[]; carriedId?: string } {
	const visible = visibleLoginsForField(field, logins);
	const carriedId = cachedResult?.carriedLoginId;
	if (!carriedId) return { matches: visible };
	const carried = visible.find((m) => m.id === carriedId);
	if (!carried) return { matches: visible };
	return {
		matches: [carried, ...visible.filter((m) => m.id !== carriedId)],
		carriedId,
	};
}

/** Shows the login picker for `field`: existing matches, or ONLY the strong-password row on a signup/rotation form. */
function showLoginPicker(field: HTMLInputElement, logins: MatchSummary[]): void {
	const suggest = maybeSuggest(field, logins.length > 0);
	// On an account-creation / password-rotation form, offer only the suggestion. Existing logins
	// aren't useful when making or rotating a credential and would clutter the prompt.
	if (suggest) {
		showMatchesFor([], field, { suggest: { password: suggest.password } });
		return;
	}
	// The signup form's email box: an alias is the one thing that belongs here. Offered only when
	// the background says a provider is configured, so a page cannot conjure the row, and kept on
	// screen while a request is in flight or has failed so the state has somewhere to live.
	const alias = aliasStateFor.get(field);
	if (alias || (cachedResult?.aliasReady && shouldSuggestAlias(field))) {
		showMatchesFor([], field, { alias: alias ?? { state: "idle" } });
		return;
	}
	// Otherwise the same policy as before: the rest of an account-creation form gets nothing.
	if (isCreationField(field)) return;
	const rows = loginRows(field, logins);
	if (rows.matches.length === 0) {
		// Full dismissal, not picker.removeDropdown(): that only tears down the shadow-DOM
		// (COEP-fallback) renderer and is a no-op against the primary iframe renderer, and it
		// leaves any relayed (cross-origin iframe) picker painted too.
		removePicker();
		return;
	}
	showMatchesFor(rows.matches, field, {
		...(rows.carriedId ? { carriedId: rows.carriedId } : {}),
		// Under the site's logins, a way to save another one (#213), where accounts are chosen.
		...(field === getPageFields().login.username ? { newLogin: true } : {}),
	});
}

/**
 * What to show on `field` while the vault is locked. Generating a strong password needs no vault,
 * so a signup field still gets the suggestion (picking it fills and offers an "Unlock & Save"
 * corner prompt), and the rest of an account-creation form gets nothing at all. Anything else
 * falls back to the "Vault locked" unlock row.
 */
function showLockedPicker(field: HTMLInputElement, hasPotentialMatch: boolean): void {
	const suggest = maybeSuggest(field, hasPotentialMatch);
	if (suggest) {
		showMatchesFor([], field, { suggest: { password: suggest.password } });
		return;
	}
	// A signup form's email field, where an alias could be made if the vault were open. The rest
	// of a creation form still gets nothing, but this field now has something behind the lock, so
	// suppressing the unlock row would leave the user no way to reach it from here. Unlocking is
	// what saving the new login is about to ask for anyway.
	if (cachedResult?.aliasReady && shouldSuggestAlias(field)) {
		showLockedFor(field);
		return;
	}
	if (!isCreationField(field)) showLockedFor(field);
}

/** Fills the suggested password into the new-password field(s) and offers to save the login. */
function applyGeneratedPassword(field: HTMLInputElement): void {
	const suggestion = suggestionFor.get(field);
	if (!suggestion) return;
	const { password, newLogin } = suggestion;
	if (!fillPasswordFields(signupPasswordFields(field), password)) return;
	// Grab whatever username/email the user already typed; the password is ours.
	const username = getPageFields().login.username?.value ?? "";
	// A signup creates a NEW login; setting a password (reset, rotation, change form) rotates
	// the existing one. Tell the background so a login already saved for this site doesn't turn
	// a signup into an "update" -- and, just as importantly, so a reset doesn't duplicate it.
	safeSendMessage({ type: "CORNER_PROMPT_CAPTURE", payload: { username, password, newLogin } });
}

/**
 * Dismisses the dropdown and asks the background to fetch and fill the chosen entry.
 *
 * `into` overrides the target for a selection that did not come from the picker: the desktop
 * panel picks an entry with no dropdown open, and anchorField() is by definition the field a
 * VISIBLE picker belongs to, so it is null there and the fill silently did nothing.
 */
function selectMatch(
	entryId: string,
	isAuto: boolean,
	otpOnly = false,
	into: HTMLInputElement | null = anchorField(),
	pageIsLive: () => boolean = documentIsActive,
	opts?: { refresh?: boolean },
): Promise<boolean> {
	const target = into;
	const targetKind = target ? currentTargetKind(target) : null;
	if (!target || !targetKind) return Promise.resolve(false);
	// Manual selection counts as an explicit dismissal; silence auto-redisplay
	// (e.g. a re-query landing mid-fill) until the user re-engages a field.
	if (!isAuto) silenceAutoOpen = true;
	// Capture the actual anchor and its kind before removal. Never re-find by selector
	// when the response arrives: an identical replacement is a different target.
	const intent: ActiveFill = {
		target,
		targetKind,
		refresh: opts?.refresh !== false,
	};
	cancelFill();
	activeFill = intent;
	// The menu collapses back into the in-field mark while the fill request runs; without a mark
	// (shortcut mode, focus mode's hidden mark, a relayed picker) it closes instantly.
	picker.dismissTo(affordance.markRect());
	dropRelayed(true);
	// The field is about to be filled; an inline completion from before the pick must not survive
	// to overwrite it on the next Enter.
	clearInlineSuggestion();
	return safeRequest<AutofillSelectResponse>({
		type: "AUTOFILL_SELECT",
		payload: { entryId, isAuto, otpOnly },
	}).then((response) => applySelectResponse(intent, response, pageIsLive));
}

/** The entry the shortcut filled last, so repeated presses advance instead of restarting. */
let cycleState: {
	field: HTMLInputElement;
	key: string;
	index: number;
	at: number;
} | null = null;
// A fill is a round trip; a second press before it lands would skip an entry the user never saw.
let cyclePending = false;
const CYCLE_RESET_MS = 6000;

/** The entries the shortcut would cycle for `field`, in the order the panel would show them. */
function cycleEntries(
	field: HTMLInputElement,
): { matches: MatchSummary[]; otpOnly: boolean } | null {
	if (!cachedResult) return null;
	const kind = kindOf(getPageFields(), field);
	if (kind === "card") {
		const cards = cardRows(cachedResult);
		return cards.matches.length > 0 ? { matches: cards.matches, otpOnly: false } : null;
	}
	if (kind === "otp") {
		const otps = entriesForKind(cachedResult, "otp");
		return otps.length > 0 ? { matches: otps, otpOnly: true } : null;
	}
	const rows = loginRows(field, cachedResult.logins);
	return rows.matches.length > 0 ? { matches: rows.matches, otpOnly: false } : null;
}

/**
 * Fill the next (or previous) entry for the field the user is in, driven by the browser command.
 *
 * A command is a genuine user gesture - the page cannot synthesize one - so this fills directly
 * rather than opening a panel. The background still re-checks that a login matches the verified
 * page origin before returning any secret, exactly as it does for a click.
 *
 * Only the focused field is served. A frame with no focused candidate does nothing, which is what
 * keeps the message (sent to every frame in the tab) from filling a form nobody is looking at.
 */
function cycleAutofill(back: boolean): void {
	if (autofillDisabled || cyclePending) return;
	if (document.visibilityState !== "visible" || !document.hasFocus()) return;
	const field = focusedCandidate() ?? (pickerIsOpen() ? anchorField() : null);
	if (!field) return;
	if (cachedResult?.locked) {
		showLockedPicker(field, cachedResult.hasPotentialMatch);
		return;
	}
	if (!cachedResult) {
		queryAutofill();
		return;
	}
	const list = cycleEntries(field);
	if (!list) return;
	const kind = kindOf(getPageFields(), field);
	if (!kind) return;
	const key = list.matches.map((m) => m.id).join("\0");
	const total = list.matches.length;
	const now = Date.now();
	const same =
		cycleState !== null &&
		cycleState.field === field &&
		cycleState.key === key &&
		now - cycleState.at < CYCLE_RESET_MS;
	// A new cycle starts before the first entry (forward) or after the last (back), so one
	// press lands on the expected end without special-casing the wrap below.
	const base = same ? cycleState!.index : back ? 0 : -1;
	const index = (base + (back ? -1 : 1) + total) % total;
	const entry = list.matches[index];
	if (!entry) return;
	cyclePending = true;
	void selectMatch(entry.id, false, list.otpOnly, field, undefined, { refresh: false }).then(
		(filled) => {
			cyclePending = false;
			if (!filled) return;
			cycleState = { field, key, index, at: Date.now() };
			affordance.flash(field, entry.name, `${index + 1}/${total}`, { quick: true });
		},
	);
}

/**
 * Open the full Bramble window on `entryId`, for fields the picker does not fill.
 *
 * The row action is a navigation, not a credential release: it sends only the opaque entry id and
 * a route, and the pop-out's own guards decide whether the entry can be shown. Nothing is returned
 * to the page.
 */
function openEntryDetails(entryId: string): void {
	if (!entryId) return;
	cancelOperations();
	silenceAutoOpen = true;
	picker.remove();
	dropRelayed();
	safeSendMessage({
		type: "POPOUT_OPEN",
		payload: {
			reason: "entry",
			handoff: { path: `/vault/${encodeURIComponent(entryId)}` },
		},
	});
}

/** The "new login" row: Bramble's create form in a pop-out, for this site (#213). */
function openNewLogin(): void {
	cancelOperations();
	silenceAutoOpen = true;
	picker.remove();
	safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "new-login" } });
}

/** The password field a launch may fill: rendered, empty, and not on a form setting a password. */
function launchField(): HTMLInputElement | null {
	invalidatePageFields();
	const field = getPageFields().login.password;
	if (!field || field.value || field.disabled || field.readOnly || !isRendered(field)) return null;
	// A change form's first box is the current password, which alone reads as a login.
	if (signupPasswordFields(field).some((other) => other !== field)) return null;
	return shouldSuggestPassword(field, { hasExistingLogins: true }) ? null : field;
}

/** Stop a live grant from filling anything after the user has moved on. */
function endLaunch(): void {
	if (!launchWatch) return;
	launchWatch = false;
	if (cachedResult) cachedResult.launch = false;
	safeSendMessage({ type: "AUTOFILL_LAUNCH_END" });
}

/** A page with no fields never queries, so the top frame asks once whether to watch. */
function watchForLaunch(): void {
	if (window !== window.top) return;
	void safeRequest<{ ok: boolean; data?: { live?: boolean } }>({
		type: "AUTOFILL_LAUNCH_LIVE",
	}).then((response) => {
		if (response?.ok && response.data?.live) launchWatch = true;
	});
}

/** Spend this tab's launch grant if this page qualifies. True while a claim is out. */
function claimLaunch(): boolean {
	if (activeFill?.launch) return true;
	if (!cachedResult?.launch || activeFill || !documentIsVisible()) return false;
	const inFrame = window !== window.top;
	// The top frame can only vouch for its own children.
	if (inFrame && window.parent !== window.top) return false;
	const target = launchField();
	const targetKind = target ? currentTargetKind(target) : null;
	if (!target || targetKind !== "login") return false;
	const intent: ActiveFill = { target, targetKind, launch: true, refresh: false };
	activeFill = intent;
	removePicker();
	const size = inFrame
		? { frameWidth: window.innerWidth, frameHeight: window.innerHeight }
		: undefined;
	void safeRequest<AutofillSelectResponse>({ type: "AUTOFILL_LAUNCH_CLAIM", payload: size }).then(
		(response) => {
			const filled = applySelectResponse(intent, response, documentIsVisible);
			if (response?.ok) {
				launchWatch = false;
				if (cachedResult) cachedResult.launch = false;
			}
			if (filled) {
				silenceAutoOpen = true;
				return;
			}
			const field = focusedCandidate();
			if (field) showFor(field);
		},
	);
	return true;
}

/** The top frame's half of a frame's claim. See docs/launch-and-fill.md. */
function launchTopCheck(size: { frameWidth: number; frameHeight: number }): {
	hasPassword: boolean;
	frameVisible: boolean;
} {
	invalidatePageFields();
	const password = getPageFields().login.password;
	return {
		hasPassword: !!password && isRendered(password),
		frameVisible: Array.from(document.querySelectorAll("iframe")).some(
			(frame) =>
				Math.abs(frame.clientWidth - size.frameWidth) <= 2 &&
				Math.abs(frame.clientHeight - size.frameHeight) <= 2 &&
				hostIsTrustworthy(frame),
		),
	};
}

function focusedCandidate(): HTMLInputElement | null {
	const focused = deepActiveElement();
	return focused instanceof HTMLInputElement && isCandidate(getPageFields(), focused)
		? focused
		: null;
}

/**
 * The login the fill shortcut takes: the first whose username starts with what is in the username
 * field, else whose name does, else the site's first. Typing "ab" then pressing it fills that one.
 */
function shortcutPick(logins: MatchSummary[], typed: string): MatchSummary | undefined {
	const prefix = typed.trim().toLowerCase();
	const starts = (text: string) => text.toLowerCase().startsWith(prefix);
	if (prefix) {
		const match = logins.find((l) => starts(l.secondary)) ?? logins.find((l) => starts(l.name));
		if (match) return match;
	}
	return logins[0];
}

/** The login field a fill goes into: the focused one, else the form's username, else its password. */
function loginTarget(): HTMLInputElement | undefined {
	invalidatePageFields();
	const fields = getPageFields().login;
	return [focusedCandidate(), fields.username, fields.password].find(
		(field): field is HTMLInputElement =>
			!!field && isRendered(field) && currentTargetKind(field) === "login",
	);
}

/** This page's logins, or the ones with a 2FA key, asked fresh: with "Autofill on web pages" off
 * this frame holds nothing, and the background answers only inside a one-fill grant. */
async function freshMatches(otp: boolean): Promise<MatchSummary[] | null> {
	const response = await safeRequest<AutofillQueryResponse>({
		type: "AUTOFILL_QUERY",
		hasLogin: !otp,
		hasCard: false,
		hasOtp: otp,
	});
	if (!response?.ok || !isQueryResult(response.data)) return null;
	const { logins, otps, locked, disabled } = response.data;
	if (locked || disabled) return null;
	return otp ? (otps ?? []) : logins;
}

/**
 * The fill shortcut (#215): fill this page's login, the one `shortcutPick` chooses, or on a 2FA
 * field the code of the site's first login that has one. Every frame of the tab gets it; only the
 * one holding focus answers. The background answers its query only because the shortcut was just
 * pressed in this tab (fill-shortcut.ts).
 */
async function fillFromShortcut(): Promise<void> {
	if (!document.hasFocus() || deepActiveElement() instanceof HTMLIFrameElement) return;
	invalidatePageFields();
	const focused = focusedCandidate();
	if (focused && currentTargetKind(focused) === "otp") {
		const [first] = (await freshMatches(true)) ?? [];
		if (first) fillAndReport(focused, first.id, first.name, { otpOnly: true });
		return;
	}
	const into = loginTarget();
	if (!into) return;
	const logins = await freshMatches(false);
	const pick = logins && shortcutPick(logins, getPageFields().login.username?.value ?? "");
	if (pick) fillAndReport(into, pick.id, pick.name);
}

/** What the in-field mark would offer here: the one-time hint and the number of entries behind it. */
type FieldOffer = { hint: string; count: number };

/**
 * The same conditions the panel uses, reduced to "is there anything behind this field?".
 *
 * The mark has to appear for every case the panel can serve - matches, cards, one-time codes, a
 * generated password, an alias, the locked unlock row - or a quiet mode would hide a feature the
 * user configured. It must also not appear where the panel would refuse to draw: a signup form's
 * email box with no alias provider is the main one.
 *
 * Locked and unlocked differ only in what "has a login" means: locked, the page only knows
 * `hasPotentialMatch`; unlocked, the hint is drawn only for a login the field can actually offer.
 * The count is the entries this field would list; a suggestion or an alias is not an entry, and a
 * locked vault does not know how many there are.
 */
function offerFor(field: HTMLInputElement): FieldOffer | null {
	if (!cachedResult) return null;
	const locked = cachedResult.locked;
	if (!locked) {
		const kind = kindOf(getPageFields(), field);
		if (kind === "card") {
			const n = cachedResult.cards.length;
			return n > 0 ? { hint: t("hintCards"), count: n } : null;
		}
		if (kind === "otp") {
			const n = (cachedResult.otps ?? []).length;
			return n > 0 ? { hint: t("hintOtp"), count: n } : null;
		}
	}
	const anyLogins = locked ? cachedResult.hasPotentialMatch : cachedResult.logins.length > 0;
	const suggestion = maySuggestPassword(field, anyLogins);
	if (suggestion) return { hint: t("hintGeneratedPassword"), count: 0 };
	const alias = cachedResult.aliasReady === true && shouldSuggestAlias(field);
	if (isCreationField(field) && !alias) return null;
	if (locked) return anyLogins || alias ? { hint: t("hintLocked"), count: 0 } : null;
	const visible = visibleLoginsForField(field, cachedResult.logins);
	if (visible.length > 0) return { hint: t("hintLogins"), count: visible.length };
	return alias ? { hint: t("hintAlias"), count: 0 } : null;
}

/** Show or hide the mark for `field` according to the mode and what it can offer. */
function updateAffordance(field: HTMLInputElement): void {
	if (autofillDisabled || autofillTrigger === "shortcut") {
		affordance.hide();
		return;
	}
	if (isFilling() || !isKnownCandidate(field)) return;
	const offer = offerFor(field);
	if (!offer) {
		affordance.hide();
		return;
	}
	// The hint is a one-time introduction to a quiet affordance, so it belongs in the mode where
	// the mark is the only thing on screen. In focus mode the panel already announced itself.
	const hint = autofillHintDue && autofillTrigger === "icon" ? offer.hint : undefined;
	affordance.show(field, { hint, count: offer.count });
	// The mark is the entry point; warm the iframe now so its first click does not wait on a cold
	// UI load (the `probe` state). A field whose picker will be relayed has no local iframe to
	// warm, and creating one here would race the relay.
	if (placement(field) === "local") picker.preload();
}

/** A password field the user can actually see: rendered and inside the viewport. The Enter fill
 *  releases a secret into it, so an off-screen field is not enough. */
function passwordFieldVisible(password: HTMLInputElement | null): password is HTMLInputElement {
	if (!password || !isRendered(password)) return false;
	const rect = password.getBoundingClientRect();
	return (
		rect.bottom > 0 &&
		rect.right > 0 &&
		rect.top < window.innerHeight &&
		rect.left < window.innerWidth
	);
}

/**
 * Paint the best match's username as ghost text after what the user has typed. A completion needs
 * a real keystroke: an empty or page-prefilled field gets none, so Enter stays the form's submit.
 * A fully typed saved username gets the Enter keycap without a ghost.
 *
 * Username field only, never a password: a completion there would reveal a password's length and
 * characters. The preview, and the mirror that measures it, live in the affordance's closed shadow
 * root, so the page cannot read the account it is suggesting.
 */
function updateInlinePreview(field: HTMLInputElement | null): void {
	if (
		autofillDisabled ||
		autofillTrigger !== "icon" ||
		!field ||
		!cachedResult ||
		cachedResult.locked
	) {
		clearInlineSuggestion();
		return;
	}
	const username = getPageFields().login.username;
	if (field !== username || isCreationField(field) || deepActiveElement() !== field) {
		clearInlineSuggestion();
		return;
	}
	// A completion needs at least one character the user actually typed: a page that focuses its
	// own field on load must not get an Enter-to-fill affordance it can put under a stray keypress.
	if (!typedUsernameQuery.get(field)) {
		clearInlineSuggestion();
		return;
	}
	// Only at the end of what was typed: a completion in the middle of a value would move the
	// caret and overwrite text the user meant to edit.
	if (field.selectionStart !== null && field.selectionStart !== field.value.length) {
		clearInlineSuggestion();
		return;
	}
	const typed = field.value;
	const rows = loginRows(field, cachedResult.logins).matches;
	const best = rows.find(
		(m) =>
			m.secondary.length > typed.length &&
			m.secondary.toLowerCase().startsWith(typed.toLowerCase()),
	);
	if (!best) {
		// No prefix completion. A fully typed saved username gets the Enter keycap (no ghost) so the
		// password fill is never a surprise; the password field must be on-screen, and the entry is
		// fixed here from the value the user typed.
		const fields = getPageFields().login;
		const exact = typed.trim()
			? rows.find((m) => m.secondary.trim().toLowerCase() === typed.trim().toLowerCase())
			: undefined;
		if (
			exact &&
			passwordFieldVisible(fields.password) &&
			!fields.password.value &&
			affordance.previewExact(field)
		) {
			inlineSuggestion = null;
			exactSuggestion = { field, entryId: exact.id, name: exact.name };
			return;
		}
		clearInlineSuggestion();
		return;
	}
	// Only remember a suggestion the ghost actually painted. A field that is RTL, too narrow for
	// the remainder, or whose mark is hidden must not accept Enter for something never shown.
	if (!affordance.preview(field, best.secondary.slice(typed.length))) {
		clearInlineSuggestion();
		return;
	}
	inlineSuggestion = { field, entryId: best.id, name: best.name, username: best.secondary };
	exactSuggestion = null;
}

function clearInlineSuggestion(): void {
	inlineSuggestion = null;
	exactSuggestion = null;
	affordance.clearPreview();
}

/**
 * Fill `entryId` into `field` and show the entry name as the mark's extension. A refused fill
 * (locked, origin no longer authorized) must not leave the keypress looking like it did nothing.
 */
function fillAndReport(
	field: HTMLInputElement,
	entryId: string,
	name: string,
	opts?: { otpOnly?: boolean },
): void {
	void selectMatch(entryId, false, opts?.otpOnly === true, field).then((filled) => {
		if (filled) affordance.flash(field, name);
		else if (field.isConnected) affordance.flash(field, t("hudFillRefused"));
	});
}

/** The name of the entry a picker row named. The id came from the same query response. */
function entryName(id: string): string | undefined {
	if (!cachedResult) return undefined;
	const all = [...cachedResult.logins, ...cachedResult.cards, ...(cachedResult.otps ?? [])];
	return all.find((match) => match.id === id)?.name;
}

/**
 * Accept the completion with Enter.
 *
 * The completion is a selection of a Bramble credential, so it fills the whole login through the
 * same authorized path as a click, not just the username. (Filling the username alone read as a
 * half-done pick: the user had chosen the entry and still had to fetch the password.)
 *
 * A completion is only offered after the user has typed at least one character, so a page that
 * focuses its own field on load cannot turn a stray Enter into a fill. A page-prefilled value (or a
 * browser autofill) must not turn the submit key into a Bramble fill either. Tab is deliberately
 * not involved; it keeps its native focus move.
 */
function acceptInlineSuggestion(): boolean {
	if (autofillTrigger !== "icon" || !inlineSuggestion) return false;
	const { field, entryId, name, username } = inlineSuggestion;
	if (deepActiveElement() !== field || !field.isConnected) return false;
	// The ghost completes the user's own text; it is never an empty-field fill.
	if (!typedUsernameQuery.get(field)) return false;
	// The mark is the visible confirmation; a page that hid, faded or covered it must not turn a
	// stray Enter into a credential fill.
	if (!affordance.markTrustworthy()) {
		clearInlineSuggestion();
		return false;
	}
	// Identifier-first pages (Google, Yahoo) have no visible password on this step. Fill the
	// username and let Enter submit so the page can advance; the next step's mark fills the
	// password. A whole-login round trip here races the page's navigation and comes back refused.
	const password = getPageFields().login.password;
	if (!password || !isRendered(password)) {
		fillTextField(field, username);
		clearInlineSuggestion();
		return false;
	}
	clearInlineSuggestion();
	fillAndReport(field, entryId, name);
	return true;
}

/**
 * Enter with a full username typed and the menu closed.
 *
 * The ghost only appears while the typed text is a strict prefix, so a fully typed username has no
 * completion to accept. It still shows the Enter keycap when the value exactly matches a saved
 * login; pressing Enter fills that login's password when the password field is visible and empty.
 * The entry is fixed when the keycap is painted, and the field must still hold the value the user
 * typed, so a page cannot steer the fill to another saved account.
 */
function acceptTypedUsername(): boolean {
	if (autofillTrigger !== "icon" || !cachedResult || cachedResult.locked) return false;
	const suggestion = exactSuggestion;
	if (!suggestion) return false;
	const { field } = suggestion;
	if (deepActiveElement() !== field || !field.isConnected) return false;
	// The keycap was painted for the value the user typed. A page that changes the field afterwards
	// must not steer the fill to another saved login.
	const typed = typedUsernameQuery.get(field);
	if (!typed || field.value !== typed) return false;
	if (!affordance.markTrustworthy()) return false;
	const password = getPageFields().login.password;
	if (!passwordFieldVisible(password) || password.value) return false;
	clearInlineSuggestion();
	fillAndReport(field, suggestion.entryId, suggestion.name);
	return true;
}

/**
 * Enter takes the top filtered login when the user has typed a username into the anchored field
 * and the filtered menu is open. That fills both fields, like a click on the row; an empty or
 * pre-filled field keeps Enter as the form's submit.
 */
function pickTopForTypedQuery(): boolean {
	if (!cachedResult || cachedResult.locked || !pickerIsOpen()) return false;
	const field = anchorField();
	if (!field || field !== getPageFields().login.username) return false;
	if (deepActiveElement() !== field) return false;
	if (!typedUsernameQuery.get(field)) return false;
	if (!affordance.markTrustworthy()) return false;
	const top = loginRows(field, cachedResult.logins).matches[0];
	if (!top) return false;
	fillAndReport(field, top.id, top.name);
	return true;
}

/** Apply the click-behaviour mode. Never opens a panel by itself; the caller decides what the
 *  change should show on the field already in front of the user. */
function applyAutofillTrigger(trigger: AutofillTrigger): void {
	// A re-query repeats the same answer on every DOM mutation. Acting on it each time would close
	// a panel the user had just opened with the mark, so only a real change moves anything.
	if (autofillTrigger === trigger) return;
	autofillTrigger = trigger;
	affordance.setMarkAllowed(trigger !== "shortcut");
	if (autofillDisabled) return;
	if (trigger !== "focus") removePicker();
	if (trigger === "shortcut") {
		affordance.hide();
		clearInlineSuggestion();
		return;
	}
	const focused = focusedCandidate();
	if (focused) updateAffordance(focused);
	if (trigger === "icon") updateInlinePreview(focused);
	else clearInlineSuggestion();
}

/**
 * Fill the login the user chose in Bramble's own window for this page (#215). Top frame only, like
 * a desktop fill. The page has no focus while that window is in front, so a visible page will do,
 * as for a launch. False when there is no login form here, or the login isn't one of this page's.
 */
async function fillChosenLogin(entryId: string): Promise<boolean> {
	const into = loginTarget();
	if (!into) return false;
	const logins = await freshMatches(false);
	if (!logins?.some((login) => login.id === entryId)) return false;
	return selectMatch(entryId, false, false, into, documentIsVisible);
}

/** Apply a row density. Only an already-open menu needs to change: the mark and completion do
 *  not depend on it, and opening one for a merely focused field would turn a settings sync into
 *  an unasked-for menu (the mark then read the next click as "close"). */
function applyAutofillDensity(density: AutofillDensity): void {
	if (autofillDensity === density) return;
	autofillDensity = density;
	if (autofillDisabled || !pickerIsOpen()) return;
	// The anchor is known from the picker, so the rows swap behind the settings change even while
	// the Settings window has focus, instead of waiting for a reopen.
	const field = anchorField();
	if (field) openPickerFor(field);
}

/** A settings push that changes the row density, applied to a page that is already open. */
function pushAutofillDensity(density: unknown): void {
	if (!isAutofillDensity(density)) return;
	applyAutofillDensity(density);
}

/** A settings push that changes the trigger mode, applied to a page that is already open. */
function pushAutofillTrigger(trigger: unknown): void {
	if (!isAutofillTrigger(trigger)) return;
	applyAutofillTrigger(trigger);
	// Turning "open on focus" on while the user is already in a field should show it now, not on
	// the next focus. The other modes need no action beyond the mark `applyAutofillTrigger` set.
	if (trigger === "focus") {
		const focused = focusedCandidate();
		if (focused) openPickerFor(focused);
	}
}

function isQueryResult(v: unknown): v is QueryResult {
	return (
		typeof v === "object" &&
		v !== null &&
		Array.isArray((v as QueryResult).logins) &&
		Array.isArray((v as QueryResult).cards) &&
		typeof (v as QueryResult).locked === "boolean"
	);
}

/**
 * Caches the query result and surfaces the picker if a candidate field is focused.
 * SECURITY: never fills without an explicit user gesture; secrets are fetched only
 * on AUTOFILL_SELECT, so a password is never injected into the DOM on load.
 */
function handleResult(result: QueryResult | undefined): void {
	// Background forwards `undefined` when offscreen erred; keep the last good
	// cached result rather than clobbering it.
	if (!isQueryResult(result)) return;
	if (result.disabled) {
		applyAutofillEnabled(false);
		return;
	}
	cachedResult = result;
	if (result.launch) launchWatch = true;
	if (claimLaunch()) return;
	// Rides on the query so the suggestion below has a settings-shaped password to draw at once.
	holdGeneratedPassword(result.generated);
	autofillHintDue = result.hint === true && !autofillHintShown;
	if (isAutofillTrigger(result.trigger)) applyAutofillTrigger(result.trigger);
	if (isAutofillDensity(result.density)) applyAutofillDensity(result.density);

	// User dismissed/selected: don't resurrect the dropdown from a re-query until
	// they re-engage. cachedResult is still updated so the next focus sees fresh data.
	if (silenceAutoOpen) {
		reshowField = null;
		return;
	}

	// Prefer the focused field; fall back to a pending re-show target (a post-unlock refresh
	// whose field lost focus to the popup). Consume the target either way.
	const pending = reshowField?.isConnected ? reshowField : null;
	const target = focusedCandidate() ?? pending;
	reshowField = null;
	if (!target) return;

	// Quiet modes never open the panel from a query. The exception is a pending re-show: the user
	// opened the list explicitly (or clicked unlock from it), so the answer they were waiting for
	// should land where they asked. A plain re-query must not close a panel they just opened.
	if (autofillTrigger !== "focus" && !pending) {
		if (autofillTrigger === "icon") {
			updateAffordance(target);
			updateInlinePreview(target);
		}
		return;
	}

	if (result.locked) {
		showLockedPicker(target, result.hasPotentialMatch);
		return;
	}

	const kind = kindOf(getPageFields(), target);
	if (kind === "card") {
		const cards = cardRows(result);
		if (cards.matches.length > 0) showMatchesFor(cards.matches, target, cards.opts);
		return;
	}
	if (kind === "otp") {
		const otps = result.otps ?? [];
		if (otps.length > 0) showMatchesFor(otps, target, { otpOnly: true });
		return;
	}
	// login
	showLoginPicker(target, result.logins);
}

/**
 * Apply the autofill master switch. Off drops whatever is on screen and stops the query loop;
 * on re-arms it and asks again, so a page that has been sitting there since before the toggle
 * flipped starts working without a reload.
 */
function applyAutofillEnabled(enabled: boolean): void {
	autofillDisabled = !enabled;
	if (!enabled) {
		cancelOperations();
		cachedResult = null;
		reshowField = null;
		pendingUnlockField = null;
		removePicker();
		affordance.hide();
		clearInlineSuggestion();
		return;
	}
	queryAutofill();
}

/** Asks the background what's available for this page, but only if a fillable field exists. */
function queryAutofill(): void {
	if (autofillDisabled) return;
	const fields = getPageFields();
	const hasLogin = !!(fields.login.username || fields.login.password);
	const hasCard = cardFieldsPresent(fields.card);
	const hasOtp = fields.otp.length > 0;
	if (!hasLogin && !hasCard && !hasOtp) return;

	const generation = ++queryGeneration;
	void safeRequest<AutofillQueryResponse>({
		type: "AUTOFILL_QUERY",
		hasLogin,
		hasCard,
		hasOtp,
	}).then((response) => {
		if (generation !== queryGeneration || !response?.ok) return;
		handleResult(response.data);
	});
}

/** Decides what (if anything) to show when the user focuses or edits `field`, based on the cached result. */
function showFor(field: HTMLInputElement, opts?: { explicit?: boolean }): void {
	if (autofillDisabled) return;
	if (!cachedResult) {
		// An explicit open (the mark, or a post-unlock re-show) has to survive the round trip:
		// remember the field so the response can open the panel on it.
		if (opts?.explicit) reshowField = field;
		queryAutofill();
		return;
	}
	if (!opts?.explicit) {
		if (silenceAutoOpen) return;
		// Quiet modes: the mark and the completion are the whole interface. They update on every
		// focus and keystroke; only a click on the mark reaches the panel.
		if (autofillTrigger !== "focus") {
			updateAffordance(field);
			updateInlinePreview(field);
			// An explicitly opened menu stays live. Typing narrows it exactly as it does in focus
			// mode; without this the quiet mode's menu sat frozen on the pre-typing match set.
			if (pickerIsOpen() && anchorField() === field) openPickerFor(field);
			return;
		}
	}
	openPickerFor(field);
}

/** The panel policy. Reached on focus in "focus" mode, and by an explicit mark click in any mode. */
function openPickerFor(field: HTMLInputElement): void {
	// A menu opening replaces the pick chip: the user is asking to switch, not to read the last pick.
	affordance.dismissPick();
	updateAffordance(field);
	if (!cachedResult) {
		reshowField = field;
		queryAutofill();
		return;
	}
	if (cachedResult.locked) {
		showLockedPicker(field, cachedResult.hasPotentialMatch);
		return;
	}
	const kind = kindOf(getPageFields(), field);
	if (kind === "card") {
		const cards = cardRows(cachedResult);
		if (cards.matches.length > 0) showMatchesFor(cards.matches, field, cards.opts);
		// Then re-ask, always. A card field is the one place this frame's cached answer can go
		// out of date without anything happening HERE: on a hosted-fields checkout the number is
		// filled in a different frame entirely, and the carry that names it (`carriedCardId`)
		// lands on the next query. Paint from cache so the dropdown is instant, refresh behind
		// it; handleResult re-renders on this same field, and an unchanged render key makes that
		// a no-op.
		queryAutofill();
		return;
	}
	if (kind === "otp") {
		const otps = entriesForKind(cachedResult, "otp");
		if (otps.length === 0) {
			queryAutofill();
		} else if (otps.length > 1 || !field.value) {
			// A single match auto-fills on load; only re-offer the picker on a
			// choice or an empty field.
			showMatchesFor(otps, field, { otpOnly: true });
		}
		return;
	}
	if (cachedResult.logins.length === 0) {
		// No cached matches: offer a strong password if this looks like a signup
		// form, and (re)query in case matches exist but weren't cached yet.
		const suggest = maybeSuggest(field, false);
		if (suggest) showMatchesFor([], field, { suggest: { password: suggest.password } });
		queryAutofill();
		return;
	}
	// The list is filtered by the typed query, so a single login that matches the prefix stays
	// visible (with its completion) and one that does not is removed by showLoginPicker. The old
	// unconditional "get out of the way" removed the menu before the filter could be seen.
	showLoginPicker(field, cachedResult.logins);
}

// Nodes that can hold, or turn into, a fillable field. A batch that moves
// nothing else is page churn: YouTube rewrites its player and feed continuously,
// and re-parsing on every such batch is what made the extension cost hundreds of
// milliseconds per second (issue #59).
const FIELD_BEARING = "input, select, textarea, form, iframe, frame";

function mayBearFields(node: Node): boolean {
	// nodeType, not instanceof: a node adopted from another document belongs to
	// that realm's Element, and this runs on every batch a busy page produces.
	// 1 is Node.ELEMENT_NODE, spelled out so a last delivery during teardown
	// can't trip over a missing global.
	if (node.nodeType !== 1) return false;
	const el = node as Element;
	// A custom element renders its own subtree, often into a shadow root no
	// light-DOM observer can see, so treat one appearing as worth a re-parse.
	if (el.tagName.includes("-")) return true;
	return el.matches(FIELD_BEARING) || el.querySelector(FIELD_BEARING) !== null;
}

/** True when a batch touched something field-shaped. Pages using shadow DOM skip the filter. */
function touchesFields(records: MutationRecord[]): boolean {
	// A shadow tree's own churn produces no records here, so on a page that uses
	// them any batch is the only hint we get that something was re-rendered.
	if (pageUsesShadowDom()) return true;
	for (const record of records) {
		for (const node of record.addedNodes) if (mayBearFields(node)) return true;
		for (const node of record.removedNodes) if (mayBearFields(node)) return true;
	}
	return false;
}

// An input the model has never heard of, re-checked at most once. The model is
// only dropped on observable mutations, and a shadow root attaching produces
// none, so a first focus or click on an unknown input buys one re-parse before
// we write it off. Not wired to `input`, which fires per keystroke.
const rechecked = new WeakSet<HTMLInputElement>();

function isKnownCandidate(el: HTMLInputElement): boolean {
	if (isCandidate(getPageFields(), el)) return true;
	if (rechecked.has(el)) return false;
	rechecked.add(el);
	invalidatePageFields();
	return isCandidate(getPageFields(), el);
}

const REQUERY_MS = 500;

/** Coalesced re-query: one pending at a time, and never inside the observer callback. */
function scheduleQuery(): void {
	if (queryTimer !== null) return;
	// Clamped both ways: a system clock that steps backwards must not park the
	// re-query beyond one window.
	const elapsed = Date.now() - lastCheck;
	const wait = elapsed >= 0 && elapsed < REQUERY_MS ? REQUERY_MS - elapsed : 0;
	queryTimer = setTimeout(() => {
		queryTimer = null;
		lastCheck = Date.now();
		if (document.hidden) {
			missedWhileHidden = true;
			return;
		}
		queryAutofill();
	}, wait);
}

/** MutationObserver callback: SPA-submit fallback plus a throttled autofill re-query. */
function onDomChange(records: MutationRecord[]): void {
	if (!touchesFields(records)) return;
	// The DOM changed under us: drop the cached field model so the next read re-parses.
	invalidatePageFields();
	// Commit checkpoint: an armed capture whose password field has now gone, or a
	// password the user just edited whose field vanished within the submit window.
	maybeCommitCapture();
	// An SPA route change can take the relayed picker's field with it, and unlike a
	// scroll nothing else here would notice.
	if (relayedField && !relayedAnchorIsLive()) dropRelayed();
	// A background tab still runs its observer (a video in picture-in-picture keeps
	// the page busy); defer the re-query until the user is looking at it again.
	if (document.hidden) {
		missedWhileHidden = true;
		return;
	}
	scheduleQuery();
}

// The picker reports user actions through callbacks; the policy lives here.
//
// The menu can cover the password field's mark. A click on the left half of that mark means
// "switch to this field", not "pick the row under the pointer". `onPointer` records the field;
// the pick/open that follows is swallowed and the other field's menu opens instead.
let swallowPickFor: { field: HTMLInputElement; at: number } | null = null;
function takeSwallowedField(): HTMLInputElement | null {
	if (!swallowPickFor || performance.now() - swallowPickFor.at >= 250) return null;
	const field = swallowPickFor.field;
	swallowPickFor = null;
	return field;
}
function switchToSwallowedField(): boolean {
	const next = takeSwallowedField();
	if (!next) return false;
	silenceAutoOpen = true;
	removePicker();
	openMenuFor(next);
	return true;
}
picker.onPointer((x, y) => {
	const anchor = anchorField();
	if (!anchor) return;
	const field = document
		.elementsFromPoint(x, y)
		.find(
			(el): el is HTMLInputElement =>
				el instanceof HTMLInputElement && el !== anchor && isCandidate(getPageFields(), el),
		);
	if (!field || !affordance.isMarkSwitchZone(field, x, y)) return;
	swallowPickFor = { field, at: performance.now() };
});
picker.onPick((entryId, otpOnly) => {
	const field = anchorField();
	if (!field) return;
	if (switchToSwallowedField()) return;
	fillAndReport(field, entryId, entryName(entryId) ?? "", { otpOnly });
});
picker.onUnlockRequest((field) => {
	cancelOperations();
	// The click dismissed the picker; remember the field so the unlock broadcast can re-surface here.
	pendingUnlockField = field;
	// `reason` marks this pop-out as a step in the fill flow, so it closes itself on unlock.
	safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "unlock" } });
});
picker.onDismiss(() => {
	cancelOperations();
	silenceAutoOpen = true;
});
picker.onUseSuggested(() => {
	cancelOperations();
	const field = anchorField();
	if (!field) return;
	// Using the suggestion is an explicit choice: fill, offer to save, then silence
	// auto-redisplay until the user re-engages.
	applyGeneratedPassword(field);
	silenceAutoOpen = true;
	picker.remove();
	dropRelayed();
});
/**
 * Create an alias and put it in the field.
 *
 * The only place in the extension that spends the user's allowance, so it is reached only from
 * this explicit click. The row carries its own state through the round trip because it is the
 * one suggestion that can fail, and the failure is the only thing that tells someone whether to
 * fix a key, a plan or an allowance.
 */
picker.onUseAlias(() => {
	cancelOperations();
	const field = anchorField();
	// A click on the busy row is impossible by construction (it carries no hook), but a stale
	// keyboard activation could still arrive; one gesture must not buy two aliases.
	if (!field) return;
	if (aliasStateFor.get(field)?.state === "busy") return;

	aliasStateFor.set(field, { state: "busy" });
	showMatchesFor([], field, { alias: { state: "busy" } });

	void safeRequest<AliasCreateResponse>({ type: "ALIAS_CREATE" }).then((res) => {
		// The anchor can move (or go) while the provider answers. An address meant for a field the
		// user has left must not be painted onto the one they are on now, and the state it was
		// waiting in must not outlive it either.
		if (anchorField() !== field || !field.isConnected) {
			aliasStateFor.delete(field);
			return;
		}
		if (!res?.ok || !res.data.address) {
			// undefined means the extension went away mid-flight; there is nothing to report but
			// the row still has to leave the spinner.
			const message = res && !res.ok ? res.error : undefined;
			aliasStateFor.set(field, { state: "error", message });
			showMatchesFor([], field, { alias: { state: "error", message } });
			return;
		}
		aliasStateFor.delete(field);
		fillTextField(field, res.data.address);
		// Refresh the pending capture when a password is already in hand.
		//
		// An ordinary submit re-captures from the live form, so the address is picked up there
		// whatever order the two rows were used in. This covers the other order without a submit:
		// taking the password suggestion first stashes a capture immediately (so an "Unlock &
		// Save" prompt survives a navigation that never looks like a submit), and at that moment
		// the identifier did not exist yet. Left alone, that stash saves the login with an empty
		// username and the alias is lost, which defeats the point of having made one.
		const filledPassword = getLastFilledPassword();
		if (filledPassword) {
			safeSendMessage({
				type: "CORNER_PROMPT_CAPTURE",
				payload: { username: res.data.address, password: filledPassword, newLogin: true },
			});
		}
		silenceAutoOpen = true;
		picker.remove();
		dropRelayed();
	});
});
picker.onOpenEntry((entryId) => {
	if (switchToSwallowedField()) return;
	openEntryDetails(entryId);
});
picker.onNewLogin(openNewLogin);
picker.onRegenerate(() => {
	cancelOperations();
	const field = anchorField();
	if (!field) return;
	void regenerateInto(field).then((pw) => {
		// The anchor can move (or go) while the background answers; a password meant for a field
		// the user has left must not be painted onto the one they are on now.
		if (anchorField() !== field) return;
		// Suggestion-only prompt (no matches), matching showLoginPicker.
		showMatchesFor([], field, { suggest: { password: pw } });
	});
});

// The in-field mark opens the panel. This is the only way into it in "icon" mode, and a shortcut
// into it in "focus" mode. It is not a fill path: a pick still needs a trusted click inside the
// picker (or the command), so a page covering the mark can only make it hard to press.
function openMenuFor(field: HTMLInputElement): void {
	cancelOperations();
	// Locked, the mark is the fastest way in: open the unlock pop-out directly instead of drawing a
	// "Vault locked" row the user then has to click. The field is remembered so the list can
	// re-surface here once the vault opens.
	if (cachedResult?.locked) {
		pendingUnlockField = field;
		removePicker();
		affordance.dismissPick();
		safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "unlock" } });
		return;
	}
	if (pickerIsOpen() && anchorField() === field) {
		silenceAutoOpen = true;
		removePicker();
		return;
	}
	silenceAutoOpen = false;
	showFor(field, { explicit: true });
}
affordance.onOpen(openMenuFor);
// The one-time introduction was actually shown. Reported once; the background owns the flag so a
// page that never draws the hint cannot suppress it elsewhere.
affordance.onHintShown(() => {
	if (!autofillHintDue) return;
	autofillHintDue = false;
	autofillHintShown = true;
	safeSendMessage({ type: "AUTOFILL_HINT_SEEN" });
});

// The top frame lends its document to descendants that have no room to draw; every
// other frame keeps its own conversation with the UI it borrows. Only one of these
// runs per frame.
if (frameRelay.isTop()) {
	frameRelay.onAnchor(showRelayHost);
	frameRelay.onClose(closeRelayHost);
} else {
	// A click landed on a page around this frame: the user has moved on, as with a click
	// elsewhere in this one.
	frameRelay.onDismiss(() => {
		if (!pickerIsOpen()) return;
		silenceAutoOpen = true;
		removePicker();
	});
	installRelayClient(frameRelay, {
		onPick: (entryId, otpOnly) => {
			const field = relayedField;
			if (!field) return;
			fillAndReport(field, entryId, entryName(entryId) ?? "", { otpOnly });
		},
		onHighlight: (active, label) => {
			relayedHighlight = active;
			if (label) affordance.announce(label);
		},
		onPopout: () => {
			cancelOperations();
			const field = relayedField;
			dropRelayed();
			pendingUnlockField = field;
			safeSendMessage({ type: "POPOUT_OPEN", payload: { reason: "unlock" } });
		},
		onUseSuggested: () => {
			cancelOperations();
			const field = relayedField;
			if (!field) return;
			applyGeneratedPassword(field);
			silenceAutoOpen = true;
			dropRelayed();
		},
		onRegenerate: () => {
			cancelOperations();
			const field = relayedField;
			if (!field) return;
			void regenerateInto(field).then((pw) => {
				if (relayedField !== field) return;
				showMatchesFor([], field, { suggest: { password: pw } });
			});
		},
		onOpenEntry: (entryId) => openEntryDetails(entryId),
		onNewLogin: openNewLogin,
	});
}

// Disconnect the observer when the extension context is torn down.
onTeardown(() => {
	mutationObserver?.disconnect();
	mutationObserver = null;
	if (queryTimer !== null) {
		clearTimeout(queryTimer);
		queryTimer = null;
	}
	cancelOperations();
	dropRelayed();
});

// Enter inside a password field that drives no real `<form>` submit (lone
// inputs, ARIA pseudo-forms) is an effective submit; capture on it too. The
// open iframe dropdown gets first dibs on the key.
document.addEventListener(
	"keydown",
	(e) => {
		if (!e.isTrusted) return;
		cancelOperations();
		endLaunch();
		// Drive the open iframe dropdown with the keyboard first.
		if (picker.handleKey(e)) return;
		if (handleRelayedKey(e)) return;
		// WAI-ARIA combobox convention: Alt+ArrowDown opens the list from the field without moving
		// the caret. Once it is open, the picker's own arrows/Enter/Escape take over above. This is
		// the keyboard path into the menu in icon mode, where the mark is pointer-only.
		if (e.altKey && e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			const target = focusedCandidate();
			if (target) {
				e.preventDefault();
				openMenuFor(target);
				return;
			}
		}
		// A typed username in the anchored field makes Enter take the top filtered login and fill
		// both fields. The picker's own highlighted-row path above wins when the user has arrowed;
		// an empty field keeps Enter as submit. Tab is untouched: it keeps its native focus move.
		const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
		if (plainKey && e.key === "Enter" && pickTopForTypedQuery()) {
			e.preventDefault();
			return;
		}
		// With the menu closed, Enter takes the visible inline completion. This is the quiet mode's
		// keyboard path: type part of a username, the ghost shows the rest, Enter fills the login.
		// A pre-filled field still submits, because the completion is gated on real typing.
		if (plainKey && e.key === "Enter" && acceptInlineSuggestion()) {
			e.preventDefault();
			return;
		}
		// A fully typed username has no ghost to accept, but it is still a saved-login selection:
		// Enter fills its password when the password field is empty, rather than submitting.
		if (plainKey && e.key === "Enter" && acceptTypedUsername()) {
			e.preventDefault();
			return;
		}
		onPasswordEnter(e.key, composedTarget(e));
	},
	true,
);

try {
	api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (message?.type === "CORNER_FIELD") {
			sendResponse(handleCornerField(message.payload));
			return false;
		}

		if (message?.type === "CORNER_PROMPT_SHOW") {
			handleCornerPromptShow(message.payload as CornerPromptPayload);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "DESKTOP_FILL") {
			// A credential the desktop app is filling on this browser's behalf. It does NOT go through
			// AUTOFILL_SELECT: that reads this browser's own index, which is empty while locked, and
			// not having to unlock twice is the entire reason the link exists. The app authorized this
			// one: the user chose the entry there, against a page this browser reported.
			const fill = message.payload as
				| { username?: string; password?: string; totp?: string | null }
				| undefined;
			// Re-read the page rather than trusting the cached model. The model is only dropped when a
			// mutation moves something field-shaped (issue #59), so a field that changed in a way this
			// frame never observed - an input whose type flipped to password, say - would leave a fill the
			// user explicitly asked for in the desktop app answering "no field to fill". This runs once,
			// on a deliberate action, where a stale answer costs more than the parse.
			invalidatePageFields();
			// The field the user left focused, else the page's own login field.
			const fields = getPageFields().login;
			const into = focusedCandidate() ?? fields.username ?? fields.password;
			const kind = into ? currentTargetKind(into) : null;
			if (!fill?.password || !into || !kind) {
				sendResponse({ ok: false, error: "no field to fill" });
				return false;
			}
			cancelFill();
			picker.remove();
			dropRelayed();
			fillForm(fill.username ?? "", fill.password, false, into);
			if (fill.totp) fillOtp(fill.totp);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_LAUNCH_TOP_CHECK") {
			sendResponse(launchTopCheck(message.payload));
			return false;
		}

		if (message?.type === "AUTOFILL_ENABLED") {
			// The Settings toggle, applied to a page that is already open. The same push carries the
			// click-behaviour mode, so changing either setting lands without a reload. Only a real
			// switch change re-arms the query loop; a trigger-only push must not cost a round trip.
			const payload = message.payload as { enabled?: boolean; trigger?: string } | undefined;
			const enabled = payload?.enabled !== false;
			if (enabled === autofillDisabled) applyAutofillEnabled(enabled);
			pushAutofillTrigger(payload?.trigger);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_TRIGGER") {
			// The trigger-only push from Settings. It must not touch the enabled switch: an
			// `AUTOFILL_ENABLED` without a trigger would default `enabled` to true and turn
			// autofill back on.
			pushAutofillTrigger((message.payload as { trigger?: unknown } | undefined)?.trigger);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_DENSITY") {
			// The density-only push from Settings, same contract as the trigger push above.
			pushAutofillDensity((message.payload as { density?: unknown } | undefined)?.density);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_CYCLE") {
			// A browser command, relayed by the background. It reached every frame in the tab; only
			// the one with a focused candidate field acts.
			cycleAutofill((message.payload as { back?: boolean } | undefined)?.back === true);
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_SHORTCUT") {
			// The fill shortcut (#215). Like the cycle command it reaches every frame; only the
			// focused one answers, and it asks the background fresh so the shortcut works even with
			// page autofill switched off.
			void fillFromShortcut();
			sendResponse({ ok: true });
			return false;
		}

		if (message?.type === "AUTOFILL_FILL_ENTRY") {
			const entryId = (message.payload as { entryId?: unknown } | undefined)?.entryId;
			if (window !== window.top || typeof entryId !== "string") return false;
			void fillChosenLogin(entryId).then((ok) => sendResponse({ ok }));
			return true;
		}

		if (message?.type === "VAULT_LOCK_STATE") {
			// Either direction invalidates local response and delayed-submit work. A lock→unlock
			// ABA cannot revive a request that began before the transition: cancellation invalidates
			// both the pending fill identity and delayed-submit generation.
			cancelOperations();
			// The background pushes lock changes here since content scripts can't watch
			// storage.session. Keep the cached flag honest and refresh whatever is open so a
			// stale "Vault locked" row clears on unlock (and stale matches hide on lock).
			const locked = (message.payload as { locked?: boolean } | undefined)?.locked === true;
			if (cachedResult) cachedResult.locked = locked;
			const focused = focusedCandidate();
			if (locked) {
				// Lock only matters when a picker is open: swap to the "Vault locked" row on the focused
				// field (or keep the strong-password suggestion, which needs no vault), or hide stale
				// matches when focus has left. A fresh lock invalidates any pending unlock.
				clearInlineSuggestion();
				if (pickerIsOpen()) {
					if (focused) showLockedPicker(focused, cachedResult?.hasPotentialMatch ?? false);
					else removePicker();
				}
				// The mark stays on the field in front of the user, now offering the unlock row.
				if (focused) updateAffordance(focused);
				pendingUnlockField = null;
			} else {
				// Unlock: re-surface matches on the focused field, the open picker's anchor (toolbar/pop-out
				// unlock leaves the locked row up but moves focus off the page (issue #20), or the field the
				// user clicked "unlock" from (that click dismissed the picker, so there's no active host).
				const anchor = pickerIsOpen() ? anchorField() : null;
				const pending = pendingUnlockField?.isConnected ? pendingUnlockField : null;
				pendingUnlockField = null;
				const field = focused ?? anchor ?? pending;
				// An unlock the user asked for from a field is explicit; a toolbar unlock is not. In the
				// quiet modes only the explicit one reopens the panel - otherwise the mark updates and
				// the user clicks it when they are ready.
				const explicit = !!anchor || !!pending;
				removePicker();
				if (field) {
					if (autofillTrigger === "focus" || explicit) reshowField = field;
					else {
						updateAffordance(field);
						updateInlinePreview(field);
					}
					queryAutofill();
				}
			}
			sendResponse({ ok: true });
			return false;
		}

		return false;
	});
} catch {
	// The extension context can be gone before a late injection; there is no background to serve.
}

/** Runs initial queries and wires up the focus/input/mousedown/scroll listeners that drive the dropdown. */
function bootstrap(): void {
	queryAutofill();
	queryCornerPrompt();
	watchForLaunch();

	mutationObserver = new MutationObserver((records) => onDomChange(records));
	// Observe the stable document node so a page replacing body or documentElement
	// does not strand the observer on the old subtree.
	mutationObserver.observe(document, { childList: true, subtree: true });

	// Show on focus; this makes the email-only first step (e.g. ikea.com) work.
	document.addEventListener(
		"focusin",
		(e) => {
			// Filling a segmented OTP widget focuses each box in turn, and focus()
			// fires a *trusted* focusin: without this the dropdown reopens on the last
			// box we filled. Not the user's focus, so nothing here should react to it.
			if (isFilling()) return;
			const target = composedTarget(e);
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			// Do not treat extension-picker iframe focus as page deactivation. A real focus
			// change anywhere else in the page does supersede a picker-anchor operation.
			if (
				e.isTrusted &&
				activeFill &&
				!activeFill.launch &&
				target !== activeFill.target &&
				!isPickerInteractionTarget(target)
			) {
				cancelOperations();
			}
			if (!couldBeCandidate(target) || !isKnownCandidate(target)) return;
			// Explicit focus re-arms auto-display after any prior silence.
			silenceAutoOpen = false;
			if (claimLaunch()) return;
			showFor(target);
		},
		true,
	);

	// Keyboard exit: tab off the anchor and the picker stayed up, covering whatever the
	// user moved to. The mousedown listener only ever saw pointer exits, and the rAF
	// tracker only takes a picker down when its field goes away, not when focus does.
	//
	// relatedTarget is the element taking focus, and `null` means focus left the document
	// altogether (browser chrome, the unlock pop-out). That must NOT dismiss: issue #20
	// turns on the "Vault locked" row surviving exactly that.
	document.addEventListener(
		"focusout",
		(e) => {
			// Filling a segmented OTP widget focuses each box in turn; not the user leaving.
			if (isFilling()) return;
			// The mark belongs to the field the user is in. When focus moves on, take it down
			// before the next field's focusin paints its own. `next` null means focus left the
			// document (browser chrome, the unlock pop-out); the mark has nothing to point at then.
			const leaving = affordance.visibleFor();
			if (leaving && composedTarget(e) === leaving) {
				const next = (e as FocusEvent).relatedTarget;
				if (!next || !isPickerInteractionTarget(next)) {
					affordance.hide();
					clearInlineSuggestion();
				}
			}
			const anchor = anchorField();
			if (!anchor || composedTarget(e) !== anchor) return;
			const next = (e as FocusEvent).relatedTarget;
			// Focus inside our own picker (rows preventDefault to keep it on the field, but
			// don't bet the dismissal on that holding in every engine).
			if (!next || isPickerInteractionTarget(next)) return;
			// Leaving is an explicit dismissal, so a re-query can't resurrect it; focusin on
			// the next candidate field re-arms and re-anchors before anything paints.
			silenceAutoOpen = true;
			removePicker();
		},
		true,
	);

	// Surface/dismiss as the user types in an already-focused field (focusin
	// doesn't fire then).
	document.addEventListener(
		"input",
		(e) => {
			// fillForm dispatches synthetic input/change events; reacting would
			// reopen the dropdown the user just dismissed. Only trust real events.
			if (!e.isTrusted) return;
			cancelOperations();
			const target = composedTarget(e);
			if (!couldBeCandidate(target) || !isCandidate(getPageFields(), target)) return;
			silenceAutoOpen = false;
			// Record what the user actually typed, as opposed to whatever the field merely
			// holds (a pre-filled remembered value, an autofocus default): only a real
			// keystroke here should narrow the login picker's filter. Chrome's password
			// manager and the browser's own autocomplete fill a field with a trusted
			// `insertReplacementText` input; that is the browser, not the user, and a
			// browser-filled username that differs from the saved entry must not hide the
			// site's mark.
			const browserFilled = (e as InputEvent).inputType === "insertReplacementText";
			if (browserFilled) typedUsernameQuery.delete(target);
			else if (target.value) typedUsernameQuery.set(target, target.value);
			else typedUsernameQuery.delete(target);
			if (!cachedResult) {
				queryAutofill();
				return;
			}
			if (target.value && !cachedResult.locked) {
				// User is typing their own value: get out of the way unless there are
				// multiple matches of this field's kind to disambiguate.
				const kind = kindOf(getPageFields(), target);
				const count = entriesForKind(cachedResult, kind).length;
				if (count <= 1 && kind !== "login") {
					removePicker();
					if (autofillTrigger === "icon") {
						updateAffordance(target);
						updateInlinePreview(target);
					}
					return;
				}
			}
			showFor(target);
		},
		true,
	);

	// mousedown (not click): it fires before focusin, so a mousedown on a
	// `<label>` doesn't race us into an "open + immediate close" flash, and the
	// same listener detects re-engagement when the dropdown is closed.
	document.addEventListener(
		"pointerdown",
		(e) => {
			const target = composedTarget(e);
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			if (e.isTrusted && activeFill && !isPickerInteractionTarget(target)) {
				cancelOperations();
			}
			// A click into a login field is the form being used, not the user moving on.
			if (e.isTrusted && !couldBeCandidate(target)) endLaunch();
		},
		true,
	);

	document.addEventListener(
		"mousedown",
		(e) => {
			const target = composedTarget(e);
			// A click on the mark retargets to its host element. Leave it alone: the mark's own
			// listener is the one that opens the panel, and hiding here would remove it mid-click.
			if (target instanceof Node && affordance.ownsNode(target)) return;
			affordance.dismissHint();
			if (e.isTrusted && !isPickerInteractionTarget(target)) cancelSubmit();
			if (e.isTrusted && activeFill && !isPickerInteractionTarget(target)) {
				if (target !== activeFill.target) cancelOperations();
			}
			// A frame never hears a click on the page around it, and focus leaving it for this page
			// looks the same as leaving the window, which keeps its picker up on purpose. So tell
			// the frames, and drop any picker this frame hosts for one of them.
			if (e.isTrusted && !(target instanceof Node && relayHostContains(target))) {
				frameRelay.dismissDescendants();
				destroyRelayHost();
			}
			const host = picker.activeHost();
			if (host) {
				if (target instanceof Node) {
					// Clicks inside a cross-origin iframe never reach here.
					if (host.contains(target)) return;
					if (picker.clickIsOnAnchor(target)) return;
				}
				silenceAutoOpen = true;
				picker.remove();
				affordance.hide();
				clearInlineSuggestion();
				return;
			}
			// A relayed picker has no host in this document, so a click anywhere here
			// other than its own field is a dismissal. Clicks on the rows land in the
			// top frame and never reach this listener.
			if (relayedPickerIsOpen() && target !== relayedField) {
				silenceAutoOpen = true;
				dropRelayed();
				affordance.hide();
				clearInlineSuggestion();
				return;
			}
			// Picker closed: a mousedown on a candidate field is re-engagement.
			if (couldBeCandidate(target) && isKnownCandidate(target)) {
				silenceAutoOpen = false;
				// Re-click on the already-focused field fires no focusin, so show ourselves.
				if (deepActiveElement() === target) showFor(target);
				return;
			}
			// A click on the page at large is the user leaving the form. The mark has no anchor
			// once the field is no longer in play.
			affordance.hide();
			clearInlineSuggestion();
		},
		true,
	);
	// In the quiet mode the mark follows the pointer as well as focus: hovering a field is a
	// statement of intent, and it makes the affordance discoverable without opening anything.
	document.addEventListener(
		"pointerover",
		(e) => {
			if (autofillTrigger !== "icon" || autofillDisabled) return;
			const target = composedTarget(e);
			if (!couldBeCandidate(target) || !isKnownCandidate(target)) return;
			if (affordance.visibleFor() === target || deepActiveElement() === target) return;
			updateAffordance(target);
		},
		true,
	);

	// Leaving an unfocused field takes its mark with it. A focused field keeps it: the user is
	// still in the field even if the pointer wandered off.
	document.addEventListener(
		"pointerout",
		(e) => {
			if (autofillTrigger !== "icon") return;
			const target = composedTarget(e);
			const visible = affordance.visibleFor();
			if (!visible || !(target instanceof Node) || !visible.contains(target)) return;
			const next = (e as PointerEvent).relatedTarget;
			if (next instanceof Node && (visible.contains(next) || affordance.ownsNode(next))) return;
			if (deepActiveElement() === visible) return;
			affordance.hide();
			clearInlineSuggestion();
		},
		true,
	);

	// The mark is a host element: a click on it retargets to the host and never reaches the input.
	// When the host is not over a field (the menu is collapsing, or the pointer just arrived), a
	// click in the mark's 26px zone still means "open this field's list", so treat it as the mark.
	// Without this, the filled password field's mark is a dead zone while the username menu is
	// closing over it: the click focuses the field but opens nothing.
	document.addEventListener(
		"click",
		(e) => {
			if (!e.isTrusted || autofillDisabled || autofillTrigger === "shortcut") return;
			const target = composedTarget(e);
			if (!(target instanceof HTMLInputElement)) return;
			if (!couldBeCandidate(target) || !isCandidate(getPageFields(), target)) return;
			if (!affordance.isMarkZone(target, e.clientX, e.clientY)) return;
			if (pickerIsOpen() && anchorField() === target) return;
			e.preventDefault();
			openMenuFor(target);
		},
		true,
	);

	// The completion follows the caret. `selectionchange` covers arrow keys and a click inside the
	// field, which no `input` event reports. Throttled to one frame: it fires for every selection
	// in the document, and only the username field matters here.
	let previewRaf = 0;
	document.addEventListener("selectionchange", () => {
		if (previewRaf) return;
		previewRaf = requestAnimationFrame(() => {
			previewRaf = 0;
			const field = getPageFields().login.username;
			if (field && deepActiveElement() === field) updateInlinePreview(field);
		});
	});

	window.addEventListener("scroll", () => repositionPicker(), true);
	window.addEventListener("resize", () => repositionPicker(), true);
	window.addEventListener(
		"pagehide",
		() => {
			cancelOperations();
			// Leaving the document. bfcache freezes the DOM as it stands, so a picker left
			// open comes back on the return trip showing a match set - and a lock state -
			// from before the trip.
			removePicker();
			affordance.hide();
			clearInlineSuggestion();
		},
		true,
	);
	window.addEventListener("pageshow", (e) => {
		if (e.persisted) {
			cancelOperations();
			cachedResult = null;
			affordance.hide();
			clearInlineSuggestion();
			queryAutofill();
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") {
			cancelOperations();
			affordance.hide();
			clearInlineSuggestion();
			return;
		}
		// Catch up on whatever the page rebuilt while it was hidden.
		if (!missedWhileHidden) return;
		missedWhileHidden = false;
		invalidatePageFields();
		queryAutofill();
	});
	window.addEventListener("blur", () => {
		// Moving focus into the authenticated picker iframe keeps the top document focused.
		setTimeout(() => {
			if (!document.hasFocus()) cancelOperations();
		}, 0);
	});
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
