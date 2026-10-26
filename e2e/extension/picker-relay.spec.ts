import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	onOrigin,
	openPopup,
	seedExampleCard,
	seedExampleLogin,
	waitOutPickerClickGuard,
} from "./helpers";

// Card autofill on a hosted-fields checkout (Shopify, Stripe Elements, Braintree, Adyen). The card
// input lives in a cross-origin iframe sized to the input itself, so a picker mounted in that
// document is positioned below the frame's viewport and an iframe cannot paint outside its own box:
// the field was detected, but nothing was ever visible. The top frame now hosts the ELEMENT while
// the field's frame keeps the conversation with it. See docs/autofill.md.
//
// Two real origins here, so the iframe is genuinely cross-origin and the relay is exercised end to
// end: the frame walk, the extension-origin pin (which unit tests cannot check, since it depends on
// what Chromium actually reports for a `use_dynamic_url` web-accessible resource), and the fill.

const MERCHANT = "https://merchant.example";
const PCI = "https://pci.example";
// A third origin, for the nested case: merchant -> wallet -> pci.
const WALLET = "https://wallet.example";
// An unrelated third party on the checkout page, e.g. an ad.
const AD = "https://ad.example";
// Same site as the merchant, different origin.
const LOGIN_SAME_SITE = "https://login.merchant.example";

/** The merchant frame: labels and an empty container, exactly like Shopify's checkout. */
const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head>
<body style="margin:0">
	<div style="height:300px">Order summary</div>
	<div id="number-container">
		<label for="number">Card number</label>
		<iframe id="cardframe" src="${PCI}/number" frameborder="0" scrolling="no"
			style="height:47px;width:432px;border:0;display:block"></iframe>
	</div>
	<button id="elsewhere" type="button">Somewhere else</button>
</body></html>`;

// Shopify's real frame document: one visible field plus hidden decoys that carry real cc-* tokens,
// so a browser filling this one frame delivers the whole card.
const CARD_FRAME = `<!doctype html><html><head><title>card</title></head>
<body style="margin:0">
	<form>
		<label for="number" style="position:absolute;left:-9999px">Credit Card Number</label>
		<input required autocomplete="cc-number" id="number" name="number" type="text" inputmode="numeric">
		<input autocomplete="cc-name" id="name" name="name" type="text" data-honeypot-field tabindex="-1"
			aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-exp-month" id="expiry_month" name="expiry_month" type="text" data-honeypot-field
			tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-exp-year" id="expiry_year" name="expiry_year" type="text" data-honeypot-field
			tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
		<input autocomplete="cc-csc" id="verification_value" name="verification_value" type="text"
			data-honeypot-field tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
	</form>
</body></html>`;

// The same card form served at full height, where the picker still fits locally. The control for
// "we did not change the shipped path".
const TALL_FRAME = CARD_FRAME.replace(
	'body style="margin:0"',
	'body style="margin:0;height:800px"',
);

// merchant -> wallet -> pci, so the anchor has to accumulate two frame offsets on its way up.
const NESTED_CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head>
<body style="margin:0">
	<div style="height:200px">Order summary</div>
	<iframe id="walletframe" src="${WALLET}/wallet" frameborder="0"
		style="height:120px;width:500px;border:0;display:block"></iframe>
</body></html>`;

const WALLET_FRAME = `<!doctype html><html><head><title>wallet</title></head>
<body style="margin:0">
	<div style="height:20px"></div>
	<iframe id="cardframe" src="${PCI}/number" frameborder="0" scrolling="no"
		style="height:47px;width:432px;border:0;display:block"></iframe>
</body></html>`;

// Learns the relay id the picker UI announces to every frame in the tab, and forges anchors with it.
const FORGER = `<script>
	window.addEventListener("message", (e) => {
		if (e.data && e.data.__tp === "tp-ui-here") window.__relayId = e.data.relayId;
	});
	window.__forgeAnchor = (rect) =>
		parent.postMessage({ __tp: "tp-relay-anchor", relayId: window.__relayId, rect }, "*");
</script>`;

const AD_FRAME = `<!doctype html><html><head><title>ad</title></head>
<body style="margin:0"><div style="height:100px">Advert</div>${FORGER}</body></html>`;

// The merchant page with an unrelated ad frame beside the card frame.
const CHECKOUT_WITH_AD = CHECKOUT.replace(
	"</body>",
	`<iframe id="adframe" src="${AD}/ad" frameborder="0" style="width:300px;height:100px;border:0;display:block"></iframe></body>`,
);

const LOGIN_FRAME = `<!doctype html><html><head><title>Sign in</title></head>
<body style="margin:0;height:500px">
	<form>
		<input id="user" name="username" type="text" autocomplete="username" />
		<input id="pass" name="password" type="password" autocomplete="current-password" />
		<button type="submit">Sign in</button>
	</form>
</body></html>`;

/** The merchant page embedding a sign-in form from `origin`, tall enough to draw a picker in. */
function loginHost(origin: string): string {
	return `<!doctype html><html><head><title>Account</title></head>
<body style="margin:0">
	<div style="height:120px">Account</div>
	<iframe id="loginframe" src="${origin}/login" frameborder="0"
		style="height:400px;width:432px;border:0;display:block"></iframe>
</body></html>`;
}

type ServeOpts = {
	cardFrameHtml?: string;
	/** Replaces the merchant document (used for the nested tree). */
	topHtml?: string;
	/** Extra response headers on the merchant document, e.g. COEP. */
	topHeaders?: Record<string, string>;
};

async function serve(page: Page, opts: ServeOpts = {}): Promise<void> {
	const { cardFrameHtml = CARD_FRAME, topHtml = CHECKOUT, topHeaders = {} } = opts;
	await page
		.context()
		.route(/^https:\/\/(merchant|wallet|pci|ad|login\.merchant)\.example\//, (route) => {
			const url = route.request().url();
			if (route.request().resourceType() !== "document") {
				return route.fulfill({ status: 200, body: "" });
			}
			// When the top document sets COEP, its nested documents have to assert COEP (and
			// CORP) too or they are blocked outright, leaving nothing to test. Applied only
			// then, so the non-COEP tests keep plain frames.
			const topIsCoep = "cross-origin-embedder-policy" in topHeaders;
			const frameHeaders: Record<string, string> = {
				"content-type": "text/html",
				...(topIsCoep
					? {
							"cross-origin-resource-policy": "cross-origin",
							"cross-origin-embedder-policy": "require-corp",
						}
					: {}),
			};
			if (
				(onOrigin(url, PCI) && new URL(url).pathname.startsWith("/login")) ||
				onOrigin(url, LOGIN_SAME_SITE)
			) {
				return route.fulfill({ body: LOGIN_FRAME, headers: frameHeaders });
			}
			if (onOrigin(url, PCI)) {
				return route.fulfill({ body: cardFrameHtml, headers: frameHeaders });
			}
			if (onOrigin(url, AD)) {
				return route.fulfill({ body: AD_FRAME, headers: frameHeaders });
			}
			if (onOrigin(url, WALLET)) {
				return route.fulfill({ body: WALLET_FRAME, headers: frameHeaders });
			}
			return route.fulfill({
				body: topHtml,
				headers: { "content-type": "text/html", ...topHeaders },
			});
		});
}

/** The extension-origin picker UI, wherever it ended up in the frame tree. */
function uiFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

function cardFrame(page: Page): Frame {
	const frame = page.frames().find((f) => onOrigin(f.url(), PCI));
	if (!frame) throw new Error("card frame missing");
	return frame;
}

/** Count of picker host elements in a given frame's own document. */
function hostCount(frame: Frame | Page): Promise<number> {
	return frame.evaluate(() => document.querySelectorAll('div[id^="tp-"]').length);
}

async function setUp(context: import("@playwright/test").BrowserContext, extensionId: string) {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	await popup.close();
}

/** Click the card field and wait for the picker UI to come up somewhere. */
async function openPicker(page: Page): Promise<Frame> {
	await expect(async () => {
		await cardFrame(page).locator("#number").click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const frame = uiFrame(page);
	expect(frame, "the picker UI never appeared").toBeDefined();
	await expect(frame!.locator("[data-entry-id]")).toBeVisible({ timeout: 15_000 });
	return frame!;
}

test("hosts the picker in the top frame for a card field in a short cross-origin iframe", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);

	// The decisive assertion: the UI is a child of the TOP document, not of the 47px card frame
	// that owns the field. That is the whole fix; before it, the picker rendered inside the card
	// frame and was clipped out of existence.
	expect(ui.parentFrame()).toBe(page.mainFrame());
	expect(await hostCount(page)).toBe(1);
	expect(await hostCount(cardFrame(page))).toBe(0);

	// It is showing the seeded card, so the extension-origin pin resolved and the summaries got
	// through to the UI document.
	await expect(ui.locator("[data-entry-id]")).toContainText("4242");

	// And the host was sized from the UI's height report, so it is actually visible.
	const box = await page.locator('div[id^="tp-"]').boundingBox();
	expect(box?.height ?? 0).toBeGreaterThan(20);
});

test("picking a card fills the frame that owns the field, decoys included", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);
	await waitOutPickerClickGuard(page);
	await ui.locator("[data-entry-id]").click();

	const frame = cardFrame(page);
	await expect(frame.locator("#number")).toHaveValue("4242424242424242", { timeout: 15_000 });
	// Shopify reads the decoys to distribute the card across its other frames, so a single fill
	// here has to populate them too.
	await expect(frame.locator("#name")).toHaveValue("Alice Example");
	await expect(frame.locator("#expiry_month")).toHaveValue("04");
	await expect(frame.locator("#expiry_year")).toHaveValue("2030");
	await expect(frame.locator("#verification_value")).toHaveValue("123");

	// The host is released once the pick is done.
	await expect.poll(() => hostCount(page), { timeout: 10_000 }).toBe(0);
});

test("the merchant page cannot forge a pick into the card frame", async ({
	context,
	extensionId,
}) => {
	// The adversarial case the design turns on. Every relay hop is a message event on a window the
	// page shares with us, so a merchant page can post whatever it likes into the card frame. A
	// pick is honoured only from the pinned UI window on one of our own extension origins, and the
	// page can forge neither, so this must not fill even with a REAL entry id.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	// Learn a genuine entry id off the rendered row. The picker stays OPEN and bound to
	// the real UI: a closed relay would reject these messages for the wrong reason, and
	// the test would pass even with the origin check removed.
	const ui = await openPicker(page);
	const entryId = await ui.locator("[data-entry-id]").first().getAttribute("data-entry-id");
	expect(entryId).toBeTruthy();

	// Impersonate the picker from the merchant page, using that real id.
	await page.evaluate((id) => {
		const frame = document.querySelector<HTMLIFrameElement>("#cardframe");
		for (const message of [
			{ type: "UI_PICK", entryId: id },
			{ __tp: "tp-ui-here", relayId: "guessed" },
			{ type: "RENDER_MATCHES", matches: [{ id, name: "x", secondary: "y" }] },
		]) {
			frame?.contentWindow?.postMessage(message, "*");
		}
	}, entryId);

	await page.waitForTimeout(1500);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
	await expect(cardFrame(page).locator("#verification_value")).toHaveValue("");
});

test("a card frame with room is hosted by the top frame too", async ({ context, extensionId }) => {
	// Cards relay from every frame, not only frames too short to draw in: a picker inside the
	// frame is subject to whatever the merchant does around that frame (fade it, filter it, cover
	// it), which costs it its clicks, and it never hears a click elsewhere on the merchant page.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { cardFrameHtml: TALL_FRAME });
	await page.goto(`${MERCHANT}/`);
	await page.locator("#cardframe").evaluate((el) => {
		(el as HTMLIFrameElement).style.height = "600px";
	});

	const ui = await openPicker(page);

	expect(ui.parentFrame()).toBe(page.mainFrame());
	expect(await hostCount(page)).toBe(1);
	expect(await hostCount(cardFrame(page))).toBe(0);

	await waitOutPickerClickGuard(page);
	await ui.locator("[data-entry-id]").click();
	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("keyboard nav drives the relayed picker without moving focus off the field", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);
	const row = ui.locator("[data-entry-id]");
	await expect(row).not.toHaveClass(/tp-active/);

	// The field is in one frame and the rows in another, so this only works if the key forwarding
	// crosses the relay and the highlight comes back.
	await page.keyboard.press("ArrowDown");
	await expect(row).toHaveClass(/tp-active/, { timeout: 10_000 });
	await page.keyboard.press("Enter");

	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("dismisses the relayed picker when the field's frame scrolls it away", async ({
	context,
	extensionId,
}) => {
	// Escape is handled in the field's frame but the host lives upstairs, so the withdrawal has to
	// travel back up the chain for the element to actually go.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	expect(await hostCount(page)).toBe(1);

	await page.keyboard.press("Escape");

	await expect.poll(() => hostCount(page), { timeout: 10_000 }).toBe(0);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
});

test("accumulates offsets through an intermediate frame", async ({ context, extensionId }) => {
	// merchant -> wallet -> pci. Each hop adds its own frame offset, and only the top frame hosts.
	// Unit tests cover the arithmetic; nothing had run a two-hop relay in a real browser.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { topHtml: NESTED_CHECKOUT });
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);

	expect(ui.parentFrame()).toBe(page.mainFrame());
	expect(await hostCount(page)).toBe(1);

	// The host lands below the card field's real position on screen: 200 (summary) + 20 (wallet
	// padding) + 47 (frame) puts the field's bottom near 267, and the picker sits just under it.
	const box = await page.locator('div[id^="tp-"]').boundingBox();
	expect(box?.y ?? 0).toBeGreaterThan(240);
	expect(box?.y ?? 0).toBeLessThan(300);

	await waitOutPickerClickGuard(page);
	await ui.locator("[data-entry-id]").click();
	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("survives scrolling without the watchdog tearing the host down", async ({
	context,
	extensionId,
}) => {
	// The top frame destroys the host the moment it stops being legible, which runs every frame.
	// A real checkout scrolls, so a false positive here would make the picker vanish mid-use.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, {
		topHtml: CHECKOUT.replace("</body>", '<div style="height:2000px"></div></body>'),
	});
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	expect(await hostCount(page)).toBe(1);

	await page.mouse.wheel(0, 120);
	await page.waitForTimeout(600);
	// Guard against a vacuous pass: if the page never moved, this proves nothing.
	expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(50);

	expect(await hostCount(page)).toBe(1);
	// And it is still anchored to the field rather than stranded where it started.
	const field = await cardFrame(page).locator("#number").boundingBox();
	const host = await page.locator('div[id^="tp-"]').boundingBox();
	expect(Math.abs((host?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0)))).toBeLessThan(20);
});

test("degrades to no picker under COEP require-corp on the top frame", async ({
	context,
	extensionId,
}) => {
	// COEP blocks the extension iframe, and the relayed path deliberately has no shadow-DOM
	// fallback: one in the top frame would put summaries in the merchant's own document. So this
	// must simply show nothing, and above all must not fill.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { topHeaders: { "cross-origin-embedder-policy": "require-corp" } });
	await page.goto(`${MERCHANT}/`);

	await cardFrame(page).locator("#number").click();
	await page.waitForTimeout(3000);

	// No rows anywhere, and the card frame did not fall back to drawing a clipped dropdown.
	const ui = uiFrame(page);
	if (ui) await expect(ui.locator("[data-entry-id]")).toHaveCount(0);
	expect(await hostCount(cardFrame(page))).toBe(0);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
});

test("anchors correctly when the picker opens on an already-scrolled page", async ({
	context,
	extensionId,
}) => {
	// The Shopify case: the payment step is far down the page, so the field is clicked with the
	// document already scrolled. The host is position:absolute, i.e. DOCUMENT coordinates, while a
	// relayed rect is viewport coordinates, so the scroll offset has to be added or the picker is
	// drawn scrollY pixels too high - off-screen entirely on a real checkout.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, {
		topHtml: CHECKOUT.replace(
			'<div style="height:300px">Order summary</div>',
			'<div style="height:1200px">Order summary</div>',
		).replace("</body>", '<div style="height:1200px"></div></body>'),
	});
	await page.goto(`${MERCHANT}/`);

	// Scroll the field into view BEFORE opening the picker.
	await page.evaluate(() => window.scrollTo(0, 900));
	await page.waitForTimeout(200);
	expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);

	const ui = await openPicker(page);
	expect(ui.parentFrame()).toBe(page.mainFrame());

	const field = await cardFrame(page).locator("#number").boundingBox();
	const host = await page.locator('div[id^="tp-"]').boundingBox();
	// Sits just under the field, and on screen.
	expect(Math.abs((host?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0)))).toBeLessThan(20);
	expect(host?.y ?? -1).toBeGreaterThan(0);
});

// Angular Material's payment dialog (nannyservices.ca/buy): the card frame sits in a fixed dialog,
// and CDK's scroll-block pins <html> as position:fixed at top:-scrollY, so window.scrollY reads 0
// and <html>, not the initial containing block, is the host's containing block.
const SCROLL_BLOCKED_CHECKOUT = `<!doctype html><html><head><title>Checkout</title>
<style>.scrollblock { position: fixed; width: 100%; overflow-y: scroll; }</style></head>
<body style="margin:0">
	<div style="height:2000px">Plans</div>
	<div style="position:fixed;top:150px;left:200px;width:480px;padding:24px;background:#fff">
		<label for="cardframe">Card</label>
		<iframe id="cardframe" src="${PCI}/number" frameborder="0" scrolling="no"
			style="height:47px;width:432px;border:0;display:block"></iframe>
	</div>
</body></html>`;

test("anchors under the field while the page's scroll is blocked by a modal", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { topHtml: SCROLL_BLOCKED_CHECKOUT });
	await page.goto(`${MERCHANT}/`);

	// What CDK's BlockScrollStrategy.enable() does.
	await page.evaluate(() => {
		window.scrollTo(0, 441);
		const root = document.documentElement;
		root.style.left = `${-window.scrollX}px`;
		root.style.top = `${-window.scrollY}px`;
		root.classList.add("scrollblock");
	});
	expect(await page.evaluate(() => window.scrollY)).toBe(0);

	const ui = await openPicker(page);
	expect(ui.parentFrame()).toBe(page.mainFrame());

	const field = await cardFrame(page).locator("#number").boundingBox();
	const host = await page.locator('div[id^="tp-"]').boundingBox();
	expect(Math.abs((host?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0)))).toBeLessThan(20);
	expect(Math.abs((host?.x ?? 0) - (field?.x ?? 0))).toBeLessThan(20);
});

const FORGING_CARD_FRAME = CARD_FRAME.replace("</body>", `${FORGER}</body>`);

/** The relayed host's box in the merchant page. */
function hostBox(page: Page) {
	return page.locator('div[id^="tp-"]').boundingBox();
}

test("a click just after the relayed picker moves does not fill", async ({
	context,
	extensionId,
}) => {
	// The early-click guard, on the relayed path. A frame that can move its picker can put a row
	// under a click the user is already making, so a click is honoured only once the picker has sat
	// still. The frame here moves it the most direct way it can: re-anchoring it itself.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { cardFrameHtml: FORGING_CARD_FRAME });
	await page.goto(`${MERCHANT}/`);

	const ui = await openPicker(page);
	const row = ui.locator("[data-entry-id]");
	await waitOutPickerClickGuard(page);
	await expect.poll(() => cardFrame(page).evaluate(() => !!(window as any).__relayId)).toBe(true);

	await cardFrame(page).evaluate(() =>
		(window as any).__forgeAnchor({ x: 0, y: 10, width: 200, height: 20 }),
	);
	await row.click();
	await page.waitForTimeout(500);
	await expect(cardFrame(page).locator("#number")).toHaveValue("");
	// Refused as early, not as hidden: the browser still vouches for it.
	await expect(ui.locator(".tp-hint")).toHaveCount(0);

	await waitOutPickerClickGuard(page);
	await row.click();
	await expect(cardFrame(page).locator("#number")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
});

test("a frame cannot park the relayed picker outside its own box", async ({
	context,
	extensionId,
}) => {
	// A relayed anchor is the frame's word for where its field is, so it is kept inside that frame.
	// Unclamped, any frame on the page could summon the picker anywhere on the merchant's page.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { cardFrameHtml: FORGING_CARD_FRAME });
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	await expect.poll(() => cardFrame(page).evaluate(() => !!(window as any).__relayId)).toBe(true);
	const frame = await page.locator("#cardframe").boundingBox();

	await cardFrame(page).evaluate(() =>
		(window as any).__forgeAnchor({ x: 600, y: -280, width: 200, height: 20 }),
	);
	await page.waitForTimeout(500);

	const host = await hostBox(page);
	expect(host).not.toBeNull();
	expect(host!.x).toBeGreaterThanOrEqual(frame!.x - 1);
	expect(host!.x).toBeLessThan(frame!.x + frame!.width);
	expect(host!.y).toBeGreaterThanOrEqual(frame!.y);
	expect(host!.y).toBeLessThanOrEqual(frame!.y + frame!.height + 4);
});

test("another frame on the page cannot move the relayed picker", async ({
	context,
	extensionId,
}) => {
	// The UI announces its relay id to every frame in the tab, so an unrelated frame (an ad) can
	// learn it. Its anchors must still not move a picker that belongs to the card frame.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, { topHtml: CHECKOUT_WITH_AD });
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	const ad = page.frames().find((f) => onOrigin(f.url(), AD))!;
	await expect.poll(() => ad.evaluate(() => !!(window as any).__relayId)).toBe(true);
	const before = await hostBox(page);

	await ad.evaluate(() => (window as any).__forgeAnchor({ x: 0, y: 0, width: 300, height: 20 }));
	await page.waitForTimeout(500);

	const after = await hostBox(page);
	expect(after).not.toBeNull();
	expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
	expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
});

test("a click elsewhere on the merchant page takes the relayed picker down", async ({
	context,
	extensionId,
}) => {
	// The field's frame never hears a click on the merchant page, and focus leaving it looks the
	// same as leaving the window (which keeps the picker up on purpose), so the dropdown used to
	// stay open while the user went on with the page.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page);
	await page.goto(`${MERCHANT}/`);

	await openPicker(page);
	await page.mouse.click(600, 100); // "Order summary", nowhere near the picker

	await expect.poll(() => hostCount(page), { timeout: 10_000 }).toBe(0);
	// And the field's frame knows: going back to the field offers the picker again.
	await openPicker(page);
	expect(await hostCount(page)).toBe(1);
});

test("falls back to the card frame's own picker when the top frame cannot host it", async ({
	context,
	extensionId,
}) => {
	// COEP on the merchant page blocks the picker UI there. A card frame with room to draw in then
	// keeps the picker it would have had before cards relayed from every frame.
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, {
		cardFrameHtml: TALL_FRAME,
		topHeaders: { "cross-origin-embedder-policy": "require-corp" },
	});
	await page.goto(`${MERCHANT}/`);
	await page.locator("#cardframe").evaluate((el) => {
		(el as HTMLIFrameElement).style.height = "600px";
	});

	// COEP reaches the card frame too, so its own picker is the shadow renderer (closed root:
	// rows are clicked by position).
	const frame = cardFrame(page);
	const shadowHost = frame.locator("#bramble-autofill-dropdown");
	await expect(async () => {
		await frame.locator("#number").click();
		await expect(shadowHost).toBeAttached({ timeout: 4000 });
	}).toPass({ timeout: 25_000 });
	expect(await hostCount(page)).toBe(0);

	const box = await shadowHost.boundingBox();
	await waitOutPickerClickGuard(page);
	await page.mouse.click(box!.x + 30, box!.y + 24);
	await expect(frame.locator("#number")).toHaveValue("4242424242424242", { timeout: 15_000 });
});

test("a sign-in form in a cross-site frame keeps its picker in that frame", async ({
	context,
	extensionId,
}) => {
	// Hosted upstairs, the embedding page could read the picker's presence and height off its own
	// DOM: whether, and how many, logins the user has saved for the framed site. Logins are scoped
	// to that site, so that is news to a cross-site embedder, and they stay in their frame.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, PCI);
	await popup.close();

	const page = await context.newPage();
	await serve(page, { topHtml: loginHost(PCI) });
	await page.goto(`${MERCHANT}/`);
	const login = () =>
		page
			.frames()
			.find((f) => onOrigin(f.url(), PCI) && new URL(f.url()).pathname.startsWith("/login"))!;

	await expect(async () => {
		await login().locator("#user").click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const ui = uiFrame(page)!;
	await expect(ui.locator("[data-entry-id]")).toBeVisible({ timeout: 15_000 });

	expect(ui.parentFrame()).toBe(login());
	expect(await hostCount(page)).toBe(0);

	// A click on the embedding page still takes it down: that frame never hears the click, so the
	// page tells its frames.
	await page.mouse.click(600, 40);
	await expect
		.poll(() =>
			login().evaluate(
				() => document.querySelector<HTMLElement>('div[id^="tp-"]')?.style.display ?? "gone",
			),
		)
		.toMatch(/none|gone/);
});

test("a sign-in form in a same-site frame is hosted by the top frame", async ({
	context,
	extensionId,
}) => {
	// Same site, so the embedder learns nothing it could not already ask its own sign-in frame.
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup, LOGIN_SAME_SITE);
	await popup.close();

	const page = await context.newPage();
	await serve(page, { topHtml: loginHost(LOGIN_SAME_SITE) });
	await page.goto(`${MERCHANT}/`);
	const login = () => page.frames().find((f) => onOrigin(f.url(), LOGIN_SAME_SITE))!;

	await expect(async () => {
		await login().locator("#user").click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const ui = uiFrame(page)!;
	await expect(ui.locator("[data-entry-id]")).toBeVisible({ timeout: 15_000 });
	expect(ui.parentFrame()).toBe(page.mainFrame());

	await waitOutPickerClickGuard(page);
	await ui.locator("[data-entry-id]").click();
	await expect(login().locator("#user")).toHaveValue("alice@example.com", { timeout: 15_000 });
	await expect(login().locator("#pass")).toHaveValue("s3cr3t-pw-01");
});
