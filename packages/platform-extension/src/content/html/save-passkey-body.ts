import { t } from "../i18n";
import { html } from "../template";

// Right chevron (lucide chevron-right): each row is click-to-act, so it cues "pick me".
const chevron = `<svg class="tp-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

/** Two initials for the avatar: first letters of the first two words, else the first two
 *  characters. Splits on spaces and the usual username separators. */
function initialsOf(label: string): string {
	const parts = label
		.trim()
		.split(/[\s._@+-]+/)
		.filter(Boolean);
	const two =
		parts.length >= 2
			? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")
			: (parts[0] ?? label).slice(0, 2);
	return two.toUpperCase() || "?";
}

/** One account row. The whole row is a button: clicking it picks that account and acts
 *  immediately (sign in / attach), so there are no separate confirm buttons. `value` is the
 *  credentialId (get) or the login id / "new" (create); the content script reads it as `choice`. */
function choiceRow(value: string, primary: string, sub: string | undefined) {
	return html`<button type="button" class="tp-choice" data-tp-action="passkey-pick" data-tp-value="${value}">
		<span class="tp-avatar">${initialsOf(primary)}</span>
		<span class="tp-choice-text">
			<span class="tp-choice-primary">${primary}</span>
			${sub ? [html`<span class="tp-choice-sub">${sub}</span>`] : []}
		</span>
		${[chevron]}
	</button>`;
}

/** The passkey provider corner card: pick which account to sign in with / attach a new
 * passkey to (each row acts on click), or confirm a single save. Every stored passkey is
 * shown with an avatar + its account name so the user knows exactly who they're acting as. */
export function savePasskeyBody({
	rpId,
	rpName,
	userName,
	intent,
	existingLoginName,
	candidates,
	passkeyChoices,
	primaryLabel,
	locked,
	noMatch,
	nativeFallback,
}: {
	rpId: string;
	rpName?: string;
	userName?: string;
	intent: "create" | "get";
	existingLoginName?: string;
	candidates?: { id: string; name: string; username: string }[];
	passkeyChoices?: { credentialId: string; label: string }[];
	primaryLabel: string;
	locked?: boolean;
	noMatch?: boolean;
	nativeFallback?: "passthrough" | "disable";
}) {
	// Avoid "x (x)" when the RP's display name equals its id.
	const site = rpName && rpName !== rpId ? `${rpName} (${rpId})` : rpId;
	const isCreatePicker = intent === "create" && !!candidates && candidates.length > 0;
	const isGetList = intent === "get" && !!passkeyChoices && passkeyChoices.length > 0;
	const hasList = isGetList || isCreatePicker;
	const title = noMatch
		? t("passkeyNoneTitle")
		: isGetList
			? passkeyChoices.length > 1
				? t("passkeySignInWhich")
				: t("passkeyUseTitle")
			: isCreatePicker
				? t("passkeyAddToTitle")
				: intent === "get"
					? t("passkeyUseTitle")
					: existingLoginName
						? t("passkeyAddTitle")
						: t("passkeySaveTitle");

	// Nested html escapes interpolated values; array interpolations join markup verbatim.
	let middle: string[] = [];
	if (noMatch) {
		// Say what the primary action does: relays natively (Firefox) or turns the provider
		// off so the retry reaches the platform authenticator (Chrome has no passthrough).
		const note = t(
			nativeFallback === "passthrough" ? "passkeyNoneNotePassthrough" : "passkeyNoneNoteDisable",
		);
		middle = [html`<div class="tp-note">${note}</div>`];
	} else if (locked) {
		// Locked: the vault can't be read yet, so say what unlocking is for before the popup.
		const note = intent === "get" ? t("passkeyUnlockUseNote") : t("passkeyUnlockSaveNote");
		middle = [html`<div class="tp-note">${note}</div>`];
	} else if (isGetList) {
		middle = [
			html`<div class="tp-choices">${passkeyChoices.map((c) => choiceRow(c.credentialId, c.label, undefined))}</div>`,
		];
	} else if (isCreatePicker) {
		const rows = (candidates ?? []).map((c) => choiceRow(c.id, c.name, c.username || undefined));
		rows.push(choiceRow("new", t("passkeyCreateNewLogin"), undefined));
		middle = [html`<div class="tp-choices">${rows}</div>`];
	} else {
		const rows: string[] = [];
		if (existingLoginName) {
			rows.push(
				html`<div class="tp-row"><div class="tp-label">${t("passkeyAddsTo")}</div><div>${existingLoginName}</div></div>`,
			);
		}
		if (userName) {
			rows.push(
				html`<div class="tp-row"><div class="tp-label">${t("fieldAccount")}</div><div>${userName}</div></div>`,
			);
		}
		middle = rows;
	}

	// A pickable list acts on row click, so it needs no confirm buttons (dismiss via the ×).
	// A single confirm (locked prompt, or a save with no ambiguity) keeps the button row.
	// The no-match card inverts the row: Bramble has nothing for this site, so the primary
	// action IS the handoff to the user's other authenticators. Any refusal ("Not now",
	// the ×, the ceremony timeout) hands off too, so no second button is needed.
	const actions = noMatch
		? [
				html`<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-native">${t("passkeyUseOther")}</button>
		</div>`,
			]
		: hasList
			? []
			: [
					html`<div class="tp-actions">
			<button class="tp-btn tp-btn-primary" data-tp-action="passkey-approve">${primaryLabel}</button>
			<button class="tp-btn" data-tp-action="passkey-dismiss">${t("notNow")}</button>
		</div>`,
				];

	// Every refusal from a passkey card hands off, so the note says what "Not now" does
	// (the no-match card already says it in its body): Firefox relays natively; Chrome
	// has no passthrough, so the request fails with the handoff message, the provider
	// turns off, and the site's retry goes native.
	const declineNote = !noMatch
		? nativeFallback === "disable"
			? t("passkeyDeclineNoteDisable")
			: nativeFallback === "passthrough"
				? t("passkeyDeclineNotePassthrough")
				: ""
		: "";
	const nativeAlt = declineNote ? [html`<div class="tp-subnote">${declineNote}</div>`] : [];

	return html`
		<div class="tp-head">
			<div class="tp-head-main">
				<div class="tp-icon"><span class="tp-glyph"></span></div>
				<div>
					<div class="tp-title">${title}</div>
					<div class="tp-host">${site}</div>
				</div>
			</div>
			<button class="tp-close" data-tp-action="passkey-dismiss" aria-label="Dismiss">×</button>
		</div>
		${middle}
		${actions}
		${nativeAlt}
	`;
}
