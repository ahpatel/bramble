import { api } from "./content-api";

// Chromium paints its own key/eye icon inside a recognised password field at the inline end; the
// mark sits left of it. Firefox has no in-field icon.
export const MARK_INSET = (() => {
	try {
		return new URL(api.runtime.getURL("autofill-ui.html")).protocol === "chrome-extension:"
			? 30
			: 8;
	} catch {
		return 8;
	}
})();
