/// <reference types="chrome" />

// Top-frame side of the relayed picker. This frame owns only the iframe ELEMENT:
// it creates it, parks it at the relayed rect, applies the height the UI asks for,
// and destroys it. It never sees match summaries or picks, which travel directly
// between the field's frame and the UI document. See docs/autofill.md.
//
// SECURITY: because this frame controls the element's geometry, it also owns the
// anti-clickjacking guard. The non-relayed picker checks trust at pick time, which is
// impossible here (the pick never passes through this frame), so the guard runs
// continuously and tears the host down the moment it stops being legible. You cannot
// click what is not there, and a page cannot suppress the teardown: the verdict comes
// from computed style this frame reads itself, not from any message.

import { api } from "./content-api";
import { isExtensionOrigin } from "./ext-origin";
import type { RelayedAnchor, RelayRect } from "./frame-relay";
import { hostOffset } from "./host-offset";
import { isLegible } from "./legibility";
import { onTeardown } from "./lifecycle";
const AUTOFILL_UI_URL = api.runtime.getURL("autofill-ui.html");
import { MENU_COLLAPSE_MS, MENU_FADE_MS, maxMenuHeight, relayWidth } from "./placement";

const MAX_HEIGHT = 400;
type Hosted = {
	relayId: string;
	host: HTMLElement;
	frame: HTMLIFrameElement;
	rect: RelayRect;
	/** The larger of the two gaps around the field, so the UI can cap its list. */
	cap?: number;
};

let hosted: Hosted | null = null;
let watchdog: number | null = null;

/**
 * A relayed rect is in this frame's VIEWPORT coordinates, but the host is
 * position:absolute, so it is placed in DOCUMENT coordinates. Without the scroll
 * offset the picker is drawn scrollY pixels too high, which on a checkout you had to
 * scroll down to reach puts it off-screen entirely, and the watchdog below then
 * destroys it for being illegible. Matches positionHostElement in picker.ts.
 */
function position(h: Hosted): void {
	const width = relayWidth(h.rect.width, window.innerWidth);
	const offset = hostOffset(h.host);
	const x = Math.max(offset.x, Math.min(h.rect.x + offset.x, offset.x + window.innerWidth - width));
	// The iframe is 0 tall until the UI reports; once it has a height, place it above when the
	// space below the field is too small. A relayed field often sits low in a checkout form.
	const height = h.frame.getBoundingClientRect().height;
	const spaceBelow = window.innerHeight - (h.rect.y + h.rect.height);
	const spaceAbove = h.rect.y;
	const above = height > 0 && spaceBelow < height + 8 && spaceAbove > spaceBelow;
	const y = above ? h.rect.y - height - 2 + offset.y : h.rect.y + h.rect.height + 2 + offset.y;
	const transform = `translate3d(${x}px, ${y}px, 0)`;
	if (h.host.style.transform !== transform) {
		h.host.style.transform = transform;
		// The UI cannot see the host move; reset its early-click guard so a click aimed at where
		// the card used to be cannot fill.
		h.frame.contentWindow?.postMessage({ type: "UI_MOVED" }, "*");
	}
	h.host.style.width = `${width}px`;
	h.host.classList.toggle("tp-above", above);
	// The UI cannot see this frame's viewport, so it cannot cap the list to the gap around the
	// field by itself. Post the cap; the first post can land before the UI is ready, so the
	// UI_RESIZE handler posts it again once the document exists.
	h.cap = maxMenuHeight(spaceBelow, spaceAbove);
	h.frame.contentWindow?.postMessage({ type: "UI_MAX_HEIGHT", maxHeight: h.cap }, "*");
}

function stopWatchdog(): void {
	if (watchdog !== null) {
		cancelAnimationFrame(watchdog);
		watchdog = null;
	}
}

/** Drop the hosted picker. Called on withdrawal, teardown, or a failed trust check. */
export function destroyRelayHost(): void {
	stopWatchdog();
	if (hosted) {
		hosted.host.remove();
		hosted = null;
	}
}

// A zero-height frame is the normal pre-render state, so the guard only starts
// policing once the UI has reported a real height.
function startWatchdog(): void {
	if (watchdog !== null) return;
	const tick = (): void => {
		watchdog = null;
		if (!hosted) return;
		const measurable = hosted.frame.getBoundingClientRect().height >= 20;
		if (measurable && !isLegible(hosted.host)) {
			destroyRelayHost();
			return;
		}
		watchdog = requestAnimationFrame(tick);
	};
	watchdog = requestAnimationFrame(tick);
}

/** Create or re-park the hosted picker for a descendant's relayed anchor. */
export function showRelayHost(anchor: RelayedAnchor): void {
	if (hosted && hosted.relayId !== anchor.relayId) destroyRelayHost();
	if (hosted) {
		hosted.rect = anchor.rect;
		position(hosted);
		return;
	}
	const host = document.createElement("div");
	host.id = `tp-${Math.random().toString(36).slice(2, 10)}`;
	// pointer-events: modals set `body { pointer-events: none }`, which the host would inherit.
	host.style.cssText =
		"position: absolute; top: 0; left: 0; z-index: 2147483647; margin: 0; padding: 0; border: 0; pointer-events: auto;";
	const shadow = host.attachShadow({ mode: "closed" });
	const frame = document.createElement("iframe");
	// relayId lets the UI answer the right frame's probe; parentOrigin is only used
	// for the height message back to this frame.
	frame.src = `${AUTOFILL_UI_URL}?relayId=${encodeURIComponent(anchor.relayId)}&parentOrigin=${encodeURIComponent(location.origin)}`;
	frame.setAttribute("scrolling", "no");
	frame.style.cssText =
		"display: block; width: 100%; height: 0; border: 0; margin: 0; background: transparent; color-scheme: light dark;";
	shadow.appendChild(frame);
	document.body.appendChild(host);
	hosted = { relayId: anchor.relayId, host, frame, rect: anchor.rect };
	position(hosted);
	startWatchdog();
}

/** True when `node` is the hosted picker or inside it (its closed shadow retargets to the host). */
export function relayHostContains(node: Node): boolean {
	return !!hosted && hosted.host.contains(node);
}

/** Test seam: the hosted UI frame, which otherwise sits behind a closed shadow root. */
export function hostedFrameForTest(): HTMLIFrameElement | null {
	return hosted?.frame ?? null;
}

/** Withdraw the host for `relayId`, ignoring a stale id from an already-replaced relay. */
export function closeRelayHost(relayId: string): void {
	if (hosted?.relayId === relayId) destroyRelayHost();
}

// The only message this frame accepts from the UI is its height. It must come from
// our own iframe's window on one of our origins; a page posting from its own window
// fails both checks.
window.addEventListener("message", (e) => {
	if (!hosted || e.source !== hosted.frame.contentWindow) return;
	if (!isExtensionOrigin(e.origin)) return;
	const msg = e.data as { type?: string; height?: unknown } | undefined;
	if (msg?.type !== "UI_RESIZE") return;
	const height = Math.max(0, Math.min(MAX_HEIGHT, Number(msg.height) || 0));
	hosted.frame.style.height = `${height}px`;
	// The first placement ran while the frame was 0 tall; now that the menu has a height, choose
	// above/below again so a field near the bottom does not leave the card cut off. This also
	// re-posts the gap cap once the UI document exists to receive it.
	position(hosted);
});

onTeardown(destroyRelayHost);
