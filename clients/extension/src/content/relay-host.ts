/// <reference types="chrome" />

// Top-frame side of the relayed picker. This frame owns only the iframe element and the
// anti-clickjacking guard; match data travels directly between the field's frame and the UI.

import { api } from "./content-api";
import { isExtensionOrigin } from "./ext-origin";
import type { RelayedAnchor, RelayRect } from "./frame-relay";
import { hostOffset } from "./host-offset";
import { hostIsTrustworthy } from "./legibility";
import { onTeardown } from "./lifecycle";
import { MARK_INSET } from "./mark";
import { MENU_COLLAPSE_MS, MENU_FADE_MS, maxMenuHeight, relayWidth } from "./placement";

const AUTOFILL_UI_URL = (() => {
	try {
		return api.runtime.getURL("autofill-ui.html");
	} catch {
		// Orphaned injection: no relayed host can be created, and the field's frame will time out
		// to its own renderer.
		return "";
	}
})();
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
let relayExit: Animation | null = null;

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

/** Cancel a collapse-to-mark exit and restore the host's normal transform. */
function cancelRelayExit(): void {
	if (relayExit) {
		relayExit.cancel();
		relayExit = null;
	}
	if (hosted) {
		hosted.host.style.transformOrigin = "";
		// The base host style is pointer-events: auto (a modal's body can be none). Clearing it
		// would inherit the modal's none and make the repositioned menu unclickable.
		hosted.host.style.pointerEvents = "auto";
	}
}

/** Drop the hosted picker. Called on withdrawal, teardown, or a failed trust check. */
export function destroyRelayHost(): void {
	cancelRelayExit();
	stopWatchdog();
	if (hosted) {
		hosted.host.remove();
		hosted = null;
	}
}

// A zero-height frame is the normal pre-render state, so the guard only starts
// policing once the UI has reported a real height.
//
// The trust check reads computed style, the host rect and a hit test: expensive enough that
// running it every frame while a relayed menu sits open is continuous main-thread work for no
// gain. Position still follows every frame; trust is re-checked at ~7Hz, matching the picker's
// own anchor liveness check. A page cannot suppress the verdict between checks without the host
// moving first, which the next check sees.
const TRUST_CHECK_MS = 150;
function startWatchdog(): void {
	if (watchdog !== null) return;
	let lastTrust = Number.NaN;
	const tick = (ts: number): void => {
		watchdog = null;
		if (!hosted) return;
		if (Number.isNaN(lastTrust) || ts - lastTrust >= TRUST_CHECK_MS) {
			lastTrust = ts;
			const measurable = hosted.frame.getBoundingClientRect().height >= 20;
			if (measurable && !hostIsTrustworthy(hosted.host)) {
				destroyRelayHost();
				return;
			}
		}
		watchdog = requestAnimationFrame(tick);
	};
	watchdog = requestAnimationFrame(tick);
}

/** Create or re-park the hosted picker for a descendant's relayed anchor. */
export function showRelayHost(anchor: RelayedAnchor): void {
	if (!AUTOFILL_UI_URL) return;
	if (hosted && hosted.relayId !== anchor.relayId) destroyRelayHost();
	if (hosted) {
		// A new query during the 240ms exit (the user re-opened the field) takes the host back.
		cancelRelayExit();
		hosted.rect = anchor.rect;
		position(hosted);
		startWatchdog();
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

/** Withdraw the host for `relayId`, ignoring a stale id from an already-replaced relay.
 *  `collapse` is a pick: shrink the card into the field's in-field mark before destroying it.
 *  A plain dismissal still closes instantly. */
export function closeRelayHost(relayId: string, collapse = false): void {
	if (hosted?.relayId !== relayId) return;
	const h = hosted;
	if (!collapse || typeof h.host.animate !== "function") {
		destroyRelayHost();
		return;
	}
	const rect = h.host.getBoundingClientRect();
	if (rect.width < 1 || rect.height < 1) {
		destroyRelayHost();
		return;
	}
	stopWatchdog();
	cancelRelayExit();
	h.host.style.pointerEvents = "none";
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
	if (reduced) {
		relayExit = h.host.animate([{ opacity: 1 }, { opacity: 0 }], {
			duration: MENU_FADE_MS,
			easing: "ease-out",
			fill: "forwards",
		});
	} else {
		const markX = h.rect.rtl
			? h.rect.x + MARK_INSET + 13
			: h.rect.x + h.rect.width - MARK_INSET - 13;
		const markY = h.rect.y + h.rect.height / 2;
		h.host.style.transformOrigin = `${markX - rect.left}px ${markY - rect.top}px`;
		const base = getComputedStyle(h.host).transform;
		const baseTransform = base && base !== "none" ? base : "";
		relayExit = h.host.animate(
			[
				{ transform: `${baseTransform} scale(1)`.trim(), opacity: 1 },
				{ transform: `${baseTransform} scale(0.02)`.trim(), opacity: 0 },
			],
			{ duration: MENU_COLLAPSE_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
		);
	}
	relayExit.onfinish = () => {
		// Same as picker.ts: release the fill-forwards end state. The host element is removed
		// below so today the stuck fill dies with it, but cancel anyway so a future reuse of
		// the host cannot inherit a collapsed animation.
		relayExit?.cancel();
		relayExit = null;
		destroyRelayHost();
	};
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
