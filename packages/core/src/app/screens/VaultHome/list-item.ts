// Entry -> vault-list row.
//
// Extracted from the route and spread rather than field-by-field on purpose: the previous
// hand-written mapping silently dropped a field a mode had started returning (the passkey
// marker), and nothing failed. Anything a mode's `row()` produces now reaches the list by
// default, and the few fields the list owns are applied over the top.

import type { Entry } from "../../../hooks/useVault";
import { tagKey } from "../../../vault/tags";
import { getEntryMode } from "../../entry-modes";
import { customFieldsCopyItems, customFieldsSearchText } from "../../entry-modes/custom-fields";
import type { VaultListItem } from "./VaultHome";

/** `showBreaches` off hides the badge without the list having to know why.
 * `concealPassword` drops the password copy action (hide-password policy,
 * docs/adr/0009) — the fill path is unaffected, only the vault UI's copy. */
export function toListItem(
	entry: Entry,
	showBreaches: boolean,
	concealPassword = false,
): VaultListItem {
	const mode = getEntryMode(entry.type);
	const view = mode.row(entry);
	return {
		...view,
		id: entry.id,
		type: entry.type,
		name: entry.name,
		leaked: showBreaches ? view.leaked : false,
		// Custom fields are shared across all modes, so they fold into copy actions and search
		// text here rather than in each descriptor.
		copyItems: [...view.copyItems, ...customFieldsCopyItems(entry.customFields)].filter(
			(item) => !(concealPassword && item.kind === "password"),
		),
		// Tags join the free-text haystack as well as driving the `#tag` filter, so a plain
		// "work" finds the entries tagged work without the user having to know the syntax.
		searchText:
			`${mode.searchText(entry)} ${customFieldsSearchText(entry.customFields)} ${(entry.tags ?? []).join(" ")}`.toLowerCase(),
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		lastUsedAt: entry.lastUsedAt,
		archived: entry.archivedAt !== undefined,
		tagKeys: entry.tags?.map(tagKey),
	};
}
