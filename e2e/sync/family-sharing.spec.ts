import type { Locator, Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { optionsUrl, popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, RELAY_URL, test } from "./fixtures";

// The family-sharing loop on a real relay: the owner enables sharing, invites a
// member in person (QR code → paste), adds them to a collection, and shares an
// entry into it. The member joins with their OWN password (the owner's is never
// sent), sees exactly the shared entries, and the owner's private ones stay
// private. Removal rotates the collection keys and the member stops syncing.
//
// Both peers are real extension profiles over the local relay. The member-join
// path is the v2 one (ADR-0002): seals instead of the vault key.

async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	// The ICE endpoint derives from the relay; blank it so nothing reaches for the hosted one.
	await page.getByLabel(/Turn \/ ICE servers URL/i).fill("");
	// Settings persist on blur — no save button on this panel.
}

/** Open Settings → General (where the Family sharing section lives). */
async function gotoGeneral(page: Page): Promise<void> {
	const tab = page.getByRole("button", { name: "General", exact: true });
	if (!(await tab.isVisible().catch(() => false))) {
		await page.getByRole("button", { name: "Settings" }).click();
	}
	await tab.click();
	await expect(page.getByText(/Family sharing/i)).toBeVisible();
}

/** Enable sharing and create a named collection through the UI. */
async function enableSharingAndCreateCollection(page: Page, collection: string): Promise<void> {
	await gotoGeneral(page);
	await page.getByRole("button", { name: /Enable sharing/i }).click();
	// The enabled branch shows a "New collection" row whose button opens the form.
	await expect(page.getByText(/New collection/i)).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: "Create", exact: true }).first().click();
	await page.getByLabel(/Collection name/i).fill(collection);
	// The form's submit is the FIRST Create button (the row's sits after the list).
	await page.getByRole("button", { name: "Create", exact: true }).first().click();
	await expect(page.getByText(collection).first()).toBeVisible({ timeout: 30_000 });
}

/** Run the member-invite flow. Returns the pairing code; the panel STAYS OPEN —
 * the joiner needs the host alive, and the SAS approval happens there. */
async function inviteMember(page: Page, name: string): Promise<string> {
	const nameField = page.getByLabel(/Their name/i);
	await nameField.fill(name);
	await page.getByRole("button", { name: /^Invite$/i }).click();
	// The invite panel shows the pairing code as text once the host is up.
	const codeEl = page.getByTestId("invite-code");
	await expect(codeEl).toBeVisible({ timeout: 30_000 });
	const code = (await codeEl.textContent()) ?? "";
	expect(code).toContain("bramble-pair-1.");
	return code;
}

/** Add the (single) member to a collection via the inline picker in their row. */
async function addMemberToCollection(page: Page, collection: string): Promise<void> {
	const picker = page.getByRole("button", { name: /Add to collection/i });
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await picker.click();
	await page.getByRole("button", { name: collection }).click();
	await expect(page.getByText(/1 collection\(s\)/i)).toBeVisible({ timeout: 30_000 });
}

/** Share an entry into a collection: selection mode from the list header, tick
 * the row, run the Share bulk action, pick the collection, confirm. */
async function shareEntry(page: Page, entryName: string, collection: string): Promise<void> {
	// The owner may still be in Settings (the grant happened there); back to the list.
	const goBack = page.getByRole("button", { name: "Go back" });
	if (await goBack.isVisible().catch(() => false)) await goBack.click();
	await page.getByRole("button", { name: "Select items" }).click();
	// The real input is sr-only; clicking the wrapping label toggles it.
	await page.locator(`label:has(input[type="checkbox"][aria-label="Select ${entryName}"])`).click();
	await page.getByRole("button", { name: "Actions" }).click();
	// Case-sensitive so "Unshare…" never matches.
	await page.getByRole("menuitem", { name: /Share/ }).click();
	await page.getByRole("button", { name: collection }).click();
	await page.getByRole("button", { name: /Share 1 entry/ }).click();
	// The dialog closes when the action finishes.
	await expect(page.getByRole("button", { name: /Share 1 entry/ })).toBeHidden({
		timeout: 60_000,
	});
}

/** The member's join flow UP TO the SAS gate: the setup shell, member mode, own
 * password, then "Join vault". Returns the member's SAS display so the caller can
 * compare it against the owner's before approving. */
async function startMemberJoin(page: Page, code: string, password: string): Promise<Locator> {
	await page.getByRole("button", { name: /Join a device/i }).click();
	await page.getByText(/I was invited as a family member/i).click();
	await page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await page.getByLabel(/Create your password/i).fill(password);
	await page.getByRole("button", { name: /Join vault/i }).click();
	// The joining screen shows the derived SAS once the handshake reaches the host.
	const sas = page.locator(".font-mono.tabular-nums");
	await expect(sas).toBeVisible({ timeout: 90_000 });
	return sas;
}

/** The owner's half of the SAS gate: the invite panel shows the approval prompt
 * with the same digits; compare, then approve. */
async function approveMember(page: Page, memberSas: Locator): Promise<void> {
	const prompt = page.getByText(/Confirm this code matches/i);
	await expect(prompt).toBeVisible({ timeout: 90_000 });
	const ownerSas = page.locator("span.font-mono.font-semibold");
	expect(await ownerSas.textContent()).toBe(await memberSas.textContent());
	await page.getByRole("button", { name: /^Approve$/ }).click();
}

test("family sharing: invite, scope, share, and revoke on a real relay", async ({ ext }) => {
	// --- owner: vault with one private and one shareable entry ---
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	const PRIVATE = `Private ${Date.now().toString(36)}`;
	const SHARED = `Shared ${Date.now().toString(36)}`;
	// Two logins through the real create-entry UI.
	for (const name of [PRIVATE, SHARED]) {
		await ext.page.getByRole("button", { name: /Add New/i }).click();
		await ext.page
			.getByRole("button", { name: /^Login/ })
			.first()
			.click();
		await ext.page.getByLabel(/^Name$/).fill(name);
		await ext.page.getByLabel(/Username or email/i).fill("octocat@example.com");
		await ext.page.getByRole("button", { name: /Save Login/i }).click();
		await expect(ext.page.getByText(name)).toBeVisible();
	}

	// --- enable sharing, create the collection, point sync at the local relay ---
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);
	await enableSharingAndCreateCollection(ext.page, "Dads banking");

	// --- invite the member ---
	await gotoGeneral(ext.page);
	const code = await inviteMember(ext.page, "Dad");
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay).toContain("localhost:7400");

	// --- the member: a second real extension profile, fresh "device" ---
	const memberContext = await launchExtensionContext();
	const memberPage = await memberContext.context.newPage();
	try {
		// First run, zero vaults: the setup shell opens directly in the options tab.
		await memberPage.goto(optionsUrl(memberContext.extensionId));
		const memberSas = await startMemberJoin(memberPage, code, "Member-Own-Pw-1!");

		// --- the SAS gate: nothing moves until the owner confirms the digits match ---
		await approveMember(ext.page, memberSas);

		// Transfer done: the options page shows the done screen; the popup opens
		// into the joined (still empty) vault.
		const popup = await memberContext.context.newPage();
		await expect(memberPage.getByText(/Open it from/i)).toBeVisible({ timeout: 120_000 });
		await popup.goto(popupUrl(memberContext.extensionId));
		await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
			timeout: 30_000,
		});

		// --- owner: add the member to the collection, share an entry into it ---
		await addMemberToCollection(ext.page, "Dads banking");
		await shareEntry(ext.page, SHARED, "Dads banking");

		// --- the member sees exactly the shared entry, nothing else ---
		await expect(popup.getByText(SHARED)).toBeVisible({ timeout: 120_000 });
		await expect(popup.getByText(PRIVATE)).toBeHidden();

		// --- owner removes the member: the honest copy is the confirm dialog itself ---
		await gotoGeneral(ext.page);
		let removeDialogText = "";
		ext.page.once("dialog", (dialog) => {
			removeDialogText = dialog.message();
			void dialog.accept();
		});
		await ext.page.getByRole("button", { name: /Remove member/i }).click();
		expect(removeDialogText).toContain("rotate the affected passwords");
		// Removal takes effect: the member row (and its Remove button) is gone.
		await expect(ext.page.getByRole("button", { name: /Remove member/i })).toBeHidden({
			timeout: 60_000,
		});
	} finally {
		await memberContext.context.close();
	}
});
