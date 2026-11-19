/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The affordance keeps module-level singleton state (one host, one rAF tracker, timers), so each
// test imports a fresh copy. The shadow root is closed on purpose; `__shadowRootForTest` is the
// only way in, and it is what lets these tests see the mark/ghost/HUD at all.
const h = vi.hoisted(() => ({
	teardown: null as (() => void) | null,
	hintShown: 0,
}));

vi.mock("./content-api", () => ({
	api: { runtime: { getURL: () => "chrome-extension://test/autofill-ui.html" } },
}));
vi.mock("./detection", () => ({ anchorIsLive: () => true }));
vi.mock("./i18n", () => ({
	t: (key: string) => (key === "enterKey" ? "Enter" : key),
}));
vi.mock("./lifecycle", () => ({
	onTeardown: (cb: () => void) => {
		h.teardown = cb;
	},
}));

type Module = typeof import("./affordance");
let mod: Module;

const FIELD_BOX = {
	left: 10,
	top: 20,
	width: 200,
	height: 40,
	right: 210,
	bottom: 60,
	x: 10,
	y: 20,
	toJSON: () => ({}),
} as DOMRect;

function input(): HTMLInputElement {
	const el = document.createElement("input");
	el.type = "text";
	document.body.appendChild(el);
	return el;
}

function root(): ShadowRoot {
	const r = mod.__shadowRootForTest();
	if (!r) throw new Error("affordance host was not created");
	return r;
}

function part<T extends Element>(selector: string): T {
	const el = root().querySelector<T>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
}

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	document.body.innerHTML = "";
	h.teardown = null;
	h.hintShown = 0;
	// jsdom has no layout. The field answers with a real box; every mirror span measures 20px so
	// the completion fits inside the field.
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		if (this.tagName === "INPUT") return FIELD_BOX;
		// host-offset.ts's 0x0 probe sits on the containing block's origin, so it answers 0,0.
		const el = this as HTMLElement;
		if (el.style?.position === "absolute" && el.style.width === "0px") {
			return {
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				width: 0,
				height: 0,
				toJSON: () => ({}),
			} as DOMRect;
		}
		return { ...FIELD_BOX, width: 20, right: 30, toJSON: () => ({}) } as DOMRect;
	});
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", () => {});
	mod = await import("./affordance");
	mod.affordance.onHintShown(() => {
		h.hintShown += 1;
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("affordance: the in-field mark", () => {
	it("pins a closed shadow host to the field's box", () => {
		const field = input();
		mod.affordance.show(field);

		const shadow = root();
		const host = shadow.host as HTMLElement;
		// Closed: the page gets null, which is what keeps the completion and entry name unreadable.
		expect(host.shadowRoot).toBeNull();
		expect(host.style.display).toBe("block");
		expect(host.style.transform).toBe("translate3d(10px, 20px, 0)");
		expect(host.style.width).toBe("200px");
		expect(host.style.height).toBe("40px");
		expect(part(".mark")).toBeTruthy();
		expect(part(".enter-key").textContent).toBe("Enter");
		expect(mod.affordance.visibleFor()).toBe(field);
		expect(mod.affordance.ownsNode(host)).toBe(true);
		expect(mod.affordance.ownsNode(document.body)).toBe(false);
	});

	it("draws the number of entries inside the berry, capped at 9+", () => {
		const field = input();
		mod.affordance.show(field, { count: 3 });
		expect(part(".count").textContent).toBe("3");

		mod.affordance.show(field, { count: 12 });
		expect(part(".count").textContent).toBe("9+");

		// A suggestion/alias or a locked vault has no entry count, so the berry stays plain.
		mod.affordance.show(field, { count: 0 });
		expect(part(".count").textContent).toBe("");
	});

	it("reports the mark's rect for the collapse animation, and null when it is not drawn", () => {
		const field = input();
		mod.affordance.show(field);
		expect(mod.affordance.markRect()).not.toBeNull();

		mod.affordance.setMarkAllowed(false);
		expect(mod.affordance.markRect()).toBeNull();
	});

	it("shows the one-time hint and reports it once", () => {
		const field = input();
		mod.affordance.show(field, { hint: "Saved logins for this site" });

		expect(part(".hint").classList.contains("show")).toBe(true);
		expect(part(".hint-text").textContent).toBe("Saved logins for this site");
		expect(h.hintShown).toBe(1);

		vi.advanceTimersByTime(5000);
		expect(part(".hint").classList.contains("show")).toBe(false);
	});

	it("hides the mark and the completion in shortcut-only mode", () => {
		const field = input();
		mod.affordance.show(field);
		mod.affordance.setMarkAllowed(false);

		const host = root().host as HTMLElement;
		expect(host.style.display).toBe("none");
		expect(mod.affordance.visibleFor()).toBeNull();
	});

	it("removes its host on teardown", () => {
		const field = input();
		mod.affordance.show(field);
		const host = root().host as HTMLElement;
		h.teardown?.();
		expect(host.isConnected).toBe(false);
	});
});

describe("affordance: the username completion", () => {
	it("paints the remainder after the typed text and clears it", () => {
		const field = input();
		field.value = "alice";
		mod.affordance.show(field);
		mod.affordance.preview(field, "example.com");

		const ghost = part(".ghost");
		expect(ghost.classList.contains("show")).toBe(true);
		expect(ghost.textContent).toBe("example.com");
		expect(part(".enter-key").classList.contains("show")).toBe(true);

		mod.affordance.clearPreview();
		expect(ghost.classList.contains("show")).toBe(false);
		expect(ghost.textContent).toBe("");
		expect(part(".enter-key").classList.contains("show")).toBe(false);
	});

	it("draws nothing for a field other than the visible one", () => {
		const field = input();
		const other = input();
		mod.affordance.show(field);
		mod.affordance.preview(other, "example.com");
		expect(part(".ghost").classList.contains("show")).toBe(false);
	});
});

describe("affordance: the pick chip", () => {
	it("reports a cycle as a language-neutral counter plus the entry name", () => {
		const field = input();
		mod.affordance.flash(field, "Work account", "2/3");

		expect(part(".pick").classList.contains("show")).toBe(true);
		expect(part(".pick-n").textContent).toBe("2/3");
		expect(part(".pick-name").textContent).toBe("Work account");

		vi.advanceTimersByTime(5000);
		expect(part(".pick").classList.contains("show")).toBe(false);
	});

	it("leaves the counter blank for a plain confirmation", () => {
		const field = input();
		mod.affordance.flash(field, "Work account");
		expect(part(".pick-n").textContent).toBe("");
		expect(part(".pick-name").textContent).toBe("Work account");
	});

	it("still shows the chip in shortcut-only mode, then tears the invisible host down", () => {
		const field = input();
		mod.affordance.setMarkAllowed(false);
		mod.affordance.flash(field, "Work account", "1/2");

		const host = root().host as HTMLElement;
		expect(part(".pick").classList.contains("show")).toBe(true);
		expect(host.classList.contains("no-mark")).toBe(true);

		vi.advanceTimersByTime(5000);
		expect(host.style.display).toBe("none");
	});
});

describe("RTL", () => {
	it("mirrors the chip slide and the mark zone", () => {
		const el = input();
		el.style.direction = "rtl";
		mod.affordance.show(el, { count: 1 });
		const host = document.querySelector<HTMLElement>('div[id^="bmk-"]')!;
		expect(host.style.getPropertyValue("--pick-shift")).toBe("-100%");
		// The mark sits at the inline end: the left edge in RTL.
		expect(mod.affordance.isMarkZone(el, FIELD_BOX.left + 30 + 13, FIELD_BOX.top + 20)).toBe(true);
		expect(mod.affordance.isMarkZone(el, FIELD_BOX.right - 30 - 13, FIELD_BOX.top + 20)).toBe(
			false,
		);
	});
});
