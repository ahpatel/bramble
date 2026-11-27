import { t } from "../i18n";
import { html } from "../template";

/** Shadow-renderer note after a capped match list (twin of autofill-ui.ts's moreRow). Not a row:
 *  it takes no keys and no clicks, and the count above it already says `9+`. */
export const dropdownMore = (): string =>
	html`<div class="tp-more" id="tp-more-note" role="note">${t("menuMore")}</div>`;
