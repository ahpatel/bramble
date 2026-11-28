// The account page (docs/mailbox-service.md): opening an account,
// reading its status, and buying time, with billing, the mailbox and Stripe faked in mocks.ts.

import { expect, type Page, test } from "@playwright/test";
import { mockServices, type Services } from "./mocks";

const NUMBER = "11111 22222 33333 44444 55555";
const DIGITS = NUMBER.replace(/ /g, "");
const PAID = {
	paidThrough: Date.UTC(2027, 4, 2),
	frozen: false,
	usedBytes: 12_000_000,
	quotaBytes: 1_000_000_000,
};

let services: Services;
test.beforeEach(async ({ context, page }) => {
	services = await mockServices(context, NUMBER);
	services.status = () => ({ code: 200, body: PAID });
	// The Bitcoin and Monero buttons are behind a website flag until they launch.
	await page.goto("/?ff=crypto");
});
test.afterEach(() => {
	// The fragment never reaches a server, and nothing else may carry the number in a URL.
	for (const url of services.all) expect(url).not.toContain(DIGITS);
});

const callsTo = (path: string) => services.calls.filter((c) => new URL(c.url).pathname === path);
const remembered = (page: Page) => page.evaluate(() => sessionStorage.getItem("bramble.account"));

/** Open the page as an app's "Add time" does, and say the number is yours. */
async function fromApp(page: Page) {
	await page.goto(`/account/#n=${DIGITS}`);
	await page.getByRole("button", { name: "Yes, it's mine" }).click();
}

test("a new account is created behind the check, shown once, and bought", async ({ page }) => {
	await page.goto("/account/");
	await page.getByRole("button", { name: "Create an account" }).click();
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Credit/Debit card" }).click();
	await page.waitForURL(/checkout\.stripe\.com/);
	const [checkout] = callsTo("/v1/checkout");
	const body = JSON.parse(checkout?.body ?? "{}");
	expect(String(body.number).replace(/\D/g, "")).toBe(DIGITS);
	expect(body.months).toBe(6);
	expect(typeof body.altcha).toBe("string");
});

test("from an app, the number arrives in the fragment and leaves the address bar", async ({
	page,
}) => {
	await fromApp(page);
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	expect(page.url()).not.toContain("#");
	const [status] = callsTo("/v1/accounts/status");
	expect(status?.headers["x-bramble-account"]?.replace(/\D/g, "")).toBe(DIGITS);
});

test("a double click starts one checkout", async ({ page }) => {
	await fromApp(page);
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	await page.getByRole("button", { name: "12", exact: true }).click();
	await expect(page.getByText("12 months, $24")).toBeVisible();
	await page.getByRole("button", { name: "Credit/Debit card" }).dblclick();
	await page.waitForURL(/checkout\.stripe\.com/);
	expect(callsTo("/v1/checkout")).toHaveLength(1);
});

test("a number one digit short is refused before anything is sent", async ({ page }) => {
	await page.goto("/account/");
	await page.getByLabel("Account number").fill(DIGITS.slice(1));
	const before = services.calls.length;
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByText("An account number is 25 digits")).toBeVisible();
	expect(services.calls.length).toBe(before);
});

test("an unknown number says so", async ({ page }) => {
	services.status = () => ({ code: 403, body: { error: "account_unknown" } });
	await fromApp(page);
	await expect(page.getByText("That account number isn't recognized.")).toBeVisible();
});

const DAY = 86_400_000;

const PURCHASE = {
	id: "p1",
	day: "2026-10-30",
	days: 184,
	refundDays: 171,
	refundAmount: 1260,
	currency: "usd",
};

test("lists refundable purchases and refunds the one chosen, saying what comes back", async ({
	page,
}) => {
	let listed = [PURCHASE];
	services.purchases = () => ({ code: 200, body: { purchases: listed } });
	services.refund = () => {
		listed = [];
		return { code: 200, body: { days: 171, amount: 1260, currency: "usd" } };
	};
	await fromApp(page);
	await expect(page.getByText("2026-10-30: 184 days")).toBeVisible();
	await page.getByRole("button", { name: "Refund", exact: true }).click();
	await expect(
		page.getByText(
			/^Refund (US)?\$12\.60\? You pay for 13 days, and the other 171 come off the account\.$/,
		),
	).toBeVisible();
	await page.getByRole("button", { name: "Yes, refund" }).click();
	await expect(
		page.getByText(/^Refunded (US)?\$12\.60\. 171 days came off the account\.$/),
	).toBeVisible();
	const [refund] = callsTo("/v1/refunds");
	expect(JSON.parse(refund?.body ?? "{}")).toEqual({ number: NUMBER, purchase: "p1" });
	await expect(
		page.getByText("Nothing to refund. Purchases can be refunded for 14 days."),
	).toBeVisible();
});

test("one day reads as one day", async ({ page }) => {
	services.purchases = () => ({
		code: 200,
		body: { purchases: [{ ...PURCHASE, refundDays: 183, refundAmount: 1348 }] },
	});
	await fromApp(page);
	await page.getByRole("button", { name: "Refund", exact: true }).click();
	await expect(page.getByText(/You pay for 1 day, and the other 183 come off/)).toBeVisible();
});

test("the page says card refunds take off the days since buying, and crypto has none", async ({
	page,
}) => {
	await fromApp(page);
	await expect(page.getByText(/A Bitcoin or Monero payment can't be refunded/)).toBeVisible();
	await expect(
		page.getByText(/can be refunded within 14\s+days, less the days since you bought it/),
	).toBeVisible();
});

test("a purchase past its window can't be refunded", async ({ page }) => {
	services.purchases = () => ({
		code: 200,
		body: { purchases: [{ ...PURCHASE, id: "p2", day: "2026-10-01" }] },
	});
	services.refund = () => ({ code: 404, body: { error: "nothing_to_refund" } });
	await fromApp(page);
	await page.getByRole("button", { name: "Refund", exact: true }).click();
	await page.getByRole("button", { name: "Yes, refund" }).click();
	await expect(page.getByText("That purchase can't be refunded.")).toBeVisible();
});

test("after paying, the page waits for the time to land", async ({ page }) => {
	const before = PAID.paidThrough;
	await page.addInitScript(
		([number, paidThrough]) => {
			sessionStorage.setItem("bramble.account", number);
			sessionStorage.setItem("bramble.paidThrough", paidThrough);
		},
		[NUMBER, String(before)],
	);
	let asked = 0;
	services.status = () => ({
		code: 200,
		body: { ...PAID, paidThrough: asked++ === 0 ? before : before + 184 * DAY },
	});
	await page.goto("/account/paid");
	await expect(page.getByText(/^Payment received\. Paid through /)).toBeVisible({
		timeout: 15_000,
	});
	expect(asked).toBeGreaterThan(1);
	// More time on a number already in use: shown again, with nothing to set up.
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
	await expect(page.getByText(/nothing to change in Bramble/)).toBeVisible();
	await expect(page.getByRole("heading", { name: "What to do next" })).toBeHidden();
});

test("after a first payment, the page shows the number again and how to add it", async ({
	page,
}) => {
	await page.addInitScript((number) => {
		sessionStorage.setItem("bramble.account", number);
		sessionStorage.setItem("bramble.paidThrough", "0");
	}, NUMBER);
	await page.goto("/account/paid");
	await expect(page.getByText(/^Payment received\. Paid through /)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "What to do next" })).toBeVisible();
	await expect(page.getByText(/Under Mailbox, enter the number and choose Sign in/)).toBeVisible();
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.getByRole("button", { name: "Copy" }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(NUMBER);
});

test("cancelling at Stripe comes back to the account", async ({ page }) => {
	await page.addInitScript((number) => sessionStorage.setItem("bramble.account", number), NUMBER);
	await page.goto("/account/");
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	expect(callsTo("/v1/checkout")).toHaveLength(0);
});

test("Back from Stripe brings the page back with its buttons working", async ({ page }) => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	services.checkout = async () => {
		await held;
		return { code: 502, body: { error: "payment_provider" } };
	};
	await fromApp(page);
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	const six = page.getByRole("button", { name: "Credit/Debit card" });
	await six.click();
	await expect(six).toBeDisabled();
	await expect(six).toHaveAttribute("aria-busy", "true");
	// What a browser's back-forward cache does on Back: the page as it was left, then pageshow.
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
	);
	await expect(six).toBeEnabled();
	await expect(six).not.toHaveAttribute("aria-busy");
	release();
});

test("Create an account shows it's working until the account is open", async ({ page }) => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	services.account = async () => {
		await held;
		return { code: 200, body: { number: NUMBER } };
	};
	await page.goto("/account/");
	const create = page.getByRole("button", { name: "Create an account" });
	await create.click();
	await expect(create).toHaveAttribute("aria-busy", "true");
	await expect(create).toBeDisabled();
	release();
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
});

test("a failed checkout stops the spinner", async ({ page }) => {
	services.checkout = () => ({ code: 502, body: { error: "payment_provider" } });
	await fromApp(page);
	const six = page.getByRole("button", { name: "Credit/Debit card" });
	await six.click();
	await expect(
		page.getByText("The payment provider didn't answer. Try again shortly."),
	).toBeVisible();
	await expect(six).not.toHaveAttribute("aria-busy");
	await expect(six).toBeEnabled();
});

test("the full number can be shown and copied whenever the page knows it", async ({ page }) => {
	await page.addInitScript((number) => sessionStorage.setItem("bramble.account", number), NUMBER);
	await page.goto("/account/");
	await expect(page.getByText("••••• ••••• ••••• ••••• 55555")).toBeVisible();
	await expect(page.getByText(NUMBER, { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Show" }).click();
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
});

test("a number from a link is shown in full and used only once confirmed", async ({ page }) => {
	await page.goto(`/account/#n=${DIGITS}`);
	await expect(page.getByText("Is this your account number?")).toBeVisible();
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Credit/Debit card" })).toBeHidden();
	expect(await remembered(page)).toBeNull();
	expect(callsTo("/v1/accounts/status")).toHaveLength(0);
	await page.getByRole("button", { name: "Yes, it's mine" }).click();
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	expect(await remembered(page)).not.toBeNull();
});

test("No returns to the start, with nothing remembered", async ({ page }) => {
	await page.goto(`/account/#n=${DIGITS}`);
	await page.getByRole("button", { name: "No", exact: true }).click();
	await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
	expect(await remembered(page)).toBeNull();
});

test("the remembered number opens straight to the account", async ({ page }) => {
	await fromApp(page);
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	await page.goto(`/account/#n=${DIGITS}`);
	await expect(page.getByText(/^Paid through /)).toBeVisible();
	await expect(page.getByText("Is this your account number?")).toBeHidden();
});

test("Sign out forgets the number here and deletes nothing", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
	expect(await remembered(page)).toBeNull();
	expect(callsTo("/v1/accounts/delete")).toHaveLength(0);
});

test("Delete account asks first, and Keep it changes nothing", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await expect(page.getByText(/Delete this account\? Paid time is lost/)).toBeVisible();
	await expect(page.getByText(/Your vault isn't\s+affected/)).toBeVisible();
	expect(callsTo("/v1/accounts/delete")).toHaveLength(0);
	await page.getByRole("button", { name: "Keep it" }).click();
	await expect(page.getByRole("button", { name: "Yes, delete" })).toBeHidden();
	await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
	expect(callsTo("/v1/accounts/delete")).toHaveLength(0);
	expect(await remembered(page)).not.toBeNull();
});

test("deleting sends the number, forgets it and says so", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await page.getByRole("button", { name: "Yes, delete" }).click();
	await expect(page.getByText("Account deleted.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
	const [deleted] = callsTo("/v1/accounts/delete");
	expect(JSON.parse(deleted?.body ?? "{}")).toEqual({ number: NUMBER });
	expect(await remembered(page)).toBeNull();
});

test("a double click deletes once", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await page.getByRole("button", { name: "Yes, delete" }).dblclick();
	await expect(page.getByText("Account deleted.")).toBeVisible();
	expect(callsTo("/v1/accounts/delete")).toHaveLength(1);
});

test("the question warns about purchases that can still be refunded, and allows it", async ({
	page,
}) => {
	const warning = /Deleting doesn't refund anything/;
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await expect(page.getByText(/Delete this account\?/)).toBeVisible();
	await expect(page.getByText(warning)).toBeHidden();

	services.purchases = () => ({ code: 200, body: { purchases: [PURCHASE] } });
	await page.reload();
	await page.getByRole("button", { name: "Delete account" }).click();
	await expect(page.getByText(warning)).toBeVisible();
	await page.getByRole("button", { name: "Yes, delete" }).click();
	await expect(page.getByText("Account deleted.")).toBeVisible();
	expect(callsTo("/v1/refunds")).toHaveLength(0);
});

test("a failed delete stays on the account, says so and can be tried again", async ({ page }) => {
	services.remove = () => ({ code: 500, body: { error: "unexpected" } });
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await page.getByRole("button", { name: "Yes, delete" }).click();
	await expect(page.locator('[data-account="error"]')).toBeVisible();
	await expect(page.getByText("Account deleted.")).toBeHidden();
	expect(await remembered(page)).not.toBeNull();
	services.remove = () => ({ code: 200, body: { deleted: true } });
	await page.getByRole("button", { name: "Yes, delete" }).click();
	await expect(page.getByText("Account deleted.")).toBeVisible();
});

test("the notice goes once an account is open again", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Delete account" }).click();
	await page.getByRole("button", { name: "Yes, delete" }).click();
	await expect(page.getByText("Account deleted.")).toBeVisible();
	await page.getByLabel("Account number").fill(NUMBER);
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByText("Account deleted.")).toBeHidden();
	await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Yes, delete" })).toBeHidden();
});

test("any number of months can be bought, and the page says what it costs", async ({ page }) => {
	await fromApp(page);
	await page.getByLabel("Months").fill("9");
	await expect(page.getByText("9 months, $18")).toBeVisible();
	await page.getByRole("button", { name: "Credit/Debit card" }).click();
	await page.waitForURL(/checkout\.stripe\.com/);
	const [checkout] = callsTo("/v1/checkout");
	expect(JSON.parse(checkout?.body ?? "{}").months).toBe(9);
});

test("a shortcut sets the months", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "36", exact: true }).click();
	await expect(page.getByLabel("Months")).toHaveValue("36");
	await expect(page.getByText("36 months, $72")).toBeVisible();
	await expect(page.getByRole("button", { name: "Credit/Debit card" })).toBeEnabled();
});

for (const value of ["5", "37", "7.5", ""]) {
	test(`"${value}" months can't be bought`, async ({ page }) => {
		await fromApp(page);
		await page.getByLabel("Months").fill(value);
		await expect(page.getByText("Choose 6 to 36 months.")).toBeVisible();
		for (const name of ["Credit/Debit card", "Bitcoin", "Monero"])
			await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
		expect(callsTo("/v1/checkout")).toHaveLength(0);
	});
}

test("a valid number clears the message", async ({ page }) => {
	await fromApp(page);
	await page.getByLabel("Months").fill("5");
	await expect(page.getByText("Choose 6 to 36 months.")).toBeVisible();
	await page.getByLabel("Months").fill("6");
	await expect(page.getByText("Choose 6 to 36 months.")).toBeHidden();
	await expect(page.getByText("6 months, $12")).toBeVisible();
	await expect(page.getByRole("button", { name: "Credit/Debit card" })).toBeEnabled();
});

for (const [name, method] of [
	["Bitcoin", "bitcoin"],
	["Monero", "monero"],
] as const) {
	test(`${name} asks where the buyer lives, then for an invoice in ${name}`, async ({ page }) => {
		services.checkout = () => ({ code: 200, body: { url: "https://pay.bramble.sh/i/test" } });
		await fromApp(page);
		await page.getByRole("button", { name: "12", exact: true }).click();
		await page.getByRole("button", { name, exact: true }).click();
		const go = page.getByRole("button", { name: `Continue to ${name}` });
		await expect(go).toBeDisabled();
		expect(callsTo("/v1/checkout")).toHaveLength(0);
		await page.getByLabel("Country").selectOption({ label: "Germany" });
		await expect(page.getByLabel("Province or territory")).toBeHidden();
		await go.click();
		await expect(page.getByText("BTCPay test invoice")).toBeVisible();
		const body = JSON.parse(callsTo("/v1/checkout")[0]?.body ?? "{}");
		expect(body).toMatchObject({ months: 12, method, country: "DE" });
		expect(body).not.toHaveProperty("province");
	});
}

test("in Canada, the province is asked for too", async ({ page }) => {
	services.checkout = () => ({ code: 200, body: { url: "https://pay.bramble.sh/i/test" } });
	await fromApp(page);
	await page.getByRole("button", { name: "Monero", exact: true }).click();
	await page.getByLabel("Country").selectOption({ label: "Canada" });
	const go = page.getByRole("button", { name: "Continue to Monero" });
	await expect(go).toBeDisabled();
	await page.getByLabel("Province or territory").selectOption({ label: "Ontario" });
	await go.click();
	await expect(page.getByText("BTCPay test invoice")).toBeVisible();
	expect(JSON.parse(callsTo("/v1/checkout")[0]?.body ?? "{}")).toMatchObject({
		method: "monero",
		country: "CA",
		province: "ON",
	});
});

test("Cancel closes the question, and a card never asks it", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Bitcoin", exact: true }).click();
	await expect(page.getByLabel("Country")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByLabel("Country")).toBeHidden();
	await page.getByRole("button", { name: "Credit/Debit card" }).click();
	await expect(page.getByText("Stripe test checkout")).toBeVisible();
	expect(JSON.parse(callsTo("/v1/checkout")[0]?.body ?? "{}")).not.toHaveProperty("country");
});

test("the card button still asks for a card", async ({ page }) => {
	await fromApp(page);
	await page.getByRole("button", { name: "Credit/Debit card" }).click();
	await expect(page.getByText("Stripe test checkout")).toBeVisible();
	expect(JSON.parse(callsTo("/v1/checkout")[0]?.body ?? "{}")).toMatchObject({ method: "card" });
});

test("where crypto isn't offered, the page says so and both buttons work again", async ({
	page,
}) => {
	services.checkout = () => ({ code: 404, body: { error: "method_unavailable" } });
	await fromApp(page);
	await page.getByRole("button", { name: "Monero", exact: true }).click();
	await page.getByLabel("Country").selectOption({ label: "Germany" });
	const go = page.getByRole("button", { name: "Continue to Monero" });
	await go.click();
	await expect(
		page.getByText(/Paying with Bitcoin or Monero isn't available right now/),
	).toBeVisible();
	await expect(go).toBeEnabled();
	await expect(go).not.toHaveAttribute("aria-busy");
	await expect(page.getByRole("button", { name: "Credit/Debit card" })).toBeEnabled();
});

test("back from a crypto payment, the page says the time lands once it confirms", async ({
	page,
}) => {
	await page.clock.install();
	await page.addInitScript(
		([number, paidThrough]) => {
			sessionStorage.setItem("bramble.account", number);
			sessionStorage.setItem("bramble.paidThrough", paidThrough);
		},
		[NUMBER, String(PAID.paidThrough)],
	);
	// The payment is seen, but its time hasn't landed yet.
	services.status = () => ({ code: 200, body: PAID });
	await page.goto("/account/paid?via=crypto");
	await page.clock.runFor(35_000);
	await expect(
		page.getByText(/once the payment confirms, which can take up to an hour/),
	).toBeVisible();
	await expect(page.getByText(NUMBER, { exact: true })).toBeVisible();
});
