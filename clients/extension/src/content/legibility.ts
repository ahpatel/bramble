// Shared legibility checks for the autofill host. The picker and the relayed host run in different
// frames but the same content-script bundle, so the trust rule lives in one place.

/** Opacity contributed by `filter: opacity(...)`; other filters are allowed (Dark Reader inverts). */
export function filterOpacity(filter: string): number {
	let out = 1;
	for (const m of filter.matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) {
		out *= Number(m[1]) / (m[2] ? 100 : 1);
	}
	return out;
}

/** The opacity the picker is painted at: neither `opacity` nor `filter` inherits, so an ancestor's
 *  never shows in the host's own computed style. */
export function effectiveOpacity(el: Element): number {
	let out = 1;
	for (let node: Element | null = el; node; node = node.parentElement) {
		const cs = getComputedStyle(node);
		const own = Number.parseFloat(cs.opacity);
		out *= (Number.isNaN(own) ? 1 : own) * filterOpacity(cs.filter ?? "");
	}
	return out;
}

/** A click this soon after the UI appeared may have been aimed at whatever was there before. */
export const EARLY_CLICK_MS = 500;

/** True when `host` is on screen, opaque counting ancestors, unclipped, and topmost at its centre. */
export function hostIsTrustworthy(host: HTMLElement | null): boolean {
	if (!host) return false;
	const rect = host.getBoundingClientRect();
	if (rect.width < 60 || rect.height < 20) return false;
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= window.innerHeight ||
		rect.left >= window.innerWidth
	) {
		return false;
	}
	const cs = getComputedStyle(host);
	if (cs.visibility !== "visible" || cs.display === "none") return false;
	if (effectiveOpacity(host) < 0.9) return false;
	if (cs.filter !== "none" || cs.mixBlendMode !== "normal" || cs.clipPath !== "none") return false;
	// elementFromPoint resolves to the host (closed shadow); an unrelated element means an overlay.
	const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	if (!top) return false;
	return top === host || host.contains(top) || top.contains(host);
}
