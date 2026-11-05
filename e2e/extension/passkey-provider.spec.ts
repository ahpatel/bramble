import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	actOnPasskeyCard,
	addVirtualAuthenticator,
	backgroundWorker,
	clickCornerAction,
	clickCornerSelector,
	createVault,
	openPopup,
	STRONG_PW,
} from "./helpers";

// The passkey provider end-to-end, through the real chrome.webAuthenticationProxy in the
// built extension. This is the regression suite for the Cloudflare Access filing: with the
// provider attached, a get() the vault cannot
// serve used to dead-end the whole browser: Touch ID, iCloud Keychain and any YubiKey
// became unreachable. Now the no-match card hands the request to the user's other
// authenticators, and the create ceremony still mints and stores a passkey.
//
// Served on http://localhost (route-fulfilled): localhost is a first-class secure context
// with no TLS, so WebAuthn runs. An https origin fulfilled from a Playwright route carries
// a certificate-error security state and Chromium refuses WebAuthn on it outright.
//
// Card buttons live in a closed shadow root, so clicks are coordinate-based like the
// other corner-card specs (computed from the card's bounding box, bottom row = actions).

const FIXTURE = `<!doctype html><html><head><title>WebAuthn</title></head><body>
	<button id="step-up">Verify with a device you already registered</button>
	<button id="enroll">Enroll a new passkey</button>
	<button id="native-after">Enroll via the native authenticator</button>
	<div id="out">idle</div>
	<script>
		const out = document.getElementById("out");
		const record = (tag, text) => { out.textContent = tag + " :: " + text; };
		const publicKey = {
			challenge: crypto.getRandomValues(new Uint8Array(32)),
			rp: { name: "Localhost", id: "localhost" },
			user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "e2e@localhost", displayName: "E2E" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			timeout: 20_000,
			attestation: "none",
		};
		// The Cloudflare Access step-up shape: allowCredentials lists the devices the RP
		// already holds for the user, none of which this vault stores.
		document.getElementById("step-up").onclick = async () => {
			try {
				const c = await navigator.credentials.get({ publicKey: {
					challenge: crypto.getRandomValues(new Uint8Array(32)),
					rpId: "localhost",
					allowCredentials: [{ type: "public-key", id: Uint8Array.from([1, 2, 3, 4]) }],
					userVerification: "required",
					timeout: 20_000,
				}});
				record("step-up", "resolved " + c.type);
			} catch (e) { record("step-up", e.name + " | " + e.message); }
		};
		document.getElementById("enroll").onclick = async () => {
			try {
				const c = await navigator.credentials.create({ publicKey });
				record("enroll", "resolved " + c.type);
			} catch (e) { record("enroll", e.name + " | " + e.message); }
		};
		document.getElementById("native-after").onclick = async () => {
			try {
				const c = await navigator.credentials.create({ publicKey });
				record("native-after", "resolved " + c.type);
			} catch (e) { record("native-after", e.name + " | " + e.message); }
		};
	</script>
</body></html>`;

async function serve(page: Page): Promise<void> {
	await page
		.context()
		.route(/localhost/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: FIXTURE, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
}

/** Enable the provider through the real Settings toggle, exactly as a user does. */
async function enableProvider(context: BrowserContext, extensionId: string) {
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();
	const toggle = popup.getByRole("button", { name: "Toggle Bramble passkey provider" });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await popup.close();
}

test("a step-up get() with no matching passkey hands off instead of dead-ending", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await enableProvider(context, extensionId);

	const page = await context.newPage();
	await serve(page);
	await page.goto("http://localhost/");
	const sw = await backgroundWorker(context);
	const prefIsOn = async () =>
		sw.evaluate(async () => {
			const r = await chrome.storage.local.get("pref.passkeyProviderEnabled");
			return r["pref.passkeyProviderEnabled"];
		});
	const badge = async () => sw.evaluate(() => chrome.action.getBadgeText({}));

	// The no-match card's x: any exit is the handoff (Bramble cannot serve this request
	// at all), and the handoff opens the bypass window.
	await page.locator("#step-up").click();
	const card = page.locator("#bramble-corner-prompt");
	await expect(card).toBeAttached({ timeout: 10_000 });
	const box = await card.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + box!.width - 32, box!.y + 30); // the x (center of the close glyph)
	await expect(page.locator("#out")).toHaveText(
		/step-up :: NotAllowedError \| .*another authenticator/i,
		{
			timeout: 10_000,
		},
	);
	// The pause is visible (badge) and the Settings pref, the durable state, is exactly
	// as the user left it. The window is a pause, not a configuration change.
	await expect.poll(badge, { timeout: 10_000 }).toBe("⏸");
	expect(await prefIsOn()).toBe(true);

	// The window closes when the tab navigates (login flows redirect), and the provider
	// re-attaches with no Settings round-trip: the next no-match request gets the card.
	await page.goto("http://localhost/?after");
	await expect.poll(badge, { timeout: 10_000 }).toBe("");
	await page.locator("#step-up").click();
	await expect(card).toBeAttached({ timeout: 10_000 });
	expect(await prefIsOn()).toBe(true);

	// The primary button is the same handoff: the message lands, the pause shows, and
	// Settings still stay untouched.
	await clickCornerAction(page, "passkey-native");
	await expect(page.locator("#out")).toHaveText(
		/step-up :: NotAllowedError \| .*another authenticator/i,
		{
			timeout: 10_000,
		},
	);
	await expect.poll(badge, { timeout: 10_000 }).toBe("⏸");
	expect(await prefIsOn()).toBe(true);

	// Last (CDP's WebAuthn domain shadows the extension proxy for every request after
	// it): while the window is open, the site's WebAuthn genuinely reaches the platform
	// authenticator, a virtual platform authenticator standing in for Touch ID.
	const virtual = await addVirtualAuthenticator(page, { transport: "internal" });
	try {
		await page.locator("#native-after").click();
		await expect(page.locator("#out")).toHaveText(/native-after :: resolved public-key/i, {
			timeout: 10_000,
		});
	} finally {
		await virtual.remove();
	}
});
test("an enrollment create() still mints and stores a passkey through the provider", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	// Enable directly, as the PRF e2e does: the Settings popup would close and lock the
	// vault, and this test is about the create ceremony, not the toggle.
	await setup.evaluate(() =>
		chrome.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled: true },
		}),
	);

	const page = await context.newPage();
	await serve(page);
	await page.goto("http://localhost/");

	const out = page.locator("#out");
	// The fixture asks for UV, so approving the card opens the confirm-it's-you window.
	const verifyWindow = context.waitForEvent("page");
	const result = actOnPasskeyCard(page, "passkey-approve", () => page.locator("#enroll").click());
	const verify = await verifyWindow;
	await verify.getByLabel("Master password").fill(STRONG_PW);
	await verify.getByRole("button", { name: "Confirm" }).click();
	await result;
	await expect(out).toHaveText(/enroll :: resolved public-key/i, { timeout: 10_000 });

	// The minted passkey really is in the vault: the popup lists the new login for the site.
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	const goToVault = popup.getByRole("button", { name: "Go to vault" });
	if (await goToVault.isVisible().catch(() => false)) await goToVault.click();
	await expect(popup.getByText(/localhost/).first()).toBeVisible({ timeout: 10_000 });
});

test("'always for this site' auto-pauses on the next visit", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await enableProvider(context, extensionId);

	const page = await context.newPage();
	await serve(page);
	await page.goto("http://localhost/");
	const sw = await backgroundWorker(context);
	const prefIsOn = async () =>
		sw.evaluate(async () => {
			const r = await chrome.storage.local.get("pref.passkeyProviderEnabled");
			return r["pref.passkeyProviderEnabled"];
		});
	const badge = async () => sw.evaluate(() => chrome.action.getBadgeText({}));

	// First visit: no matching passkey, so the card offers the handoff. Checking "always
	// for this site" remembers the site as well as opening the window.
	await page.locator("#step-up").click();
	const card = page.locator("#bramble-corner-prompt");
	await expect(card).toBeAttached({ timeout: 10_000 });
	await clickCornerSelector(page, "#tp-remember-site");
	await clickCornerAction(page, "passkey-native");
	await expect(page.locator("#out")).toHaveText(
		/step-up :: NotAllowedError \| .*another authenticator/i,
		{ timeout: 10_000 },
	);
	await expect.poll(badge, { timeout: 10_000 }).toBe("⏸");
	expect(await prefIsOn()).toBe(true);

	// Next visit: the remembered site pauses before the first WebAuthn call, so no card
	// appears at all and the browser's own authenticator serves the page.
	await page.goto("http://localhost/?again");
	await expect.poll(badge, { timeout: 10_000 }).toBe("⏸");
	await expect(card).not.toBeAttached();

	const virtual = await addVirtualAuthenticator(page, { transport: "internal" });
	try {
		await page.locator("#native-after").click();
		await expect(page.locator("#out")).toHaveText(/native-after :: resolved public-key/i, {
			timeout: 10_000,
		});
	} finally {
		await virtual.remove();
	}
});
