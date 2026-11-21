import { t } from "../i18n";
import { html } from "../template";

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
	// Older engines: code points at least keep an emoji whole (ZWJ sequences may split).
	return Array.from(text);
}

// Jr/Sr and generational suffixes are not the surname: "Christopher Alexander Montgomery III"
// should read CM, not CI or CA.
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/** Uppercase avatar initials from grapheme clusters: first + last significant word, else the
 *  first two graphemes of a single-word name. Twin of autofill-ui.ts's `initials`. */
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

export function dropdownItem({
	id,
	name,
	secondary,
	carried,
	compact,
}: {
	id: string;
	name: string;
	secondary: string;
	// This entry was already used on this page: a card filled in this tab, or the login last used
	// on this registrable domain. See content.ts `cardRows` / `loginRows`.
	carried?: boolean;
	// One-line row with a small monogram, for the compact menu. Mirrors autofill-ui.ts's matchRow.
	compact?: boolean;
}) {
	// A nameless entry (possible through an import) still needs a primary line. The username is
	// the only identifier it has; when that is empty too, a generic label beats a blank row.
	const primary = name || secondary || t("savedLogin");
	const detail = name ? secondary : "";
	const badge = carried
		? html`<span class="tp-badge" title="${t("usedHere")}">${t("usedHere")}</span>`
		: "";
	// A row action, not a second fill target: the mousedown handler checks it before the row's
	// entry id. It opens the full Bramble window on this entry, for fields the picker doesn't fill.
	// It shares the trailing slot with the badge and appears on hover or row highlight, so the row
	// reads as one thing until you reach for the escape hatch.
	const open = html`<button class="tp-open" type="button" data-tp-open-entry="1" aria-label="${t("openEntryDetails")}" title="${t("openEntryDetails")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg></button>`;
	if (compact) {
		return html`
		<div class="tp-item tp-item-compact" data-entry-id="${id}" role="option" aria-selected="false">
			<div class="tp-avatar tp-avatar-compact" aria-hidden="true">
				${initials(primary)}
			</div>
			<div class="tp-text tp-text-compact">
				<span class="tp-name" title="${primary}">${primary}</span>
				<span class="tp-user" title="${detail}">${detail}</span>
			</div>
			<div class="tp-trail">${[badge, open]}</div>
		</div>
	`;
	}
	return html`
		<div class="tp-item" data-entry-id="${id}" role="option" aria-selected="false">
			<div class="tp-avatar" aria-hidden="true">
				${initials(primary)}
			</div>
			<div class="tp-text">
				<span class="tp-name" title="${primary}">${primary}</span>
				<span class="tp-user" title="${detail}">${detail}</span>
			</div>
			<div class="tp-trail">${[badge, open]}</div>
		</div>
	`;
}
