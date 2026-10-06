import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addVirtualAuthenticator, backgroundWorker, createVault, openPopup } from "./helpers";

// The passkey provider end-to-end, through the real chrome.webAuthenticationProxy in the
// built extension. This is the regression suite for the Cloudflare Access filing
// (tracker bramble-planning#18): with the provider attached, a get() the vault cannot
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

/** Click the primary (left) action button of the corner card by its bounding box. The
 *  buttons live in a closed shadow root, so selectors cannot reach them; the y offset is
 *  measured from the card's bottom. 40 = the actions row is the last element (the
 *  no-match card). Cards that also render the tertiary "use another authenticator" link
 *  (all save variants) have ~54px of link below the actions, so pass ~70. */
async function clickCardPrimary(page: Page, yOffsetFromBottom = 40): Promise<void> {
	const card = page.locator("#bramble-corner-prompt");
	await expect(card).toBeAttached({ timeout: 10_000 });
	const box = await card.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.click(box!.x + 100, box!.y + box!.height - yOffsetFromBottom);
}

test("a step-up get() with no matching passkey hands off instead of dead-ending (tracker #18)", async ({
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

	// Refusal #1: the card's x ("Not now" on every other variant; on the no-match card
	// the primary is the handoff and the x is the refusal). The user's expectation:
	// declining makes Bramble step aside, not fail the request cold.
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
	await expect.poll(prefIsOn, { timeout: 10_000 }).toBe(false);

	// Refusal #2 via the primary button, after re-enabling: same outcome.
	await enableProvider(context, extensionId);
	await page.locator("#step-up").click();
	await clickCardPrimary(page);
	await expect(page.locator("#out")).toHaveText(
		/step-up :: NotAllowedError \| .*another authenticator/i,
		{
			timeout: 10_000,
		},
	);
	await expect.poll(prefIsOn, { timeout: 10_000 }).toBe(false);

	// And native WebAuthn is genuinely reachable again: a virtual platform authenticator
	// (the CDP kind, standing in for Touch ID) now serves the enrollment the proxy
	// would have intercepted before the handoff.
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
	await enableProvider(context, extensionId);

	const page = await context.newPage();
	await serve(page);
	await page.goto("http://localhost/");

	await page.locator("#enroll").click();
	const card = page.locator("#bramble-corner-prompt");
	await expect(card).toBeAttached({ timeout: 10_000 });
	// The save card's actions row sits ABOVE the "what declining does" subnote, whose
	// height depends on wrapping; the note is inert, so sweep candidate offsets until
	// "Save passkey" lands. A landed click detaches the card and the page's promise
	// settles a beat later, so poll for the change rather than reading it instantly.
	const out = page.locator("#out");
	for (const fromBottom of [134, 118, 150, 102]) {
		const box = await card.boundingBox().catch(() => null);
		if (!box) break; // the card is gone: a click already landed
		await page.mouse.click(box.x + 85, box.y + box.height - fromBottom);
		const changed = await expect
			.poll(async () => out.innerText(), { timeout: 4_000 })
			.not.toBe("idle")
			.then(() => true)
			.catch(() => false);
		if (changed) break;
	}
	await expect(out).toHaveText(/enroll :: resolved public-key/i, { timeout: 10_000 });

	// The minted passkey really is in the vault: the popup lists the new login for the site.
	// (The popup reopens on the Settings route persisted by the enableProvider step, so
	// step back to the vault list first.)
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: "Go to vault" }).click();
	await expect(popup.getByText(/localhost/).first()).toBeVisible({ timeout: 10_000 });
});
