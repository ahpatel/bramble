import type { Page } from "@playwright/test";
import { addLogin, lock, popupUrl, unlock } from "../extension/helpers";
import {
	back,
	CONFLICT,
	type Edit,
	editEntry,
	expectCombined,
	expectConflict,
	keepShown,
	openEntry,
	saveForm,
} from "./entry-edits";
import {
	createVault,
	expect,
	gotoSync,
	type Peer,
	PW,
	RELAY_URL,
	reopenMobile,
	test,
} from "./fixtures";

// Two devices editing one login before they sync (docs/sync-conflicts.md), through the real UI of
// both peers. The same spec runs with combining off (`pnpm test:e2e:sync`, what ships until B2)
// and on (`pnpm test:e2e:sync:combine`): edits to different fields conflict with it off and
// combine with it on; edits to the same field conflict either way.

const COMBINING = process.env.COMBINE_CONCURRENT_EDITS === "1";
const LOCAL_RELAY_HOST = "localhost:7400";
const NAME = "Shared login";

/** Point this peer's sync at the local relay, via the Advanced panel a user would use. */
async function useLocalRelay(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Advanced/i }).click();
	await page.getByLabel(/Nostr relay URL/i).fill(RELAY_URL);
	await page.getByLabel(/TURN \/ ICE servers URL/i).fill("");
}

/** Run the inviter flow and return the pairing code. */
async function invite(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^Add a device$/i })
		.last()
		.click();
	await page.locator('input[type="password"]').first().fill(PW);
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	const codeField = page.locator("input[readonly]");
	await expect(codeField).toBeVisible();
	return codeField.inputValue();
}

/** Pair the two peers over the local relay, then share one login between them. */
async function pairWithSharedLogin(ext: Peer & { extensionId: string }, mobile: Peer) {
	await createVault(ext.page);
	await ext.page.goto(popupUrl(ext.extensionId));
	await expect(ext.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	await gotoSync(ext.page);
	await useLocalRelay(ext.page);

	const code = await invite(ext.page);
	const decoded = JSON.parse(
		Buffer.from(code.replace("bramble-pair-1.", ""), "base64").toString("utf8"),
	) as { relay: string };
	expect(decoded.relay, "the pairing code must name the local relay").toContain(LOCAL_RELAY_HOST);

	await mobile.page.getByRole("button", { name: /Create your vault/i }).click();
	await mobile.page.getByRole("button", { name: /Join a device/i }).click();
	const paste = mobile.page.getByRole("button", { name: /Paste code instead/i });
	if (await paste.isVisible().catch(() => false)) await paste.click();
	await mobile.page.getByPlaceholder(/Paste the code from your other device/i).fill(code);
	await mobile.page.getByLabel(/Master password/i).fill(PW);
	await mobile.page.getByRole("button", { name: /Join vault/i }).click();
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	await expect(mobile.page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible({
		timeout: 90_000,
	});

	await back(ext.page);
	await addLogin(ext.page, NAME);
	await expect(mobile.page.getByText(NAME)).toBeVisible({ timeout: 90_000 });
}

/**
 * Each device edits the login while the other can't hear it, then both come back. The phone's
 * page closes while the extension edits and locks (locking stops its sync); the phone returns
 * and edits while the extension is still locked; then the extension unlocks.
 */
async function editApart(
	ext: Peer & { extensionId: string },
	mobile: Peer,
	extEdit: Edit,
	mobileEdit: Edit,
): Promise<void> {
	await mobile.page.close();
	await editEntry(ext.page, NAME, extEdit);
	await lock(ext.page);
	await reopenMobile(mobile);
	await unlock(mobile.page, PW);
	await editEntry(mobile.page, NAME, mobileEdit);
	await unlock(ext.page, PW);
}

test("edits to different fields made apart", async ({ ext, mobile }) => {
	await pairWithSharedLogin(ext, mobile);
	await editApart(ext, mobile, { username: "from-the-laptop" }, { notes: "from the phone" });
	const both = [ext.page, mobile.page];
	if (COMBINING) await expectCombined(both, NAME, ["from-the-laptop", "from the phone"]);
	else await expectConflict(both, NAME);
});

test("edits to the same field made apart conflict, and resolving on one settles both", async ({
	ext,
	mobile,
}) => {
	await pairWithSharedLogin(ext, mobile);
	await editApart(ext, mobile, { notes: "laptop notes" }, { notes: "phone notes" });
	await expectConflict([ext.page, mobile.page], NAME);

	const kept = await keepShown(ext.page, NAME, ["laptop notes", "phone notes"]);
	const dropped = kept === "laptop notes" ? "phone notes" : "laptop notes";
	await openEntry(mobile.page, NAME);
	await expect(mobile.page.getByText(CONFLICT)).toBeHidden({ timeout: 90_000 });
	await expect(mobile.page.getByText(kept)).toBeVisible();
	await expect(mobile.page.getByText(dropped)).toBeHidden();
});

test("an edit form saved after a change synced in doesn't overwrite it", async ({
	ext,
	mobile,
}) => {
	await pairWithSharedLogin(ext, mobile);
	await openEntry(ext.page, NAME);
	await ext.page.getByRole("button", { name: "Edit entry" }).click();

	await editEntry(mobile.page, NAME, { notes: "from the phone" });
	// Wait until the change has reached the extension, in a second view of it.
	const watcher = await ext.context.newPage();
	await watcher.goto(popupUrl(ext.extensionId));
	await openEntry(watcher, NAME);
	await expect(watcher.getByText("from the phone")).toBeVisible({ timeout: 90_000 });
	await watcher.close();

	await saveForm(ext.page, { username: "from-the-laptop" });
	const both = [ext.page, mobile.page];
	if (COMBINING) await expectCombined(both, NAME, ["from-the-laptop", "from the phone"]);
	else await expectConflict(both, NAME);
});
