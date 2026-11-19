import { onTeardown } from "./lifecycle";

// Picker hosts are position:absolute children of <body> placed by translate, so the translate
// counts from their containing block's origin. That is usually the document's (the viewport minus
// the scroll offset), but not when the page positions <html> or <body>: Angular CDK's scroll-block
// pins <html> at top:-scrollY while a dialog is open. See docs/autofill.md.

let probe: HTMLElement | null = null;
// The mark and picker trackers both ask on every frame; they share a containing block, so one
// probe read per frame is enough. The cache is short (a frame) so a scroll lock that moves the
// document is picked up on the next frame.
let cached: { x: number; y: number } | null = null;
let cachedAt = Number.NEGATIVE_INFINITY;

/** What to add to a viewport point to get the translate that puts `host` there. */
export function hostOffset(host: HTMLElement): { x: number; y: number } {
	const now = performance.now();
	if (cached && now - cachedAt < 16) return cached;
	const parent = host.parentNode;
	if (!parent) return { x: window.scrollX, y: window.scrollY };
	// An untranslated box beside the host shares its containing block, so it sits on the origin.
	if (!probe) {
		probe = document.createElement("div");
		probe.style.cssText =
			"position: absolute; top: 0; left: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; visibility: hidden; pointer-events: none;";
	}
	if (probe.parentNode !== parent) parent.insertBefore(probe, host);
	const origin = probe.getBoundingClientRect();
	cached = { x: -origin.left, y: -origin.top };
	cachedAt = now;
	return cached;
}

onTeardown(() => {
	probe?.remove();
	probe = null;
	cached = null;
	cachedAt = Number.NEGATIVE_INFINITY;
});
