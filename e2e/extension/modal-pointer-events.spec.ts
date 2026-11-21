import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	clickCornerAction,
	createVault,
	onOrigin,
	openPopup,
	seedExampleCard,
	seedTotpLogin,
	waitOutPickerClickGuard,
} from "./helpers";

// Radix, Headless UI and most React modals set `body.style.pointerEvents = "none"` while open
// and give the dialog back `pointer-events: auto`. Our hosts hang off <body>, so they inherited
// `none`: the picker painted over the dialog and every click went straight through it to the
// page underneath. Reported on Filen's two-factor dialog (Radix AlertDialog around input-otp),
// where clicking the row did nothing at all.

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const COEP = {
	"content-type": "text/html",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
};

/** A page with `content` in an open modal dialog, set up the way Radix's DismissableLayer does it. */
function modal(content: string): string {
	return `<!doctype html><html><head><title>Settings</title></head><body>
	<p>Page content behind the dialog.</p>
	<div style="position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.8)"></div>
	<div role="alertdialog" style="position: fixed; left: 50%; top: 30%; transform: translateX(-50%); z-index: 50; width: 480px; padding: 24px; background: #fff; pointer-events: auto">
		${content}
		<div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 160px">
			<button type="button">Cancel</button><button type="button" disabled>Continue</button>
		</div>
	</div>
	<script>document.body.style.pointerEvents = "none";</script>
</body></html>`;
}

// Filen's input-otp 1.1.0 field, verbatim: one transparent input laid over six slots.
const SLOT = '<div style="width: 40px; height: 40px; border: 1px solid #888"></div>';
const OTP_DIALOG =
	modal(`<div data-input-otp-container="true" style="position: relative; cursor: text; user-select: none; pointer-events: none; display: flex; gap: 8px; --root-height: 42px">
	${SLOT.repeat(6)}
	<div style="position: absolute; inset: 0px; pointer-events: none;"><input id="otp" autocomplete="one-time-code" data-input-otp="true" inputmode="numeric" pattern="^\\d+$" style="position: absolute; inset: 0px; width: 100%; height: 100%; display: flex; text-align: left; opacity: 1; color: transparent; pointer-events: all; background: transparent; caret-color: transparent; border: 0px solid transparent; outline: transparent solid 0px; box-shadow: none; line-height: 1; letter-spacing: -0.5em; font-size: var(--root-height); font-family: monospace; font-variant-numeric: tabular-nums;" maxlength="6" value="" data-input-otp-mss="0" data-input-otp-mse="0"></div>
</div>`);

async function serve(page: Page, body: string, headers: Record<string, string> = {}) {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body, headers: { "content-type": "text/html", ...headers } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

async function seedTotp(context: BrowserContext, extensionId: string): Promise<void> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedTotpLogin(popup, "Filen", SEED);
	await popup.close();
}

function uiFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

/** A real mouse click at the centre of `box`: whatever the page hit-tests there gets it. */
async function clickAt(page: Page, box: { x: number; y: number; width: number; height: number }) {
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("the picker takes a click over a modal that turns off pointer events", async ({
	context,
	extensionId,
}) => {
	await seedTotp(context, extensionId);
	const page = await context.newPage();
	await serve(page, OTP_DIALOG);
	await page.goto("https://example.com/settings");
	expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe("none");

	await expect(async () => {
		await page.locator("#otp").click();
		await expect(uiFrame(page)!.locator("[data-entry-id]")).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	await waitOutPickerClickGuard(page);
	const row = await uiFrame(page)!.locator("[data-entry-id]").boundingBox();
	await clickAt(page, row!);

	await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/, { timeout: 10_000 });
});

test("the shadow-DOM picker takes a click over the same modal", async ({
	context,
	extensionId,
}) => {
	await seedTotp(context, extensionId);
	const page = await context.newPage();
	// COEP forces the shadow renderer.
	await serve(page, OTP_DIALOG, COEP);
	await page.goto("https://example.com/settings");

	const host = page.locator("#bramble-autofill-dropdown");
	await expect(async () => {
		await page.locator("#otp").click();
		await expect(host).toBeAttached({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });
	const box = await host.boundingBox();
	await waitOutPickerClickGuard(page);
	await page.mouse.click(box!.x + 30, box!.y + 24);

	await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/, { timeout: 10_000 });
});

test("a relayed picker takes a click when the card frame is inside the modal", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	await popup.close();

	const MERCHANT = "https://merchant.example";
	const PCI = "https://pci.example";
	const checkout = modal(
		`<label for="cardframe">Card number</label><iframe id="cardframe" src="${PCI}/number" frameborder="0" scrolling="no" style="height: 47px; width: 432px; border: 0; display: block"></iframe>`,
	);
	const cardFrame = `<!doctype html><html><head><title>card</title></head><body style="margin: 0">
		<input autocomplete="cc-number" id="number" name="number" type="text" inputmode="numeric">
	</body></html>`;
	const page = await context.newPage();
	await page.context().route(/^https:\/\/(merchant|pci)\.example\//, (route) => {
		if (route.request().resourceType() !== "document") {
			return route.fulfill({ status: 200, body: "" });
		}
		const body = onOrigin(route.request().url(), PCI) ? cardFrame : checkout;
		return route.fulfill({ body, headers: { "content-type": "text/html" } });
	});
	await page.goto(`${MERCHANT}/`);

	const card = () => page.frames().find((f) => onOrigin(f.url(), PCI))!;
	// The relay's anti-clickjacking watchdog hit-tests the host, so an unclickable host never
	// even showed here: it read as covered and was torn down. Focus rather than click: the
	// relayed host covers the field once it opens, so a retrying click would land on a row.
	await expect(async () => {
		await card().locator("#number").focus();
		await expect.poll(() => uiFrame(page), { timeout: 5000 }).toBeDefined();
		await expect(uiFrame(page)!.locator("[data-entry-id]")).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 25_000 });
	expect(uiFrame(page)!.parentFrame()).toBe(page.mainFrame());
	await waitOutPickerClickGuard(page);
	const row = await uiFrame(page)!.locator("[data-entry-id]").boundingBox();
	await clickAt(page, row!);

	await expect(card().locator("#number")).toHaveValue("4242424242424242", { timeout: 15_000 });
});

test("the save card takes a click while a modal turns off pointer events", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);

	// Signing in swaps the dialog's form for its next step, without navigating.
	const login = modal(`<form id="login">
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
	<script>
		document.getElementById("login").addEventListener("submit", function (e) {
			e.preventDefault();
			setTimeout(function () { document.getElementById("login").remove(); }, 100);
		});
	</script>`);
	const page = await context.newPage();
	await serve(page, login);
	await page.goto("https://example.com/");
	await page.locator("#user").fill("carol@example.com");
	await page.locator("#pass").fill("C4rol-Modal-Pw");
	await page.getByRole("button", { name: "Sign in" }).click();

	const prompt = page.locator("#bramble-corner-prompt");
	await expect(prompt).toBeAttached({ timeout: 10_000 });
	await waitOutPickerClickGuard(page);
	await clickCornerAction(page, "save");
	await expect(prompt).toHaveCount(0, { timeout: 10_000 });

	await openPopup(popup, extensionId);
	await expect(popup.getByText("carol@example.com")).toBeVisible();
});
