import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	openPopup,
	seedExampleLogin,
	waitOutPickerClickGuard,
} from "./helpers";

// The trigger setting (Settings -> General -> Show saved logins): the list can open on focus
// (the default), from a small mark inside the field, or only from the browser command. The
// mark and the command are the two paths this file drives in a real browser.

const LOGIN = `<!doctype html><html><head><title>login</title></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

async function serveLogin(context: BrowserContext): Promise<void> {
	await context.route(/example\.com/, (route) =>
		route.request().resourceType() === "document"
			? route.fulfill({ body: LOGIN, headers: { "content-type": "text/html" } })
			: route.fulfill({ status: 200, body: "" }),
	);
}

async function setTrigger(popup: Page, value: "auto" | "icon" | "shortcut"): Promise<void> {
	await popup.getByRole("button", { name: "Settings", exact: true }).click();
	await popup.getByLabel("Open with").selectOption(value);
	await expect
		.poll(() =>
			popup.evaluate(async () => {
				const got = await chrome.storage.local.get("pref.autofillTrigger");
				return got["pref.autofillTrigger"];
			}),
		)
		.toBe(value);
}

function pickerFrame(page: Page): Frame | undefined {
	return page.frames().find((frame) => frame.url().includes("autofill-ui.html"));
}

async function waitForPickerFrame(page: Page): Promise<Frame> {
	let frame: Frame | undefined;
	await expect
		.poll(() => {
			frame = pickerFrame(page);
			return !!frame;
		})
		.toBe(true);
	return frame as Frame;
}

test("icon mode keeps the list closed until the mark is clicked, then fills", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");
	await popup.close();

	await serveLogin(context);
	const page = await context.newPage();
	await page.goto("https://example.com/");
	await page.locator("#user").click();

	// Focus reveals the mark, not the list.
	const icon = page.locator('div[id^="tp-i-"]');
	await expect(icon).toBeAttached({ timeout: 10_000 });
	expect(pickerFrame(page)).toBeUndefined();

	const box = await icon.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

	const frame = await waitForPickerFrame(page);
	const row = frame.locator("[data-entry-id]");
	await expect(row).toContainText("alice@example.com");

	await waitOutPickerClickGuard(page);
	await row.click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

// The browser command itself cannot be synthesized by a page (and Playwright's key press does
// not reach the browser's extension-shortcut layer), so the last leg is driven the way the
// background delivers it: a runtime message to the active tab. The command's own handler is
// covered by the background unit tests.
test("shortcut mode stays closed until the cycle message, then Enter fills", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "shortcut");
	await popup.close();

	await serveLogin(context);
	const page = await context.newPage();
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await page.waitForTimeout(300);
	await expect(page.locator('div[id^="tp-i-"]')).toHaveCount(0);
	expect(pickerFrame(page)).toBeUndefined();

	const sw = await backgroundWorker(context);
	const tabId = await sw.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: "https://example.com/*" });
		return tab?.id;
	});
	expect(tabId).toBeDefined();
	await sw.evaluate(async (id) => {
		await chrome.tabs.sendMessage(id!, { type: "AUTOFILL_CYCLE" });
	}, tabId);

	// The first cycle opens the list and highlights its first row; Enter is then a pick.
	const frame = await waitForPickerFrame(page);
	const row = frame.locator("[data-entry-id]");
	await expect(row).toHaveClass(/tp-active/);
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});
