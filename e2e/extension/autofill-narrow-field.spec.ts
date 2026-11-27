import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup } from "./helpers";

// A small-width user/password form (the old table layout with size="8" inputs). The pattern is
// the narrow field, not the site: the mark has to overlap the text rather than hide.
const NARROW_LOGIN = `<!doctype html><html><head><title>narrow login</title></head><body>
<table cellspacing="0" cellpadding="0" width="100%">
<tr><td bgcolor="#993366" valign="top" align="center">
<form name="loginform" action="https://example.com/index.pl" method="post">
<table border="0" cellspacing="0" cellpadding="2">
<tr><td colspan="3">log in</td></tr>
<tr><td align="right">user </td>
	<td><input tabindex="1" type="text" name="user" size="8"></td>
	<td rowspan="2" valign="middle" align="center">
		<input tabindex="3" type="submit" value="go">
	</td>
</tr>
<tr><td align="right">pass </td>
	<td><input tabindex="2" type="password" name="pass" size="8"></td>
</tr>
</table>
</form>
<form name="newuserform" action="https://example.com/index.pl" method="post">
<table><tr><td>newuser</td><td><input tabindex="4" type="text" name="newuser" size="8" maxlength="20"></td></tr>
<tr><td>email</td><td><input tabindex="5" type="text" name="realemail" value="" size="8"></td></tr></table>
</form>
</td></tr></table>
<script>document.loginform.user.focus();</script>
</body></html>`;

const markHost = (page: Page) => page.locator('div[id^="bmk-"]');
const pickerFrame = (page: Page): Frame | undefined =>
	page.frames().find((f) => f.url().includes("autofill-ui.html"));

async function clickMarkAt(page: Page, selector: string): Promise<void> {
	const field = page.locator(selector);
	await field.focus();
	await expect(markHost(page)).toHaveCount(1, { timeout: 10_000 });
	const box = await field.boundingBox();
	expect(box).not.toBeNull();
	const inset = await markHost(page).evaluate(
		(el) => Number.parseFloat(getComputedStyle(el).getPropertyValue("--mark-inset")) || 30,
	);
	await page.mouse.click(box!.x + box!.width - inset - 13, box!.y + box!.height / 2);
}

test("the mark opens and reopens on narrow user/password boxes", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Narrow login");
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill("https://example.com");
	await popup.getByLabel("Username or email", { exact: true }).fill("alice");
	await popup.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByRole("button", { name: /Open Narrow login/ })).toBeVisible();
	await popup.evaluate(() => chrome.storage.local.set({ "pref.autofillTrigger": "icon" }));

	const page = await context.newPage();
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: NARROW_LOGIN, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
	await page.goto("https://example.com/index.pl");
	await clickMarkAt(page, 'input[name="user"]');
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	await expect(pickerFrame(page)!.locator("[data-entry-id]")).toHaveCount(1, {
		timeout: 10_000,
	});
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const h = document.querySelector("div[id^='tp-']");
					return h ? h.getBoundingClientRect().height : 0;
				}),
			{ timeout: 10_000 },
		)
		.toBeGreaterThan(40);

	// Dismiss, then reopen. The reopened menu must come back at its real height.
	await page.mouse.click(5, 5);
	await expect
		.poll(
			() =>
				page.evaluate(
					() => document.querySelector<HTMLElement>("div[id^='tp-']")?.style.display ?? "gone",
				),
			{ timeout: 10_000 },
		)
		.toBe("none");
	await clickMarkAt(page, 'input[name="user"]');
	await expect(pickerFrame(page)!.locator("[data-entry-id]")).toHaveCount(1, {
		timeout: 10_000,
	});
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const h = document.querySelector("div[id^='tp-']");
					return h ? h.getBoundingClientRect().height : 0;
				}),
			{ timeout: 10_000 },
		)
		.toBeGreaterThan(40);
});
