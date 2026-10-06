import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl } from "./helpers";

// The extension must evaluate its pages with no CSP violations at all: the zod eval probe
// (a caught `new Function("")`) used to log a securitypolicyviolation on every page even
// though it was harmless, because zod probes eval support before parsing. platform-api
// now sets zod's `jitless` config, so the probe must never run in extension pages.
test("extension pages load with no CSP violations (zod jitless)", async ({
	context,
	extensionId,
}) => {
	const violations: string[] = [];
	const collect = (page: { on: (ev: string, cb: (m: unknown) => void) => void }) => {
		page.on("console", (m: unknown) => {
			const msg = m as { type?: () => string; text?: () => string };
			const text = msg.text?.() ?? "";
			if (
				msg.type?.() === "error" &&
				(/blocked script/i.test(text) ||
					/securitypolicyviolation/i.test(text) ||
					/Content Security Policy/i.test(text) ||
					/Refused to/i.test(text))
			) {
				violations.push(text);
			}
		});
	};
	context.on("page", (p) => collect(p));
	// The service worker is its own realm with its own DevTools console; a probe or
	// violation there would never show on a page. Watch existing and future workers.
	const collectWorker = (sw: { on: (ev: string, cb: (m: unknown) => void) => void }) =>
		collect(sw as never);
	for (const sw of context.serviceWorkers()) collectWorker(sw);
	context.on("serviceworker", (sw) => collectWorker(sw));

	const page = await context.newPage();
	await createVault(page, extensionId); // full options-page flow: schema parses galore
	await page.goto(optionsUrl(extensionId));

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expect(popup.getByRole("button", { name: "Lock vault" })).toBeVisible();

	// Give any async violation a beat to surface.
	await popup.waitForTimeout(2_000);

	expect(violations).toEqual([]);
});
