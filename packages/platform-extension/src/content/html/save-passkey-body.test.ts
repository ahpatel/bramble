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
			nativeFallback: "disable",
		});
		expect(out).toContain("passkeyNoneTitle");
		expect(out).toContain("passkeyNoneNoteDisable"); // Chrome: says the provider turns off
		expect(out).toContain('data-tp-action="passkey-native"');
		expect(out).toContain('class="tp-btn tp-btn-primary" data-tp-action="passkey-native"'); // the primary, not an escape hatch
		expect(out).not.toContain('data-tp-action="passkey-approve"'); // nothing to confirm: no Bramble passkey exists
		expect(out).toContain('data-tp-action="passkey-dismiss"'); // "Not now" stays
	});

	it("labels the no-match note for passthrough where the delivery can relay", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			noMatch: true,
			nativeFallback: "passthrough",
		});
		expect(out).toContain("passkeyNoneNotePassthrough");
		expect(out).not.toContain("passkeyNoneNoteDisable");
	});

	it("keeps the ordinary confirm card, plus the note saying what a refusal does", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			intent: "create",
			nativeFallback: "disable",
		});
		expect(out).toContain('data-tp-action="passkey-approve"'); // the primary stays Bramble
		expect(out).toContain('data-tp-action="passkey-dismiss"'); // "Not now", which now hands off
		expect(out).toContain("passkeyDeclineNoteDisable"); // the note says what declining does
		expect(out).not.toContain("passkey-native"); // no separate native button anymore
	});

	it("labels the refusal note for passthrough where the delivery can relay", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({
			...base,
			intent: "create",
			nativeFallback: "passthrough",
		});
		expect(out).toContain("passkeyDeclineNotePassthrough");
		expect(out).not.toContain("passkeyDeclineNoteDisable");
	});

	it("omits the refusal note when the delivery cannot offer a handoff", async () => {
		const savePasskeyBody = await loadSavePasskeyBody();
		const out = savePasskeyBody({ ...base, intent: "create" });
		expect(out).not.toContain("passkeyDeclineNoteDisable");
		expect(out).not.toContain("passkeyDeclineNotePassthrough");
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
