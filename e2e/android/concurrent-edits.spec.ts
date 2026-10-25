import { rmSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { addLogin, lock, optionsUrl, popupUrl, STRONG_PW, unlock } from "../extension/helpers";
import {
	type Edit,
	editEntry,
	expectCombined,
	expectConflict,
	keepShown,
	openEntry,
	saveForm,
} from "../sync/entry-edits";
import { adbReverse, attachApp, expect, stopApp, test } from "./fixtures";

// The concurrent-edit scenarios of e2e/sync/concurrent-edits.spec.ts with the real app on a device
// as one peer: the native crypto core, the Android storage adapter and the WebView's WebRTC, which
// a browser-hosted mobile app doesn't run (docs/sync-conflicts.md).
//
// COMBINE_CONCURRENT_EDITS=1 expects combining, for a device build and an extension build made
// with VITE_COMBINE_CONCURRENT_EDITS=1 (EXTENSION_DIR=dist-chromium-combine); otherwise conflicts.
//
// The phone is kept apart by force-stopping the app while the extension edits and locks (locking
// stops the extension's sync), then relaunching and editing it while the extension is still
// locked. This MUTATES the device: it joins a throwaway vault, deleted at the end; a failure
// part-way leaves it behind to clear by hand. The device's other vaults stay locked throughout.

const COMBINING = process.env.COMBINE_CONCURRENT_EDITS === "1";
// A click the WebView never lets through should fail here, not wait out the whole test.
test.use({ actionTimeout: 30_000 });
const RELAY = "ws://localhost:7400";
const APART = "Apart fields";
const SAME = "Same field";
const FORM = "Form after sync";

interface Inviter {
	context: BrowserContext;
	page: Page;
	extensionId: string;
	profileDir: string;
}

/** The extension: a vault holding the three logins, inviting a device over the local relay. */
async function invite(): Promise<{ inviter: Inviter; code: string }> {
	const { context, extensionId, profileDir } = await launchExtensionContext();
	const page = await context.newPage();
	await page.goto(optionsUrl(extensionId));
	await page.locator("#root").waitFor();
	const inviter = { context, page, extensionId, profileDir };

	const pw = page.locator('input[type="password"]');
	await pw.nth(0).fill(STRONG_PW);
	await pw.nth(1).fill(STRONG_PW);
	await page.getByRole("button", { name: "Create vault" }).click();
	await page.getByRole("button", { name: /I've saved it/i }).click();
	await page.goto(popupUrl(extensionId));
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	for (const name of [APART, SAME, FORM]) await addLogin(page, name);

	// After the vault exists: creating the first one drops sync.relay (see pair-with-extension).
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Sync", exact: true }).click();
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY);
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await page.locator('input[type="password"]').first().fill(STRONG_PW);
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	const code = await page.locator("input[readonly]").inputValue();
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay, "the code must name the local relay, not production").toBe(RELAY);
	return { inviter, code };
}

/** The device joins the inviter's vault from its picker, as a new vault of its own. */
async function join(device: Page, inviter: Page, code: string): Promise<void> {
	const picker = device.getByRole("heading", { name: /Choose a vault/i });
	const switchLink = device.getByRole("button", { name: /Choose a different vault/i });
	await expect(picker.or(switchLink).first()).toBeVisible();
	if (!(await picker.isVisible())) await switchLink.click();
	await device.getByRole("button", { name: /Create new vault/i }).click();
	await device.getByRole("button", { name: /Join a device/i }).click();
	const paste = device.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await device.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await device.getByLabel(/Master password/i).fill(STRONG_PW);
	await device.getByRole("button", { name: /Join vault/i }).click();
	await expect(inviter.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await inviter.getByRole("button", { name: /match, approve/i }).click();
	await expect(device.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});
}

test("concurrent edits between the extension and the app on a device", async () => {
	test.setTimeout(20 * 60_000);
	const stopReverse = adbReverse(7400);
	let app = await attachApp();
	let inviter: Inviter | undefined;
	let joined = false;

	/** Each side edits `name` while the other can't hear it, then both are back. */
	async function editApart(name: string, extEdit: Edit, deviceEdit: Edit): Promise<void> {
		if (!inviter) throw new Error("no inviter");
		await app.detach();
		stopApp();
		await editEntry(inviter.page, name, extEdit);
		await lock(inviter.page);
		app = await attachApp();
		// Relaunched on the vault it last had open: the throwaway one it joined.
		await unlock(app.page, STRONG_PW);
		await editEntry(app.page, name, deviceEdit);
		await unlock(inviter.page, STRONG_PW);
	}

	try {
		const invited = await invite();
		inviter = invited.inviter;
		await join(app.page, inviter.page, invited.code);
		joined = true;
		for (const name of [APART, SAME, FORM]) {
			await expect(app.page.getByText(name)).toBeVisible({ timeout: 90_000 });
		}
		await inviter.page
			.getByRole("button", { name: /^(Back|Go back)/i })
			.first()
			.click();

		const both = () => [inviter!.page, app.page];
		await test.step("different fields, made apart", async () => {
			await editApart(APART, { username: "from-the-laptop" }, { notes: "from the phone" });
			if (COMBINING) await expectCombined(both(), APART, ["from-the-laptop", "from the phone"]);
			else await expectConflict(both(), APART);
		});

		await test.step("the same field, made apart, then resolved", async () => {
			await editApart(SAME, { notes: "laptop notes" }, { notes: "phone notes" });
			await expectConflict(both(), SAME);
			const kept = await keepShown(inviter!.page, SAME, ["laptop notes", "phone notes"]);
			const dropped = kept === "laptop notes" ? "phone notes" : "laptop notes";
			await openEntry(app.page, SAME);
			await expect(async () => {
				const shown = await app.page.locator("#root").innerText();
				expect(shown).toContain(kept);
				expect(shown).not.toContain(dropped);
				expect(shown).not.toMatch(/changed on two devices/i);
			}).toPass({ timeout: 90_000 });
		});

		await test.step("an edit form saved after a change synced in", async () => {
			const ext = inviter!;
			await openEntry(ext.page, FORM);
			await ext.page.getByRole("button", { name: "Edit entry" }).click();
			await editEntry(app.page, FORM, { notes: "from the phone" });
			const watcher = await ext.context.newPage();
			await watcher.goto(popupUrl(ext.extensionId));
			await openEntry(watcher, FORM);
			await expect(watcher.getByText("from the phone")).toBeVisible({ timeout: 90_000 });
			await watcher.close();
			await saveForm(ext.page, { username: "from-the-laptop" });
			if (COMBINING) await expectCombined(both(), FORM, ["from-the-laptop", "from the phone"]);
			else await expectConflict(both(), FORM);
		});
	} finally {
		// Remove only the vault this test joined; it is the active one.
		if (joined) {
			try {
				const device = app.page;
				const lockButton = device.getByRole("button", { name: "Lock vault", exact: true });
				if (!(await lockButton.isVisible().catch(() => false))) await unlock(device, STRONG_PW);
				await device.getByRole("button", { name: "Settings" }).click();
				await device.getByRole("button", { name: "General", exact: true }).click();
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.first()
					.click();
				await device.getByLabel(/Master password/i).fill(STRONG_PW);
				await device
					.getByRole("button", { name: /Delete this vault/i })
					.last()
					.click();
				await expect(device.getByText(/Choose a vault|Welcome to Bramble/i).first()).toBeVisible();
			} catch {
				// Leave it rather than flailing: a stray vault named after the extension's is obvious.
			}
		}
		if (inviter) {
			await inviter.context.close();
			rmSync(inviter.profileDir, { recursive: true, force: true });
		}
		await app.detach().catch(() => {});
		stopReverse();
	}
});
