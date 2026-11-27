import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	openPopup,
	seedExampleCard,
	seedExampleLogin,
	waitOutPickerClickGuard,
} from "./helpers";

// The quiet default: a mark in the field, a username completion while typing, and a compact menu
// only when the mark is clicked. The mark and completion live in a closed shadow root, so the
// assertions here are about what the user can do (Enter completes, the click opens the panel) and
// about the frame's own skin, not about reading the shadow's text.

const SQUARE_LOGIN = `<!doctype html><html><head><title>login</title><style>
	body { margin: 40px; background: #eef0f3; }
	form { width: 340px; }
	input {
		display: block; width: 100%; height: 42px; box-sizing: border-box;
		border: 1px solid rgb(185, 192, 201); border-radius: 0;
		padding: 0 44px 0 11px;
		font: 14px Georgia, "Times New Roman", serif;
		color: rgb(23, 32, 43); background: rgb(255, 255, 255);
	}
	input + input { margin-top: 12px; }
</style></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

const CLEARABLE_LOGIN = `<!doctype html><html><head><title>login</title><style>
	body { margin: 40px; background: #eef0f3; }
	form { width: 340px; }
	.wrap { position: relative; margin-top: 12px; }
	input {
		display: block; width: 100%; height: 42px; box-sizing: border-box;
		border: 1px solid rgb(185, 192, 201); border-radius: 0;
		padding: 0 80px 0 11px;
		font: 14px Georgia, "Times New Roman", serif;
		color: rgb(23, 32, 43); background: rgb(255, 255, 255);
	}
	.clear {
		position: absolute; right: 30px; top: 50%; transform: translateY(-50%);
		width: 26px; height: 26px; display: none; border: 0;
		background: rgb(238, 240, 243); color: rgb(23, 32, 43);
		font: 16px sans-serif; cursor: pointer;
	}
	.wrap.has-value .clear { display: block; }
</style></head><body>
	<form>
		<div class="wrap" id="user-wrap">
			<input id="user" name="username" type="text" autocomplete="username" />
			<button type="button" class="clear" aria-label="Clear">x</button>
		</div>
		<div class="wrap">
			<input id="pass" name="password" type="password" autocomplete="current-password" />
		</div>
		<button type="submit">Sign in</button>
	</form>
	<script>
		const user = document.querySelector("#user");
		const wrap = document.querySelector("#user-wrap");
		user.addEventListener("input", () => wrap.classList.toggle("has-value", !!user.value));
	</script>
</body></html>`;

const CLEARABLE_RTL_LOGIN = `<!doctype html><html dir="rtl"><head><title>login</title><style>
	body { margin: 40px; background: #eef0f3; }
	form { width: 340px; }
	.wrap { position: relative; margin-top: 12px; }
	input {
		display: block; width: 100%; height: 42px; box-sizing: border-box;
		border: 1px solid rgb(185, 192, 201); border-radius: 0;
		padding: 0 11px 0 80px;
		font: 14px Georgia, "Times New Roman", serif;
		color: rgb(23, 32, 43); background: rgb(255, 255, 255);
	}
	.clear {
		position: absolute; left: 30px; top: 50%; transform: translateY(-50%);
		width: 26px; height: 26px; display: none; border: 0;
		background: rgb(238, 240, 243); color: rgb(23, 32, 43);
		font: 16px sans-serif; cursor: pointer;
	}
	.wrap.has-value .clear { display: block; }
</style></head><body>
	<form>
		<div class="wrap" id="user-wrap">
			<input id="user" name="username" type="text" autocomplete="username" />
			<button type="button" class="clear" aria-label="Clear">x</button>
		</div>
		<div class="wrap">
			<input id="pass" name="password" type="password" autocomplete="current-password" />
		</div>
		<button type="submit">Sign in</button>
	</form>
	<script>
		const user = document.querySelector("#user");
		const wrap = document.querySelector("#user-wrap");
		user.addEventListener("input", () => wrap.classList.toggle("has-value", !!user.value));
	</script>
</body></html>`;

const ROUNDED_LOGIN = `<!doctype html><html><head><title>login</title><style>
	body { margin: 40px; background: #f7f6fd; }
	form { width: 340px; }
	input {
		display: block; width: 100%; height: 44px; box-sizing: border-box;
		border: 1px solid rgb(230, 228, 242); border-radius: 12px;
		padding: 0 48px 0 13px;
		font: 14px ui-sans-serif, system-ui, sans-serif;
		color: rgb(29, 27, 46); background: rgb(243, 242, 249);
	}
	input + input { margin-top: 12px; }
</style></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

async function serve(page: Page, html: string, host = "example\\.com"): Promise<void> {
	await page
		.context()
		.route(new RegExp(host), (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: html, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

function pickerFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

/** The mark's host is in page light DOM; its shadow root is closed, as designed. */
function markHost(page: Page) {
	return page.locator('div[id^="bmk-"]');
}

/** Click the leaf inside the field: the host is pointer-events:none, the button is not. */
async function clickMark(page: Page): Promise<void> {
	const field = page.locator("#user");
	const box = await field.boundingBox();
	expect(box).not.toBeNull();
	// Chromium reserves ~30px at the inline end for its own key/eye icons, so the mark sits there.
	await page.mouse.click(box!.x + box!.width - 30 - 13, box!.y + box!.height / 2);
}

/** Click the mark inside an arbitrary field (the password field after a fill, for example). */
async function clickMarkIn(page: Page, selector: string): Promise<void> {
	const field = page.locator(selector);
	const box = await field.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width - 30 - 13, box!.y + box!.height / 2);
}

/** Click the mark at the inset it was actually drawn at, after a site control may have moved it. */
async function clickMarkAt(page: Page, selector: string): Promise<void> {
	const field = page.locator(selector);
	await field.click();
	await field.hover();
	await expect(markHost(page)).toHaveCount(1, { timeout: 10_000 });
	const box = await field.boundingBox();
	expect(box).not.toBeNull();
	const inset = await markHost(page).evaluate(
		(el) => Number.parseFloat(getComputedStyle(el).getPropertyValue("--mark-inset")) || 30,
	);
	const rtl = await field.evaluate((el) => getComputedStyle(el).direction === "rtl");
	const x = rtl ? box!.x + inset + 13 : box!.x + box!.width - inset - 13;
	await page.mouse.click(x, box!.y + box!.height / 2);
}

/** The pref the background reads per query; the shared fixture starts every other spec in focus. */
async function setTrigger(popup: Page, trigger: "icon" | "focus" | "shortcut"): Promise<void> {
	// The quiet icon mode's older specs exercise the compact rows; the focus and shortcut modes
	// use the comfortable default. The density setting itself has its own spec.
	await popup.evaluate(
		(next) =>
			chrome.storage.local.set({
				"pref.autofillTrigger": next,
				"pref.autofillDensity": next === "icon" ? "compact" : "comfortable",
			}),
		trigger,
	);
}

async function seedLogin(
	popup: Page,
	name: string,
	username: string,
	password: string,
	url = "https://example.com",
) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill(name);
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill(url);
	await popup.getByLabel("Username or email", { exact: true }).fill(username);
	await popup.getByLabel("Password", { exact: true }).fill(password);
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByRole("button", { name: new RegExp(`Open ${name}`) })).toBeVisible();
}

async function cycle(context: import("@playwright/test").BrowserContext) {
	const sw = context.serviceWorkers()[0];
	expect(sw).toBeDefined();
	await sw!.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (tab?.id !== undefined) {
			await chrome.tabs.sendMessage(tab.id, {
				type: "AUTOFILL_CYCLE",
				payload: { back: false },
			});
		}
	});
}


test("the compact menu follows a rounded field", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, ROUNDED_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	const skin = await frame.evaluate(() => {
		const list = document.querySelector<HTMLElement>(".tp-list")!;
		const cs = getComputedStyle(list);
		return { radius: cs.borderTopLeftRadius, surface: cs.backgroundColor };
	});
	expect(skin.radius).toBe("12px");
	expect(skin.surface).toBe("rgb(252, 251, 253)");
});

test("the dropdown rows setting switches the menu between comfortable and compact", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup, "Bank of America - Dad", "dad@example.com", "s3cr3t-pw-01");
	await seedLogin(popup, "Bank of America - Mom", "mom@example.com", "s3cr3t-pw-02");
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();
	// The fixture starts in focus mode with comfortable rows; this spec drives both controls.
	await popup.getByRole("combobox", { name: "Show" }).selectOption("icon");
	const rows = popup.getByRole("combobox", { name: "Rows" });
	await expect(rows).toHaveValue("comfortable");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	const frame = pickerFrame(page)!;
	// Comfortable gives each title its own row, so the two accounts are distinguishable.
	await expect(frame.locator(".tp-item")).toHaveCount(2, { timeout: 10_000 });
	await expect(frame.locator(".tp-item-compact")).toHaveCount(0);
	await expect(frame.locator(".tp-name", { hasText: "Bank of America - Dad" })).toBeVisible();
	await expect(frame.locator(".tp-name", { hasText: "Bank of America - Mom" })).toBeVisible();

	// The open menu follows the setting without a reopen.
	await rows.selectOption("compact");
	await expect.poll(() => frame.locator(".tp-item-compact").count(), { timeout: 10_000 }).toBe(2);
	await expect(
		frame.locator(".tp-item-compact .tp-name", { hasText: "Bank of America - Dad" }),
	).toHaveAttribute("title", "Bank of America - Dad");

	// A page that loads with compact already saved must still open on the mark's first click.
	// The density sync must not open a menu for a merely focused field: the mark would read that
	// click as "close" and the page would look like the picker never opened.
	const fresh = await context.newPage();
	await serve(fresh, SQUARE_LOGIN);
	await fresh.goto("https://example.com/");
	await fresh.locator("#user").click();
	await clickMark(fresh);
	await expect.poll(() => pickerFrame(fresh), { timeout: 10_000 }).toBeDefined();
	await expect(pickerFrame(fresh)!.locator(".tp-item-compact")).toHaveCount(2, {
		timeout: 10_000,
	});
});

test("the login last used on the site leads the next menu", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup, "Work account", "alice@example.com", "work-pw-01");
	await seedLogin(popup, "Personal", "alice.personal@example.com", "home-pw-02");
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });

	// Pick the second login explicitly, not whichever happens to be first.
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(2, { timeout: 10_000 });
	await waitOutPickerClickGuard(page);
	await frame.getByText("Personal", { exact: true }).click();
	await expect(page.locator("#user")).toHaveValue("alice.personal@example.com", {
		timeout: 10_000,
	});

	// The pick refreshes the cache behind the closed menu; give that round trip a moment, then
	// reopen. The site's last-used login must lead, marked "Used here".
	await page.waitForTimeout(400);
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const reopened = pickerFrame(page)!;
	const first = reopened.locator(".tp-item-compact").first();
	await expect(first).toContainText("Personal", { timeout: 10_000 });
	await expect(first).toContainText("Used here");
});

test("a row's open action opens the entry details without filling", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator("[data-entry-id]")).toHaveCount(1, { timeout: 10_000 });
	await waitOutPickerClickGuard(page);

	const opened = context.waitForEvent("page");
	// The open action shares the row's trailing slot and appears on hover.
	await frame.locator("[data-entry-id]").first().hover();
	await frame.locator("[data-tp-open-entry]").click();
	const details = await opened;
	await expect(details).toHaveURL(/popup\.html\?detached=1/);
	await expect(details.getByRole("heading", { name: "Example Login" })).toBeVisible({
		timeout: 15_000,
	});
	// Opening the entry is a navigation, not a pick: the page field must be untouched.
	await expect(page.locator("#user")).toHaveValue("");
});

test("a field near the bottom opens the menu above it, fully inside the viewport", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const bottom = `<!doctype html><html><head><style>
		html, body { height: 100%; margin: 0; }
		form { position: absolute; left: 40px; top: calc(100vh - 110px); width: 340px; }
		input { display:block; width:100%; height:42px; box-sizing:border-box; border:1px solid rgb(185,192,201); border-radius:0; padding:0 44px 0 11px; font:14px Georgia, serif; color:rgb(23,32,43); background:rgb(255,255,255); }
	</style></head><body>
	<form><input id="user" type="text" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form>
	</body></html>`;
	const page = await context.newPage();
	await serve(page, bottom);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await page.waitForTimeout(300);

	const field = (await page.locator("#user").boundingBox())!;
	const menu = (await page.locator('div[id^="tp-"]').boundingBox())!;
	expect(menu.y + menu.height).toBeLessThanOrEqual(field.y);
	expect(menu.y).toBeGreaterThan(0);
});

test("a menu taller than both gaps is capped and scrolls, not clipped", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	for (let i = 0; i < 6; i++) {
		await seedLogin(popup, `Account ${i}`, `user${i}@example.com`, `pw-${i}`);
	}
	await setTrigger(popup, "icon");

	// A 360px viewport with the field at 150px: 168px below, 150 above, and six rows (~372px)
	// fit on neither side.
	const shortViewport = `<!doctype html><html><head><style>
		html, body { height: 100%; margin: 0; }
		form { position: absolute; left: 40px; top: 150px; width: 340px; }
		input { display:block; width:100%; height:42px; box-sizing:border-box; border:1px solid rgb(185,192,201); border-radius:0; padding:0 44px 0 11px; font:14px Georgia, serif; color:rgb(23,32,43); background:rgb(255,255,255); }
	</style></head><body>
	<form><input id="user" type="text" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form>
	</body></html>`;
	const page = await context.newPage();
	await page.setViewportSize({ width: 900, height: 360 });
	await serve(page, shortViewport);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(6, { timeout: 10_000 });
	await page.waitForTimeout(300);

	// The list scrolls inside itself rather than drawing past the window edge.
	const list = await frame.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".tp-list")!;
		return { client: el.clientHeight, scroll: el.scrollHeight };
	});
	expect(list.scroll).toBeGreaterThan(list.client);
	const menu = (await page.locator('div[id^="tp-"]').boundingBox())!;
	expect(menu.y).toBeGreaterThanOrEqual(0);
	expect(menu.y + menu.height).toBeLessThanOrEqual(360);
});

test("a second open action moves the existing Bramble window instead of duplicating it", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup, "Work account", "alice@example.com", "work-pw-01");
	await seedLogin(popup, "Personal", "alice.personal@example.com", "home-pw-02");
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await waitOutPickerClickGuard(page);

	const opened = context.waitForEvent("page");
	await pickerFrame(page)!.locator("[data-entry-id]").first().hover();
	await pickerFrame(page)!.locator("[data-tp-open-entry]").first().click();
	const details = await opened;
	await expect(details.getByRole("heading", { name: "Work account" })).toBeVisible({
		timeout: 15_000,
	});

	await page.bringToFront();
	await page.locator("#user").click();
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await waitOutPickerClickGuard(page);
	await pickerFrame(page)!.locator("[data-entry-id]").nth(1).hover();
	await pickerFrame(page)!.locator("[data-tp-open-entry]").nth(1).click();

	await expect(details.getByRole("heading", { name: "Personal" })).toBeVisible({
		timeout: 10_000,
	});
	expect(context.pages().filter((p) => p.url().includes("popup.html?detached=1"))).toHaveLength(1);
});

test("a 200% zoom menu keeps the entry name readable", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const narrow = `<!doctype html><html><head><title>login</title><style>
		body { margin: 20px; background: #eef0f3; }
		form { width: 120px; }
		input { display: block; width: 100%; height: 42px; box-sizing: border-box; border: 1px solid rgb(185,192,201); border-radius: 0; padding: 0 44px 0 8px; font: 14px Georgia, serif; color: rgb(23,32,43); background: rgb(255,255,255); }
		input + input { margin-top: 12px; }
	</style></head><body>
	<form><input id="user" type="text" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"></form>
	</body></html>`;
	const page = await context.newPage();
	await page.setViewportSize({ width: 160, height: 700 });
	await serve(page, narrow);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(1);
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	const metrics = await frame.evaluate(() => {
		const row = document.querySelector(".tp-item-compact")!;
		const name = row.querySelector(".tp-name")!;
		const avatar = row.querySelector(".tp-avatar") as HTMLElement;
		const list = document.querySelector(".tp-list")!;
		return {
			listW: Math.round(list.getBoundingClientRect().width),
			nameW: Math.round(name.getBoundingClientRect().width),
			avatarDisplay: getComputedStyle(avatar).display,
			overflow: row.scrollWidth > row.clientWidth + 1,
		};
	});
	expect(metrics.listW).toBeLessThan(200);
	expect(metrics.avatarDisplay).toBe("none");
	expect(metrics.nameW).toBeGreaterThan(40);
	expect(metrics.overflow).toBe(false);
});

const OFFSET_BODY_LOGIN = `<!doctype html><html><head><title>Sign in</title><style>
	html, body { margin: 0; }
	body { position: fixed; top: -37px; left: 120px; right: 0; bottom: 0; }
	form { width: 340px; margin: 80px; }
	input { display: block; width: 300px; height: 40px; box-sizing: border-box; }
</style></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
	</form>
</body></html>`;

test("the mark and menu align on a page that positions the body", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, OFFSET_BODY_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(1, { timeout: 10_000 });
	const field = await page.locator("#user").boundingBox();
	const mark = await markHost(page).boundingBox();
	expect(mark).not.toBeNull();
	expect(field).not.toBeNull();
	// The body is fixed at left 120px / top -37px. The hosts translate from the body's origin,
	// so without the containing-block probe both would sit 120px right and 37px up.
	expect(Math.abs(mark!.x - field!.x)).toBeLessThan(2);
	expect(Math.abs(mark!.y - field!.y)).toBeLessThan(2);

	await clickMarkAt(page, "#user");
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	const picker = await page.locator('div[id^="tp-"]').boundingBox();
	expect(picker).not.toBeNull();
	expect(Math.abs(picker!.x - field!.x)).toBeLessThan(2);
	expect(Math.abs(picker!.y - (field!.y + field!.height + 2))).toBeLessThan(3);
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});
