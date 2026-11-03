/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The corner card's click path. Its buttons act on captured credentials and, since the
// decline-is-a-handoff change, persistently turn the provider off, so a page script must
// never be able to act on them. The closed shadow root is the primary defense; the
// handler's isTrusted gate is the second layer, and the legibility/early-click guard stops
// a page covering or fading the card under the cursor. See docs/passkey-provider.md.

const h = vi.hoisted(() => ({ legible: true, sent: [] as unknown[] }));

vi.mock("./legibility", () => ({ EARLY_CLICK_MS: 500, isLegible: () => h.legible }));
vi.mock("./lifecycle", () => ({
	safeSendMessage: (m: unknown) => h.sent.push(m),
	isExtensionAlive: () => true,
	markExtensionDead: vi.fn(),
	onTeardown: vi.fn(),
}));
vi.mock("./content-api", () => ({ api: { runtime: { sendMessage: vi.fn() } } }));
vi.mock("./i18n", () => ({ t: (key: string) => key }));

// Reach inside the closed shadow root the way picker.dom.test.ts does: capture the
// created roots, and the click listeners attached to them.
const shadows = new Map<Element, ShadowRoot>();
const clickHandlers = new Map<EventTarget, EventListener>();
const attach = Element.prototype.attachShadow;
const addEventListener = EventTarget.prototype.addEventListener;
vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
	this: Element,
	init: ShadowRootInit,
) {
	const root = attach.call(this, init);
	shadows.set(this, root);
	return root;
});
vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
	this: EventTarget,
	type: string,
	fn: EventListenerOrEventListenerObject | null,
	opts?: boolean | AddEventListenerOptions,
) {
	if (type === "click" && typeof fn === "function") clickHandlers.set(this, fn);
	return addEventListener.call(this, type, fn, opts);
});

const { handleCornerPromptShow } = await import("./corner-prompt");

/** jsdom marks no event trusted, so hand the listener a stand-in that is (or is not). */
function clickEvent(target: Element, trusted: boolean): Event {
	const inner = new MouseEvent("click", { bubbles: true, composed: true });
	return new Proxy(inner, {
		get(event, property) {
			if (property === "isTrusted") return trusted;
			if (property === "target") return target;
			const value = Reflect.get(event, property, event);
			return typeof value === "function" ? value.bind(event) : value;
		},
	});
}

/** Mount a passkey card; return its click listener and the button for `action`. */
function mount(
	action: string,
	prompt: Record<string, unknown> = {},
): { click: EventListener; button: HTMLElement } {
	handleCornerPromptShow({
		kind: "save-passkey",
		promptId: "p1",
		hostname: "example.com",
		locked: false,
		intent: "get",
		rpId: "example.com",
		...prompt,
	});
	const host = document.getElementById("bramble-corner-prompt");
	const shadow = host ? shadows.get(host) : undefined;
	const click = shadow ? clickHandlers.get(shadow) : undefined;
	const button = shadow?.querySelector<HTMLElement>(`[data-tp-action="${action}"]`);
	if (!click || !button) throw new Error("the card never mounted");
	return { click, button };
}

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = "";
	shadows.clear();
	clickHandlers.clear();
	h.legible = true;
	h.sent = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("corner card clicks", () => {
	it("acts on a real click: the no-match handoff replies declined with the native sentinel", () => {
		const { click, button } = mount("passkey-native", { noMatch: true, nativeFallback: "disable" });
		vi.advanceTimersByTime(600);
		click(clickEvent(button, true));
		expect(h.sent).toEqual([
			{
				type: "PASSKEY_PROMPT_RESPONSE",
				payload: { promptId: "p1", approved: false, choice: "native" },
			},
		]);
	});

	it("ignores a synthetic click: a page script must not be able to act on the card", () => {
		const { click, button } = mount("passkey-native", { noMatch: true, nativeFallback: "disable" });
		vi.advanceTimersByTime(600);
		click(clickEvent(button, false));
		expect(h.sent).toEqual([]);
	});

	it("ignores an approve on a card the page has hidden or covered", () => {
		const { click, button } = mount("passkey-approve", { intent: "create" });
		vi.advanceTimersByTime(1000);
		h.legible = false;
		click(clickEvent(button, true));
		expect(h.sent).toEqual([]);
		expect(document.getElementById("bramble-corner-prompt")).not.toBeNull();
	});

	it("ignores an approve in the first moments after the card appears", () => {
		const { click, button } = mount("passkey-approve", { intent: "create" });
		click(clickEvent(button, true));
		expect(h.sent).toEqual([]);

		vi.advanceTimersByTime(600);
		click(clickEvent(button, true));
		expect(h.sent).toEqual([
			{ type: "PASSKEY_PROMPT_RESPONSE", payload: { promptId: "p1", approved: true } },
		]);
	});
});
