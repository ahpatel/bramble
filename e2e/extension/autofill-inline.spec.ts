import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleLogin, waitOutPickerClickGuard } from "./helpers";

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
	await popup.evaluate(
		(next) => chrome.storage.local.set({ "pref.autofillTrigger": next }),
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

test("quiet mode: Enter fills the suggested login, Tab keeps its native focus move, and the menu borrows the field's skin", async ({
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

	// The mark exists and is parked exactly over the field.
	await expect(markHost(page)).toHaveCount(1);
	// The one-time introduction was shown on this first meeting and reported back, so it will not
	// follow the user to every site.
	await expect
		.poll(() =>
			popup.evaluate(() =>
				chrome.storage.local
					.get("pref.autofillIconHintSeen")
					.then((r) => r["pref.autofillIconHintSeen"]),
			),
		)
		.toBe(true);
	const fieldBox = await page.locator("#user").boundingBox();
	const markBox = await markHost(page).boundingBox();
	expect(markBox).not.toBeNull();
	expect(markBox!.x).toBeCloseTo(fieldBox!.x, 0);
	expect(markBox!.width).toBeCloseTo(fieldBox!.width, 0);

	// Nothing opened on focus: the quiet mode draws no panel. The picker iframe is preloaded
	// while the mark is up, so it exists but must stay hidden.
	await expect
		.poll(() =>
			page.evaluate(
				() => document.querySelector<HTMLElement>('div[id^="tp-"]')?.style.display ?? "gone",
			),
		)
		.not.toBe("block");

	// Tab is the browser's: it moves focus to the password field and fills nothing.
	await page.locator("#user").fill("ali");
	await page.keyboard.press("Tab");
	await expect(page.locator("#pass")).toBeFocused();
	await expect(page.locator("#user")).toHaveValue("ali");
	await expect(page.locator("#pass")).toHaveValue("");

	// Enter takes the completion instead, filling both fields.
	await page.locator("#user").focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");

	// Clear it and open the menu with the mark.
	await page.locator("#user").fill("");
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	// The panel aligns with the field, not inset by the iframe document's default margin.
	const menuBox = await page.locator('div[id^="tp-"]').boundingBox();
	expect(menuBox).not.toBeNull();
	expect(menuBox!.width).toBeCloseTo(fieldBox!.width, 0);

	// The skin is the field's: square corners and the page's serif font, not the old 16px card.
	const skin = await frame.evaluate(() => {
		const list = document.querySelector<HTMLElement>(".tp-list")!;
		const cs = getComputedStyle(list);
		return { radius: cs.borderTopLeftRadius, font: cs.fontFamily, surface: cs.backgroundColor };
	});
	expect(skin.radius).toBe("0px");
	expect(skin.font).toContain("Georgia");
	expect(skin.surface).toBe("rgb(255, 255, 255)");

	await waitOutPickerClickGuard(page);
	await frame.locator("[data-entry-id]").click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

test("Enter fills the suggested login with the menu closed", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	// Quiet mode: typing draws the ghost completion, not a panel.
	expect(pickerFrame(page)).toBeUndefined();
	await page.locator("#user").fill("ali");
	await page.keyboard.press("Enter");

	// The top suggestion fills both fields; Enter does not submit the half-typed form.
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
	await expect(page).toHaveURL("https://example.com/");
});

test("Enter fills a fully typed matching username, with no ghost to accept", async ({
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
	// The whole saved username, not a prefix: there is no completion to paint.
	await page.locator("#user").fill("alice@example.com");
	await page.keyboard.press("Enter");

	// The value is already a saved-login selection, so Enter supplies the password.
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
	await expect(page).toHaveURL("https://example.com/");
});

test("Enter fills the suggested login from an empty field", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	// The query has landed, so the mark is up and the whole top username is suggested in the
	// empty field. Enter accepts that suggestion.
	await expect(markHost(page)).toHaveCount(1);
	await expect(page.locator("#user")).toHaveValue("");
	await page.keyboard.press("Enter");

	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
	await expect(page).toHaveURL("https://example.com/");
});

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

test("the keyboard command cycles through the site's logins", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup, "Work account", "alice@example.com", "work-pw-01");
	await seedLogin(popup, "Personal", "alice.personal@example.com", "home-pw-02");
	await setTrigger(popup, "icon");

	// The command ships with a default chord and is visible to the browser's shortcuts page.
	const sw = context.serviceWorkers()[0];
	const commands = await sw!.evaluate(() => chrome.commands.getAll());
	const cycleCommand = commands.find((c) => c.name === "autofill-cycle");
	expect(cycleCommand).toBeDefined();
	// Chrome formats the chord for the platform ("⌥⇧L" on macOS), so assert it is bound rather
	// than pinning one notation.
	expect(cycleCommand!.shortcut).toBeTruthy();
	expect(cycleCommand!.shortcut).toMatch(/L$/);

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	// The mark proves the query result (and its match list) has landed; the command reads that
	// cache, so cycling before it arrives would do nothing.
	await expect(markHost(page)).toHaveCount(1);

	await cycle(context);
	await expect(page.locator("#user")).toHaveValue("alice@example.com", { timeout: 10_000 });
	await expect(page.locator("#pass")).toHaveValue("work-pw-01");

	// A press that lands while the previous fill is still in flight is dropped by design, so the
	// poll re-sends until the second entry arrives rather than assuming one press was enough.
	await expect
		.poll(
			async () => {
				await cycle(context);
				return page.locator("#user").inputValue();
			},
			{ timeout: 10_000 },
		)
		.toBe("alice.personal@example.com");
	await expect(page.locator("#pass")).toHaveValue("home-pw-02");
});

test("focus mode still opens the panel on focus; shortcut mode draws nothing", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await setTrigger(popup, "focus");

	await page.reload();
	await page.locator("#user").click();
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });

	await setTrigger(popup, "shortcut");
	await page.reload();
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(0);
	expect(pickerFrame(page)).toBeUndefined();

	// The shortcut still fills without any on-page UI. The poll re-sends because the first press
	// can land before the fresh query has answered; with one login, a repeat is harmless.
	await expect
		.poll(
			async () => {
				await cycle(context);
				return page.locator("#user").inputValue();
			},
			{ timeout: 10_000 },
		)
		.toBe("alice@example.com");
});

test("Settings exposes the click behaviour and the bound shortcut", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();

	const select = popup.getByRole("combobox", { name: "Show" });
	// The shared fixture starts every panel-policy spec in focus mode.
	await expect(select).toHaveValue("focus");
	await expect(popup.getByText("Cycle logins with the keyboard")).toBeVisible();
	await expect(popup.getByRole("button", { name: "Change" })).toBeVisible();

	await select.selectOption("icon");
	await expect
		.poll(() =>
			popup.evaluate(() =>
				chrome.storage.local.get("pref.autofillTrigger").then((r) => r["pref.autofillTrigger"]),
			),
		)
		.toBe("icon");
});

test("changing the click behaviour updates an open page without a reload", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();

	// Change the mode through the real Settings control, not storage: the background must push
	// the new mode to the tab that is already open.
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();
	await popup.getByRole("combobox", { name: "Show" }).selectOption("icon");

	// The iframe host is kept for reuse, so the menu is closed when its host is hidden, not when
	// the frame disappears.
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const host = document.querySelector<HTMLElement>('div[id^="tp-"]');
					return host ? host.style.display : "gone";
				}),
			{ timeout: 10_000 },
		)
		.toBe("none");
	await page.bringToFront();
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(1);
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

test("typing narrows an open quiet-mode menu", async ({ context, extensionId }) => {
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
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(2, { timeout: 10_000 });

	// A real keystroke narrows the open menu, as it does in the focus-mode panel.
	await page.locator("#user").fill("alice.p");
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	await expect(frame.locator(".tp-item-compact").first()).toContainText("Personal");

	// Enter takes the top filtered entry and fills both fields.
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice.personal@example.com");
	await expect(page.locator("#pass")).toHaveValue("home-pw-02");

	// The pick ends the typed filter: the mark reopens the full list, not just the chosen entry.
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(2, { timeout: 10_000 });
});

test("typing with one saved login keeps the filtered menu and the completion", async ({
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
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });

	// One login used to remove the menu on the first keystroke, leaving only the completion.
	await page.keyboard.type("ali");
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	await expect(frame.locator(".tp-item-compact").first()).toContainText("alice@example.com");

	// ...and Enter takes the top filtered login, filling both fields (not just the username).
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");
});

test("Alt+ArrowDown opens the menu from the field and Escape closes it", async ({
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
	const field = page.locator("#user");
	await field.click();
	await expect(markHost(page)).toHaveCount(1);

	// The field advertises the list without entering the Tab order.
	await expect(field).toHaveAttribute("aria-haspopup", "listbox");
	await expect(field).toHaveAttribute("aria-expanded", "false");

	await page.keyboard.press("Alt+ArrowDown");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(field).toHaveAttribute("aria-expanded", "true");
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });

	await page.keyboard.press("Escape");
	await expect(field).toHaveAttribute("aria-expanded", "false");
});

test("the mark in a filled password field opens the menu", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await page.keyboard.press("Enter");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");

	// Hover only: the mark follows the pointer, so clicking its spot on the password field
	// should move the host there and open the menu for that field.
	await clickMarkIn(page, "#pass");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
});

test("the password field's mark reopens after a pick from that field", async ({
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
	await page.locator("#pass").click();
	await expect(markHost(page)).toHaveCount(1);
	await clickMarkIn(page, "#pass");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await waitOutPickerClickGuard(page);
	await frame.locator(".tp-item-compact").first().click();
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");

	// No focus click first: click the mark that the chip just extended from.
	await clickMarkIn(page, "#pass");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});

test("clicking the password mark switches the open username menu", async ({
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
	await page.keyboard.press("Enter");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");

	// The username menu is open, then the pointer moves to the filled password field's mark.
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });

	// The menu covers the password field. A click on the left half of the password mark must switch
	// the menu to the password instead of picking the row (or its open button) under the pointer.
	await waitOutPickerClickGuard(page);
	await clickMarkIn(page, "#pass");
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.querySelector<HTMLInputElement>("#pass")?.getAttribute("aria-expanded"),
			),
		)
		.toBe("true");
});

test("the password mark switches an above-opening username menu", async ({
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
	await page.keyboard.press("Enter");
	await expect(page.locator("#pass")).toHaveValue("s3cr3t-pw-01");

	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await page.waitForTimeout(300);

	await clickMarkIn(page, "#pass");
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.querySelector<HTMLInputElement>("#pass")?.getAttribute("aria-expanded"),
			),
		)
		.toBe("true");
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

test("COEP fallback: shadow keyboard navigation", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await page.route(/example\.com/, (route) =>
		route.request().resourceType() === "document"
			? route.fulfill({
					body: SQUARE_LOGIN,
					headers: {
						"content-type": "text/html",
						"Cross-Origin-Embedder-Policy": "require-corp",
						"Cross-Origin-Opener-Policy": "same-origin",
					},
				})
			: route.fulfill({ status: 200, body: "" }),
	);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(1);
	await clickMark(page);
	await page.waitForTimeout(1500);
	const shadow = await page.locator("#bramble-autofill-dropdown").count();
	expect(shadow).toBe(1);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
});

test("the username mark reopens after a pick from its menu", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SQUARE_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	await expect(markHost(page)).toHaveCount(1);
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const frame = pickerFrame(page)!;
	await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	await waitOutPickerClickGuard(page);
	await frame.locator(".tp-item-compact").first().click();
	// Click the mark immediately, while the pick is still collapsing and filling.
	await clickMark(page);
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});

test("the marks keep reopening across alternating password and username picks", async ({
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

	for (const [selector, expected] of [
		["#pass", "s3cr3t-pw-01"],
		["#user", "alice@example.com"],
		["#pass", "s3cr3t-pw-01"],
		["#user", "alice@example.com"],
	] as const) {
		await clickMarkIn(page, selector);
		await expect(async () => {
			expect(pickerFrame(page)).toBeDefined();
		}).toPass({ timeout: 20_000 });
		const frame = pickerFrame(page)!;
		await expect(frame.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
		// The host must open full-width. A finished collapse animation used to leave its
		// scale(0.02) fill-forwards end state on the reused host, so every menu after the
		// first pick opened as an invisible ~7x2 sliver: rendered, clickable by coordinate,
		// and invisible to a human.
		const hostWidth = await page.evaluate(() => {
			const hosts = document.querySelectorAll('div[id^="tp-"]');
			const host = hosts[hosts.length - 1];
			return host ? host.getBoundingClientRect().width : 0;
		});
		expect(hostWidth, "the menu host opened full-width, not a collapse sliver").toBeGreaterThan(
			100,
		);
		await waitOutPickerClickGuard(page);
		await frame.locator(".tp-item-compact").first().click();
		// The pick releases the native autocomplete at once, not after the collapse: the next
		// mark click must see the token the page declared.
		const declared = selector === "#pass" ? "current-password" : "username";
		await expect(page.locator(selector)).toHaveAttribute("autocomplete", declared);
		await expect(page.locator(selector)).toHaveValue(expected, { timeout: 10_000 });
		// Let the pick's collapse animation FINISH before the next open. The animation ends
		// through its onfinish path here, not the cancel path a fast reopen takes; a menu
		// opened after a finished collapse used to inherit its scale(0.02) end state and
		// open as an invisible sliver.
		await page.waitForTimeout(500);
	}
});

test("the mark steps left of a site's clear control and keeps reopening", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, CLEARABLE_LOGIN);
	await page.goto("https://example.com/");

	// First open: the field is empty, so the clear control is absent and the mark sits at the
	// base inset.
	await clickMarkAt(page, "#user");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const first = pickerFrame(page)!;
	await expect(first.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	await waitOutPickerClickGuard(page);
	await first.locator(".tp-item-compact").first().click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com");

	// The fill gives the field a value, so the page's clear control now covers the base spot.
	// The next open must step left of it, or the click lands on the clear button and the menu
	// never opens.
	await clickMarkAt(page, "#user");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});

const SHORT_LOGIN = `<!doctype html><html><head><title>Sign in</title><style>
	body { margin: 40px; }
	form { width: 340px; }
	input {
		display: block; width: 244px; height: 17.5px; box-sizing: border-box;
		padding: 0; border: 0; font: 14px Georgia, "Times New Roman", serif;
	}
</style></head><body>
	<form id="challenge-form" method="post" autocomplete="on">
		<label for="username">Username, email or phone number</label>
		<input id="username" type="text" name="username" value="" autocomplete="" />
		<button type="submit" name="signin">Next</button>
	</form>
</body></html>`;

test("the mark shows on a short identifier-first field", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedLogin(popup, "Yahoo", "alice@yahoo.com", "s3cr3t-pw-01", "https://yahoo.com");
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, SHORT_LOGIN, "login\\.yahoo\\.com");
	await page.goto("https://login.yahoo.com/");
	await page.locator("#username").click();
	// Yahoo's input is 17.5px tall inside a taller control. The mark must still draw.
	await expect(markHost(page)).toBeVisible({ timeout: 10_000 });

	await clickMarkAt(page, "#username");
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});

const IDENTIFIER_FIRST = `<!doctype html><html><head><title>Sign in</title></head><body>
	<form id="f">
		<input id="user" name="username" type="text" autocomplete="username" />
		<button type="submit">Next</button>
	</form>
	<script>
		document.getElementById("f").addEventListener("submit", (e) => {
			e.preventDefault();
			window.__submitted = true;
		});
	</script>
</body></html>`;

test("Enter fills the username and submits on an identifier-first page", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, IDENTIFIER_FIRST);
	await page.goto("https://example.com/");
	await page.locator("#user").fill("al");
	await expect(markHost(page)).toHaveCount(1, { timeout: 10_000 });
	await page.keyboard.press("Enter");

	// The username completes and the page's own Enter submit runs; there is no password on this
	// step, so the whole-login fill would race the page's navigation and be refused.
	await expect(page.locator("#user")).toHaveValue("alice@example.com");
	await expect
		.poll(() => page.evaluate(() => (window as { __submitted?: boolean }).__submitted))
		.toBe(true);
});

const NARROW_LOGIN = `<!doctype html><html><head><title>Sign in</title><style>
	body { margin: 40px; }
	input { height: 24px; font: 14px Georgia, serif; }
	#user { width: 40px; }
</style></head><body>
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
	</form>
</body></html>`;

test("the mark shows on a narrow field and overlaps the text", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, NARROW_LOGIN);
	await page.goto("https://example.com/");
	await page.locator("#user").click();
	// The field is 40px wide, under the old 88px floor. The mark overlaps the text instead of
	// disappearing, and its small inset keeps the 26px button inside the field.
	await expect(markHost(page)).toBeVisible({ timeout: 10_000 });

	await clickMarkAt(page, "#user");
	await expect.poll(() => pickerFrame(page), { timeout: 10_000 }).toBeDefined();
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
});

test("the mark steps right of a site's clear control in an RTL field", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await setTrigger(popup, "icon");

	const page = await context.newPage();
	await serve(page, CLEARABLE_RTL_LOGIN);
	await page.goto("https://example.com/");

	await clickMarkAt(page, "#user");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	const first = pickerFrame(page)!;
	await expect(first.locator(".tp-item-compact")).toHaveCount(1, { timeout: 10_000 });
	await waitOutPickerClickGuard(page);
	await first.locator(".tp-item-compact").first().click();
	await expect(page.locator("#user")).toHaveValue("alice@example.com");

	// The clear control now sits at the inline end (the left, in RTL). The mark must step right
	// of it, the mirrored move of the LTR case above.
	await clickMarkAt(page, "#user");
	await expect(async () => {
		expect(pickerFrame(page)).toBeDefined();
	}).toPass({ timeout: 20_000 });
	await expect(pickerFrame(page)!.locator(".tp-item-compact")).toHaveCount(1, {
		timeout: 10_000,
	});
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
