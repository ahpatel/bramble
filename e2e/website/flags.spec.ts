// Website feature flags (website/src/flags.ts): a flagged part of a page stays out of sight on the
// live site unless this tab asked for it with `?ff=`. The account page's Bitcoin and Monero
// buttons are behind `crypto`.

import { expect, type Page, test } from "@playwright/test";
import { mockServices } from "./mocks";

const card = (page: Page) => page.getByRole("button", { name: "Credit/Debit card" });
const coins = (page: Page) => [
	page.getByRole("button", { name: "Bitcoin", exact: true }),
	page.getByRole("button", { name: "Monero", exact: true }),
	page.getByText("A Bitcoin or Monero payment can't be refunded."),
];

const NUMBER = "11111 22222 33333 44444 55555";

test.beforeEach(async ({ context }) => {
	const services = await mockServices(context, NUMBER);
	services.status = () => ({
		code: 200,
		body: { paidThrough: Date.UTC(2027, 4, 2), frozen: false, usedBytes: 0, quotaBytes: 1e9 },
	});
});

/** The account page with an account open, so the payment buttons are on screen. */
async function openAccount(page: Page, query = "") {
	await page.goto(`/account/${query}#n=${NUMBER.replace(/ /g, "")}`);
	// A tab that confirmed the number once remembers it, and doesn't ask again.
	const mine = page.getByRole("button", { name: "Yes, it's mine" });
	await expect(card(page).or(mine)).toBeVisible();
	if (await mine.isVisible()) await mine.click();
	await expect(card(page)).toBeVisible();
}

const cryptoHidden = async (page: Page) => {
	for (const part of coins(page)) await expect(part).toBeHidden();
};
const cryptoShown = async (page: Page) => {
	for (const part of coins(page)) await expect(part).toBeVisible();
};

test("the account page is public, and pays by card without the flag", async ({ page }) => {
	await openAccount(page);
	await cryptoHidden(page);
});

test("the flag shows the flagged parts, and the tab keeps it", async ({ page }) => {
	await openAccount(page, "?ff=crypto");
	await cryptoShown(page);
	await openAccount(page);
	await cryptoShown(page);
});

test("any page takes the flag", async ({ page }) => {
	await page.goto("/?ff=crypto");
	await openAccount(page);
	await cryptoShown(page);
});

test("another tab doesn't have it", async ({ context, page }) => {
	await openAccount(page, "?ff=crypto");
	await cryptoShown(page);
	const other = await context.newPage();
	await openAccount(other);
	await cryptoHidden(other);
});

test("an empty value turns it off, and an unknown name does nothing", async ({ page }) => {
	await openAccount(page, "?ff=crypto");
	await page.goto("/?ff=");
	await openAccount(page);
	await cryptoHidden(page);
	await openAccount(page, "?ff=nope");
	await cryptoHidden(page);
});

test("a page with no flag is left alone, and asks to be indexed", async ({ page }) => {
	await page.goto("/account/");
	await expect(page).toHaveURL(/\/account\/$/);
	await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});
