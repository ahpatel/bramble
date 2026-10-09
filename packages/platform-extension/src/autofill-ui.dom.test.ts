/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

// The picker document sits in the page's DOM, so `window.parent` is the page and anything
// arriving on it may be the page's own script (GHSA-mvjj-4qqq-xr7h). Only the port the content
// script hands over may drive it. See docs/autofill.md.

const PAGE_ORIGIN = "https://example.com";
const MATCH = { id: "entry-1", name: "Example", secondary: "user@example.com" };

Element.prototype.scrollIntoView = () => {};
history.replaceState(null, "", `/autofill-ui.html?parentOrigin=${encodeURIComponent(PAGE_ORIGIN)}`);
// jsdom's top window is its own parent, so this sees everything posted to the page.
const toPage: unknown[] = [];
vi.spyOn(window, "postMessage").mockImplementation(((m: unknown) => {
	toPage.push(m);
}) as typeof window.postMessage);
await import("./autofill-ui");

function fromPage(data: unknown, ports: MessagePort[] = []): void {
	const e = new MessageEvent("message", { data, origin: PAGE_ORIGIN, source: window });
	Object.defineProperty(e, "ports", { value: ports });
	window.dispatchEvent(e);
}

function connect(): { port: MessagePort; received: unknown[] } {
	const { port1, port2 } = new MessageChannel();
	const received: unknown[] = [];
	port1.onmessage = (e) => received.push(e.data);
	fromPage({ type: "UI_CONNECT" }, [port2]);
	return { port: port1, received };
}

describe("autofill-ui: who may drive the picker", () => {
	it("ignores rows and keys posted on the page window", async () => {
		fromPage({ type: "RENDER_MATCHES", matches: [MATCH] });
		fromPage({ type: "UI_KEY", key: "ArrowDown" });
		fromPage({ type: "UI_KEY", key: "Enter" });
		await new Promise((r) => setTimeout(r, 0));

		expect(toPage).not.toContainEqual(expect.objectContaining({ type: "UI_PICK" }));
		expect(document.querySelector("[data-entry-id]")).toBeNull();
	});

	it("takes rows and keys over the port it is handed, and answers there", async () => {
		const { port, received } = connect();
		port.postMessage({ type: "RENDER_MATCHES", matches: [MATCH] });
		port.postMessage({ type: "UI_KEY", key: "ArrowDown" });
		port.postMessage({ type: "UI_KEY", key: "Enter" });

		await vi.waitFor(() =>
			expect(received).toContainEqual({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false }),
		);
		expect(received[0]).toEqual({ type: "UI_CONNECTED" });
		expect(toPage).not.toContainEqual(expect.objectContaining({ type: "UI_PICK" }));
		port.close();
	});

	it("does not let a second port take the channel over", async () => {
		const { port, received } = connect();
		port.postMessage({ type: "RENDER_MATCHES", matches: [MATCH] });
		port.postMessage({ type: "UI_KEY", key: "ArrowDown" });
		port.postMessage({ type: "UI_KEY", key: "Enter" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([]);
		port.close();
	});
});
