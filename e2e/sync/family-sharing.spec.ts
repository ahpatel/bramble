import type { Page } from "@playwright/test";
import { launchExtensionContext } from "../extension/fixtures";
import { popupUrl } from "../extension/helpers";
import { createVault, expect, gotoSync, PW, RELAY_URL, test } from "./fixtures";

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
	await page.getByRole("button", { name: /Save/i }).click();
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
	await expect(page.getByRole("button", { name: /Create/i }).first()).toBeVisible({
		timeout: 30_000,
	});
	await page.getByRole("button", { name: /New collection/i }).click();
	await page.getByLabel(/Collection name/i).fill(collection);
	await page.getByRole("button", { name: "Create", exact: true }).last().click();
	await expect(page.getByText(collection).first()).toBeVisible();
}

/** Run the member-invite flow and return the pairing code from the panel. */
async function inviteMember(page: Page, name: string): Promise<string> {
	const nameField = page.getByLabel(/Their name/i);
	await nameField.fill(name);
	await page.getByRole("button", { name: /^Invite$/i }).click();
	// The invite panel shows the pairing code as text once the host is up.
	const codeEl = page.getByTestId("invite-code");
	await expect(codeEl).toBeVisible({ timeout: 30_000 });
	const code = (await codeEl.textContent()) ?? "";
	expect(code).toContain("bramble-pair-1.");
	// Dismiss the panel so the session state settles before the member joins.
	await page.getByRole("button", { name: /Done/i }).click();
	return code;
}

/** Add the invited member to a collection through their row in the People list. */
async function addMemberToCollection(page: Page, name: string, collection: string): Promise<void> {
	const row = page
		.locator("div", { has: page.getByRole("button", { name: /Remove member/i }) })
		.filter({
			hasText: name,
		});
	await row.getByRole("button", { name: /Add to collection/i }).click();
	await row.getByRole("button", { name: collection }).click();
	await expect(page.getByText(/1 collection\(s\)/i)).toBeVisible({ timeout: 30_000 });
}

/** Share an entry into a collection via the bulk-action dialog. */
async function shareEntry(page: Page, entryName: string, collection: string): Promise<void> {
	const card = page.locator("div", { hasText: entryName }).first();
	await card.getByRole("checkbox").click();
	await page.getByRole("button", { name: /^Share/i }).click();
	await page.getByRole("button", { name: collection }).click();
	await page.getByRole("button", { name: /Share 1 entry/i }).click();
	await expect(page.getByText(/shared/i)).toBeVisible({ timeout: 30_000 });
}

/** The member's join flow: the setup shell, member mode, own password. */
async function joinAsMember(page: Page, code: string, password: string): Promise<void> {
	await page.getByRole("button", { name: /Join a device/i }).click();
	await page.getByText(/I was invited as a family member/i).click();
	await page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await page.getByLabel(/Create your password/i).fill(password);
	await page.getByRole("button", { name: /Join vault/i }).click();
	// Joined: the vault opens (empty — nothing shared yet).
	await page.getByRole("button", { name: /Add New/i }).waitFor({ timeout: 90_000 });
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

	// --- the member: a second real extension profile, fresh vault, own password ---
	const memberContext = await launchExtensionContext();
	const memberPage = await memberContext.context.newPage();
	await memberPage.goto(popupUrl(memberContext.extensionId));
	try {
		await createVault(memberPage, "Member-Own-Pw-1!");
		await joinAsMember(memberPage, code, "Member-Own-Pw-1!");
		await gotoGeneral(memberPage);

		// --- owner: add the member to the collection, share an entry into it ---
		await addMemberToCollection(ext.page, "Dad", "Dads banking");
		await shareEntry(ext.page, SHARED, "Dads banking");

		// --- the member sees exactly the shared entry, nothing else ---
		await expect(memberPage.getByText(SHARED)).toBeVisible({ timeout: 120_000 });
		await expect(memberPage.getByText(PRIVATE)).toBeHidden();

		// --- owner removes the member: rotation, and the honest copy shows ---
		await gotoGeneral(ext.page);
		await ext.page.getByRole("button", { name: /Remove member/i }).click();
		await expect(ext.page.getByText(/rotate the affected passwords/i)).toBeVisible();
		// Accepting the dialog removes them from the list.
		await ext.page.on("dialog", (dialog) => dialog.accept());
		await expect(ext.page.getByText(/0 collection/i)).toBeVisible({ timeout: 30_000 });
	} finally {
		await memberContext.context.close();
	}
});
