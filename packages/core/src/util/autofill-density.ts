// Extension only: how much room each row in the in-page list gets. Compact puts the entry name
// and username on one line; comfortable gives the name its own row (and a second line when it
// needs one) with the username below. Device-scoped: the background reads it while the vault is
// locked, and it is about this install's screen, not the vault's data.
export type AutofillDensity = "compact" | "comfortable";

export const DEFAULT_AUTOFILL_DENSITY: AutofillDensity = "comfortable";

export function isAutofillDensity(value: unknown): value is AutofillDensity {
	return value === "compact" || value === "comfortable";
}

/** Unknown stored values follow the default, so a build that never wrote the pref or an older
 *  value cannot leave the menu without a row layout. */
export function normalizeAutofillDensity(raw: unknown): AutofillDensity {
	return isAutofillDensity(raw) ? raw : DEFAULT_AUTOFILL_DENSITY;
}
