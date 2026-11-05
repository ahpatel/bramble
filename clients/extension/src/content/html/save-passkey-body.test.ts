import { afterEach, describe, expect, it, vi } from "vitest";

// savePasskeyBody -> t() -> api.i18n.getMessage; stub chrome and (re)import per test.
async function loadSavePasskeyBody() {
	vi.resetModules();
	vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => k } });
	return (await import("./save-passkey-body")).savePasskeyBody;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

const base = {
	rpId: "ahpatel.cloudflareaccess.com",
	intent: "get" as const,
	primaryLabel: "passkeyUse",
};

describe("savePasskeyBody", () => {
	it("renders the no-match variant with the native handoff as the primary action", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			noMatch: true,
			nativeFallback: "pause",
		});
		expect(out).toContain("passkeyNoneTitle");
		expect(out).toContain("passkeyNoneNotePause"); // Chrome: says the page pauses
		expect(out).toContain('data-tp-action="passkey-native"');
		expect(out).toContain('class="tp-btn tp-btn-primary" data-tp-action="passkey-native"'); // the primary, not an escape hatch
		expect(out).not.toContain('data-tp-action="passkey-approve"'); // nothing to confirm: no Bramble passkey exists
		expect(out).toContain('data-tp-action="passkey-dismiss"'); // "Not now" stays
		expect(out).toContain('id="tp-remember-site"'); // opt into the automatic pause
		expect(out).toContain("passkeyRememberSite");
	});

	it("labels the no-match note for passthrough where the delivery can relay", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			noMatch: true,
			nativeFallback: "passthrough",
		});
		expect(out).toContain("passkeyNoneNotePassthrough");
		expect(out).not.toContain("passkeyNoneNotePause");
	});

	it("keeps the ordinary confirm card and offers the explicit bypass action", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			intent: "create",
			nativeFallback: "pause",
		});
		expect(out).toContain('data-tp-action="passkey-approve"'); // the primary stays Bramble
		expect(out).toContain('data-tp-action="passkey-dismiss"'); // "Not now" is a plain decline
		expect(out).toContain("passkeyDeclineNotePause"); // the bypass note
		expect(out).toContain('class="tp-bypass" data-tp-action="passkey-native"'); // the explicit handoff
		expect(out).toContain('id="tp-remember-site"'); // opt into the automatic pause
	});

	it("labels the bypass note for passthrough where the delivery can relay", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			intent: "create",
			nativeFallback: "passthrough",
		});
		expect(out).toContain("passkeyDeclineNotePassthrough");
		expect(out).not.toContain("passkeyDeclineNotePause");
	});

	it("omits the bypass note and action when the delivery cannot offer a handoff", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({ ...base, intent: "create" });
		expect(out).not.toContain("passkeyDeclineNotePause");
		expect(out).not.toContain("passkeyDeclineNotePassthrough");
		expect(out).not.toContain("passkey-native");
		expect(out).not.toContain('id="tp-remember-site"');
	});

	it("renders account rows as real markup in the picker", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			passkeyChoices: [
				{ credentialId: "Q0lE", label: "octocat" },
				{ credentialId: "T1RI", label: "octo2" },
			],
		});
		expect(out).toContain('data-tp-action="passkey-pick" data-tp-value="Q0lE"');
		expect(out).toContain('data-tp-action="passkey-pick" data-tp-value="T1RI"');
		expect(out).not.toContain("&lt;button");
	});
});

describe("savePasskeyBody: who is asking", () => {
	const askingBase = { rpId: "example.com", intent: "get" as const, primaryLabel: "Use" };

	// The card renders on the focused page; a request from anywhere else must say where.
	it("names a requester that isn't the page the card is on", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...askingBase,
			requester: "evil.example.com",
			pageHost: "www.example.com",
		});
		expect(out).toContain("passkeyRequestedBy");
		expect(out).toContain("evil.example.com");
	});

	it("adds nothing when the page itself is asking", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...askingBase,
			requester: "www.example.com",
			pageHost: "www.example.com",
		});
		expect(out).not.toContain("passkeyRequestedBy");
	});
});
