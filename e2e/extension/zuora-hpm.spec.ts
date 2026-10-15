import type { BrowserContext, Frame, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, openPopup, seedExampleCard, waitOutPickerClickGuard } from "./helpers";

// Zuora's Hosted Payment Page as Zoom embeds it (us05web.zoom.us checkout): a cross-origin frame
// sized to its own form (548x332), card fields with no cc-* tokens, the expiry as two selects.
// Scripts are stripped; the markup and stylesheet are Zuora's.

const MERCHANT = "https://zoom.example";
const ZUORA = "https://zuora.example";

/** Zoom's checkout around the HPM frame; `sectionStyle` lands on the frame's container. */
function checkout(sectionStyle = ""): string {
	return `<!doctype html><html><head><title>Checkout</title></head>
<body style="margin:0">
	<div style="height:160px">Plan summary</div>
	<div id="zuora_payment" style="${sectionStyle}">
		<iframe id="z_hppm_iframe" src="${ZUORA}/apps/PublicHostedPageLite.do" scrolling="no"
			frameborder="0" width="548" height="332" style="display:block"></iframe>
	</div>
</body></html>`;
}

const HPM = `<!doctype html><html><head><title></title><style>
.form-label-month, .form-label-year { display: none; }
.form-label-input-pair { display: inline-block; }
.field-set { border: 0px; margin: 0px; padding: 0px; }
.field-set-legend { display: none; }
.card-image { float: left; }
.card-image-Visa-disabled { width: 60px; height: 32px; margin: 2px; }
.card-image-text-Visa { display: none; }
#form-group-email { display: none; }
.error-field { display: none; }
#form-element-cardSecurityCode { font-size: 0; }
body, td, input, textarea, select { font: 14px Helvetica, Arial, sans-serif; }
input { vertical-align: middle; border: 1px solid #BABACC; border-radius: 4px; height: 28px; }
select { background: #fff; border: 1px solid #BABACC; border-radius: 4px; height: 28px; }
label { display: inline-block; vertical-align: middle; width: 150px; word-break: break-all; }
body { display: block; margin: 10px 0; }
.form-group { display: block; width: 100%; margin-bottom: 16px; }
.form-element { display: block; border-left: 2px solid #FFF; padding-left: 1px; border-left-color: rgba(255, 255, 255, 0); }
.form-element input { padding: 0 2px; }
.popup .form { margin-top: 1px; padding: 0; width: 100%; border-radius: 8px; }
.popup .form .content { margin: 0 auto; }
.spacer { padding: 2px; }
.error { font-size: 12px; color: #DA1639; margin: -8px 0 5px 0; }
.bottom { margin-top: 15px; overflow: hidden; }
.required-desc { display: none; }
.image-cvv-position { position: relative; }
.image-cvv-des { position: absolute; top: 28px; left: 120px; z-index: 20; }
.text-input { width: 100%; }
.select-input { width: 180px; }
.state-select-input { width: 100%; }
input[type=text], select { position: relative; border-radius: 8px; height: 32px; box-sizing: border-box; padding-left: 12px; padding-right: 12px; }
#form-group-creditCardType, #date-separator, .image-cvv { display: none; }
#form-element-cardSecurityCode { min-width: 190px; }
#input-cardSecurityCode { width: 100%; }
#cvvPosition, #form-element-creditCardExpirationMonth fieldset { white-space: nowrap; }
.whitespace { display: none; }
.popup .form .content { margin-top: 8px; }
input[name="field_passthrough15"][value*="isCollapsed"] ~ .popup div[id="form-group-creditCardAddress1"],
input[name="field_passthrough15"][value*="isCollapsed"] ~ .popup div[id="form-group-creditCardCity"],
input[name="field_passthrough15"][value*="isCollapsed"] ~ .popup div[id="form-group-creditCardPostalCode"] { display: none; }
@media (min-width: 427px) {
	.form-group { display: block; width: calc(100% - 8px); }
	.form-element { width: 100%; }
	.form-label { display: block; margin-bottom: 4px; font-size: 14px; padding-left: 4px; width: 240px; }
	.text-input, .text-input-cvv { width: 100%; }
	.select-input { width: 100%; }
	.form-element .form-label-input-pair { width: calc(50% - 8px); }
	#input-creditCardExpirationMonth { margin-right: 16px; }
	#form-group-creditCardType { display: block; height: 20px; }
	#form-label-creditCardType { display: none; }
	#form-element-creditCardType { transform: translateY(-10px); }
}
#form-element-creditCardType { transform: scale(0.75) translateY(-16px); transform-origin: top left; }
.field-set:has(#input-creditCardExpirationYear, #input-creditCardExpirationMonth) { display: flex; justify-content: space-between; }
</style></head>
<body>
<form action="PublicHostedPageLite.do" id="HostedPageForm" name="HostedPageForm" method="post">
	<input type="hidden" name="method" id="method" value="submitPage">
	<input type="hidden" name="field_key" value="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoDjMPXAm">
	<input type="hidden" name="field_style" id="field_style" value="inline">
	<input type="hidden" name="g-recaptcha-response" id="g-recaptcha-response">
	<input type="hidden" name="field_passthrough13" value="modal_theme_light">
	<input type="hidden" name="field_passthrough14" value="opc">
	<input type="hidden" name="field_passthrough15" value="isCollapsed">
	<div class="popup"><div class="form">
		<div class="whitespace"></div>
		<div class="content">
			<div id="error" class="error" role="alert" aria-live="assertive"></div>
			<div class="spacer"></div>
			<div class="form-group" id="form-group-creditCardHolderName">
				<label class="form-label required" id="form-label-creditCardHolderName" for="input-creditCardHolderName">Cardholder name (exactly as printed on card)</label>
				<div class="form-element required" id="form-element-creditCardHolderName">
					<input type="text" id="input-creditCardHolderName" value="" class="text-input" name="field_creditCardHolderName" maxlength="50" encrypt="false" aria-required="true" aria-describedby="error-creditCardHolderName">
				</div>
				<a class="tooltip" id="tooltip-creditCardHolderName" href="#"><span class="tooltip-text"></span></a>
				<div id="error-creditCardHolderName" aria-live="polite" class="error-field"></div>
			</div>
			<div class="form-group" id="form-group-creditCardNumber">
				<label class="form-label required" id="form-label-creditCardNumber" for="input-creditCardNumber">Card number</label>
				<div class="form-element required" id="form-element-creditCardNumber">
					<input type="text" id="input-creditCardNumber" value="" class="text-input text-card-number" name="field_creditCardNumber" maxlength="32" encrypt="true" aria-required="true" aria-describedby="error-creditCardNumber" autocomplete="off">
				</div>
				<div id="error-creditCardNumber" aria-live="polite" class="error-field"></div>
			</div>
			<div class="form-group" id="form-group-creditCardType">
				<label class="form-label" id="form-label-creditCardType" for="input-creditCardType">Card type</label>
				<div class="form-element" id="form-element-creditCardType">
					<div id="card-image-container-Visa" aria-label="Card Type Visa" role="widget" name="card-image-creditCardType" class="card-image-Visa-disabled card-image" aria-hidden="true" aria-disabled="true"><span class="card-image-text-Visa">Visa</span></div>
					<input type="hidden" id="input-creditCardType" name="field_creditCardType" value="">
				</div>
			</div>
			<div class="form-group" id="form-group-creditCardExpirationMonth">
				<label class="form-label required" id="form-label-creditCardExpiration">Expiration date</label>
				<div class="form-element required" id="form-element-creditCardExpirationMonth">
					<fieldset class="field-set">
						<legend class="field-set-legend">Expiration date*</legend>
						<div class="form-label-input-pair">
							<label class="form-label form-label-month" id="label-creditCardExpirationMonth" for="input-creditCardExpirationMonth">Expiration date</label>
							<select encrypt="true" class="select-input " id="input-creditCardExpirationMonth" name="field_creditCardExpirationMonth" aria-required="true" aria-labelledby="form-label-creditCardExpiration label-creditCardExpirationMonth">
								<option value="">- Select One -</option>
								<option value="01">01</option><option value="02">02</option><option value="03">03</option>
								<option value="04">04</option><option value="05">05</option><option value="06">06</option>
								<option value="07">07</option><option value="08">08</option><option value="09">09</option>
								<option value="10">10</option><option value="11">11</option><option value="12">12</option>
							</select>
						</div>
						<span id="date-separator" class="date-separator">/</span>
						<div class="form-label-input-pair">
							<label class="form-label form-label-year" id="label-creditCardExpirationYear" for="input-creditCardExpirationYear">Expiration Date (YYYY)</label>
							<select encrypt="true" class="select-input " id="input-creditCardExpirationYear" name="field_creditCardExpirationYear" aria-required="true" aria-labelledby="label-creditCardExpirationYear">
								<option value="">- Select One -</option>
								<option value="2026">2026</option><option value="2027">2027</option><option value="2028">2028</option>
								<option value="2029">2029</option><option value="2030">2030</option><option value="2031">2031</option>
							</select>
						</div>
					</fieldset>
				</div>
			</div>
			<div class="form-group" id="form-group-cardSecurityCode">
				<label class="form-label required" id="form-label-cardSecurityCode" for="input-cardSecurityCode">CVV</label>
				<div class="form-element required" id="form-element-cardSecurityCode">
					<div id="cvvPosition" class="image-cvv-position">
						<input type="text" id="input-cardSecurityCode" encrypt="true" value="" class="text-input-cvv" name="field_cardSecurityCode" maxlength="4" aria-required="true">&nbsp;
						<a href="#" id="cvvLink"><img alt="cvv" class="image-cvv" id="cvvImg"></a>
						<div id="vvDes" class="image-cvv-des" style="display:none"><img alt="cvv tooltip"></div>
					</div>
				</div>
			</div>
			<div class="form-group" id="form-group-creditCardAddress1">
				<label class="form-label required" for="input-creditCardAddress1">Address *</label>
				<div class="form-element required"><input type="text" id="input-creditCardAddress1" value="" class="text-input" name="field_creditCardAddress1" maxlength="255"></div>
			</div>
			<div class="form-group" id="form-group-creditCardCity">
				<label class="form-label required" for="input-creditCardCity">City *</label>
				<div class="form-element required"><input type="text" id="input-creditCardCity" value="" class="text-input" name="field_creditCardCity" maxlength="40"></div>
			</div>
			<div class="form-group" id="form-group-creditCardPostalCode">
				<label class="form-label required" for="input-creditCardPostalCode">Zip/Postal *</label>
				<div class="form-element required"><input type="text" id="input-creditCardPostalCode" value="" class="text-input" name="field_creditCardPostalCode" maxlength="20"></div>
			</div>
			<div class="form-group" id="form-group-email">
				<label class="form-label" id="form-label-email" for="input-email">Email Address</label>
				<div class="form-element" id="form-element-email"><input type="text" id="input-email" value="" class="text-input" name="field_email" maxlength="80"></div>
			</div>
			<div class="bottom">
				<div class="required-desc">&nbsp;= Required Field</div>
				<div id="zuoraCaptcha" class="g-recaptcha"></div>
			</div>
		</div>
	</div></div>
</form>
<div><div class="grecaptcha-badge" data-style="bottomright" style="width: 256px; height: 60px; display: block; transition: right 0.3s; position: fixed; bottom: 14px; right: -186px; box-shadow: gray 0px 0px 5px; border-radius: 2px; overflow: hidden;"><div class="grecaptcha-logo"><iframe title="reCAPTCHA" width="256" height="60" role="presentation" frameborder="0" scrolling="no" src="about:blank"></iframe></div><textarea id="g-recaptcha-response-100000" name="g-recaptcha-response" class="g-recaptcha-response" style="display: none;"></textarea></div><iframe style="display: none;"></iframe></div>
</body></html>`;

async function serve(page: Page, top: string): Promise<void> {
	await page.context().route(/^https:\/\/(zoom|zuora)\.example\//, (route) => {
		if (route.request().resourceType() !== "document") {
			return route.fulfill({ status: 200, body: "" });
		}
		const body = route.request().url().startsWith(ZUORA) ? HPM : top;
		return route.fulfill({ body, headers: { "content-type": "text/html" } });
	});
}

function hpm(page: Page): Frame {
	const frame = page.frames().find((f) => f.url().startsWith(ZUORA));
	if (!frame) throw new Error("HPM frame missing");
	return frame;
}

function uiFrame(page: Page): Frame | undefined {
	return page.frames().find((f) => f.url().includes("autofill-ui.html"));
}

async function setUp(context: BrowserContext, extensionId: string): Promise<void> {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await seedExampleCard(popup);
	await popup.close();
}

/** Open the picker on the card number field and return its UI frame. */
async function openPicker(page: Page): Promise<Frame> {
	await expect(async () => {
		await hpm(page).locator("#input-creditCardNumber").click();
		expect(uiFrame(page)).toBeDefined();
	}).toPass({ timeout: 25_000 });
	const ui = uiFrame(page)!;
	await expect(ui.locator("[data-entry-id]").first()).toBeVisible({ timeout: 15_000 });
	return ui;
}

test("picking a card fills Zuora's hosted page", async ({ context, extensionId }) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, checkout());
	await page.goto(`${MERCHANT}/opc/buy/checkout`);

	const ui = await openPicker(page);
	await waitOutPickerClickGuard(page);
	await ui.locator("[data-entry-id]").first().click();

	const frame = hpm(page);
	await expect(frame.locator("#input-creditCardNumber")).toHaveValue("4242424242424242", {
		timeout: 15_000,
	});
	await expect(frame.locator("#input-creditCardHolderName")).toHaveValue("Alice Example");
	await expect(frame.locator("#input-creditCardExpirationMonth")).toHaveValue("04");
	await expect(frame.locator("#input-creditCardExpirationYear")).toHaveValue("2030");
	await expect(frame.locator("#input-cardSecurityCode")).toHaveValue("123");
});

for (const [effect, style] of [
	["fades", "opacity: 0.99"],
	["filters", "filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))"],
] as const) {
	test(`a click fills even when the merchant ${effect} the payment section`, async ({
		context,
		extensionId,
	}) => {
		// Any opacity or filter on an ancestor of the picker costs it the browser's visibility vouch,
		// and with it every click. Inside Zoom's frame the picker inherited Zoom's styling; hosted by
		// the top frame it sits outside the payment section altogether.
		await setUp(context, extensionId);
		const page = await context.newPage();
		await serve(page, checkout(style));
		await page.goto(`${MERCHANT}/opc/buy/checkout`);

		const ui = await openPicker(page);
		await waitOutPickerClickGuard(page);
		await ui.locator("[data-entry-id]").first().click();

		await expect(hpm(page).locator("#input-creditCardNumber")).toHaveValue("4242424242424242", {
			timeout: 15_000,
		});
	});
}

test("a click elsewhere on the merchant page takes the picker down", async ({
	context,
	extensionId,
}) => {
	await setUp(context, extensionId);
	const page = await context.newPage();
	await serve(page, checkout());
	await page.goto(`${MERCHANT}/opc/buy/checkout`);
	await openPicker(page);

	await page.mouse.click(600, 40); // "Plan summary", outside the frame
	await page.mouse.wheel(0, 100);

	await expect
		.poll(() => page.evaluate(() => document.querySelectorAll('div[id^="tp-"]').length), {
			timeout: 10_000,
		})
		.toBe(0);
	await expect
		.poll(() =>
			hpm(page).evaluate(
				() => document.querySelector<HTMLElement>('div[id^="tp-"]')?.style.display ?? "gone",
			),
		)
		.toMatch(/none|gone/);
});
