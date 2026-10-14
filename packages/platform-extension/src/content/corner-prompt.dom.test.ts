/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The corner card's click path. Its buttons act on captured credentials and, since the
// decline-is-a-handoff change, persistently turn the provider off, so a page script must
// never be able to act on them. The closed shadow root is the primary defense; the
// handler's isTrusted gate is the second layer, and this file is its regression test.

const safeSendMessage = vi.fn();
vi.mock("./lifecycle", () => ({
	safeSendMessage: (m: unknown) => safeSendMessage(m),
	isExtensionAlive: () => true,
	markExtensionDead: vi.fn(),
	onTeardown: vi.fn(),
}));
vi.mock("./i18n", () => ({ t: (key: string) => key }));

// content-api reads globalThis.chrome at import; set it before importing the module.
(globalThis as unknown as { chrome: unknown }).chrome = {
	runtime: {
		onMessage: { addListener: vi.fn() },
		sendMessage: vi.fn().mockResolvedValue({ ok: true, data: null }),
		getURL: (p: string) => p,
	},
};

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

/** Show the no-match passkey card; return its click listener and handoff button. */
function showNoMatchCard(): { click: EventListener; button: HTMLElement } {
	handleCornerPromptShow({
		kind: "save-passkey",
		promptId: "p1",
		hostname: "example.com",
		locked: false,
		intent: "get",
		rpId: "example.com",
		noMatch: true,
		nativeFallback: "disable",
	});
	const host = document.getElementById("bramble-corner-prompt");
	const shadow = host ? shadows.get(host) : undefined;
	const click = shadow ? clickHandlers.get(shadow) : undefined;
	const button = shadow?.querySelector<HTMLElement>('[data-tp-action="passkey-native"]');
	if (!click || !button) throw new Error("the card never mounted");
	return { click, button };
}

describe("corner card clicks", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		shadows.clear();
		clickHandlers.clear();
		safeSendMessage.mockClear();
	});

	it("acts on a real click: the no-match handoff replies declined with the native sentinel", () => {
		const { click, button } = showNoMatchCard();
		click(clickEvent(button, true));
		expect(safeSendMessage).toHaveBeenCalledWith({
			type: "PASSKEY_PROMPT_RESPONSE",
			payload: { promptId: "p1", approved: false, choice: "native" },
		});
	});

	it("ignores a synthetic click: a page script must not be able to act on the card", () => {
		const { click, button } = showNoMatchCard();
		click(clickEvent(button, false));
		expect(safeSendMessage).not.toHaveBeenCalled();
	});
});
