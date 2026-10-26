import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, openPopup } from "./helpers";

// Issue #110: the Website URL field's "Use current site" button through the real extension shell.
// Playwright opens the popup as a tab, so a web page is put behind a detached pop-out instead,
// which reaches it the way create-unlock.spec.ts's float-to-top test does.

async function addLoginWithoutUrl(popup: Page) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Example Login");
	await popup.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText("Example Login")).toBeVisible();
}

async function openPopOut(context: BrowserContext, extensionId: string): Promise<Page> {
	const sw = await backgroundWorker(context);
	await sw.evaluate(async (id) => {
		await chrome.windows.create({
			url: `chrome-extension://${id}/popup.html?detached=1`,
			type: "popup",
			focused: true,
			width: 500,
			height: 600,
		});
	}, extensionId);
	await expect.poll(() => context.pages().some((p) => p.url().includes("detached=1"))).toBe(true);
	const popout = context.pages().find((p) => p.url().includes("detached=1"))!;
	await expect(popout.locator("#root")).not.toBeEmpty();
	return popout;
}

test("adds the page the user is on to an existing login, as its origin", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await addLoginWithoutUrl(popup);

	const site = await context.newPage();
	await context.route(/example\.com/, (r) =>
		r.fulfill({ body: "<h1>site</h1>", headers: { "content-type": "text/html" } }),
	);
	await site.goto("https://example.com/account/login?next=%2F");
	await site.bringToFront();

	const popout = await openPopOut(context, extensionId);
	await popout.getByText("Example Login").click();
	await popout.getByRole("button", { name: "Edit entry" }).click();
	await popout.getByRole("button", { name: /Add URL/i }).click();

	const field = popout.getByLabel("Website URL", { exact: true });
	const useSite = popout.getByRole("button", { name: "Use current site" });
	await expect(useSite).toHaveAttribute("title", "Use https://example.com");
	await useSite.click();
	// The origin, the same form a new login made on this page is seeded with.
	await expect(field).toHaveValue("https://example.com");
	await expect(useSite).toHaveCount(0);

	await popout.getByRole("button", { name: /Update Login/i }).click();
	await expect(popout.getByRole("button", { name: "Edit entry" })).toBeVisible();
	await expect(popout.getByText("https://example.com", { exact: true }).first()).toBeVisible();
});

test("offers nothing when the page in front is the extension's own", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await expect(popup.getByLabel("Website URL", { exact: true })).toHaveValue("");
	// The lookup is async; give it time to (not) produce a button.
	await popup.waitForTimeout(500);
	await expect(popup.getByRole("button", { name: "Use current site" })).toHaveCount(0);
});
