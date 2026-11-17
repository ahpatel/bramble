/** How a click into a login field reaches the saved logins. One definition, shared by the app's
 *  Settings screen, the background preference reader and the content script: adding a mode is
 *  one edit, not four declarations and three validators that can drift apart. */
export type AutofillTrigger = "icon" | "focus" | "shortcut";

// Icon only: the quiet default. The list opens when the in-field mark is clicked, or the shortcut
// fills without any list at all. "focus" restores the older auto-open behaviour.
export const DEFAULT_AUTOFILL_TRIGGER: AutofillTrigger = "icon";

/** True for a value this build understands. */
export function isAutofillTrigger(value: unknown): value is AutofillTrigger {
	return value === "icon" || value === "focus" || value === "shortcut";
}

/**
 * Only the three known modes. Storage written by another build is not trusted to still fit.
 *
 * "auto" was the pre-icon name for click-to-open; it maps to "focus" rather than the new default,
 * so an existing user who stored it keeps the behaviour they chose instead of silently losing it.
 */
export function normalizeAutofillTrigger(raw: unknown): AutofillTrigger {
	if (raw === "auto") return "focus";
	return isAutofillTrigger(raw) ? raw : DEFAULT_AUTOFILL_TRIGGER;
}
