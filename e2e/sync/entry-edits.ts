import { expect, type Page } from "@playwright/test";

// Driving one login through the entry screens every peer renders (the extension's popup, the
// mobile app in a browser, the app on a device), for the concurrent-edit specs in e2e/sync and
// e2e/android. See docs/sync-conflicts.md.

/** The banner an entry with sibling versions shows. */
export const CONFLICT = /changed on two devices before they synced/i;

export interface Edit {
	username?: string;
	notes?: string;
}

/** Back one screen (settings, an entry's detail view, its edit form). */
export async function back(page: Page): Promise<void> {
	await page
		.getByRole("button", { name: /^(Back|Go back)/i })
		.first()
		.click();
}

/**
 * A login's detail view, from wherever the page is: the list, another entry, an edit form. Back
 * follows history, so from a detail view it can land on the edit form saved before it; this steps
 * back until it reaches the list. A popup also reopens on its last screen, which can be the edit
 * form another view of it left open.
 */
export async function openEntry(page: Page, name: string): Promise<void> {
	const detail = page.getByRole("button", { name: "Edit entry" });
	const form = page.getByRole("button", { name: /Update Login/i });
	const list = page.getByRole("button", { name: /Add New/i });
	const heading = page.getByRole("heading", { name, exact: true });
	for (let step = 0; step < 6; step++) {
		await expect(detail.or(form).or(list).first()).toBeVisible();
		if ((await detail.isVisible()) && (await heading.isVisible())) return;
		if ((await form.isVisible()) || (await detail.isVisible())) await back(page);
		else await page.getByText(name).first().click();
	}
	throw new Error(`couldn't reach the detail view of ${name}`);
}

/** Fill the open edit form and save it, landing on the detail view. */
export async function saveForm(page: Page, edit: Edit): Promise<void> {
	if (edit.username) await page.getByLabel(/Username or email/i).fill(edit.username);
	if (edit.notes) await page.getByLabel(/Notes/i).fill(edit.notes);
	await page.getByRole("button", { name: /Update Login/i }).click();
	await expect(page.getByRole("button", { name: "Edit entry" })).toBeVisible();
}

/** Edit a login through its edit form. */
export async function editEntry(page: Page, name: string, edit: Edit): Promise<void> {
	await openEntry(page, name);
	await page.getByRole("button", { name: "Edit entry" }).click();
	await saveForm(page, edit);
}

/**
 * Each page ends up showing the login with all these values at once and no conflict. One
 * snapshot each: while syncing, a device shows its own edit, then the other's, and each value
 * would pass alone at some point.
 */
export async function expectCombined(pages: Page[], name: string, texts: string[]): Promise<void> {
	for (const page of pages) {
		await openEntry(page, name);
		await expect(async () => {
			const shown = await page.locator("#root").innerText();
			for (const text of texts) expect(shown).toContain(text);
			expect(shown).not.toMatch(CONFLICT);
		}).toPass({ timeout: 90_000 });
	}
}

/** Each page shows the login as a conflict. */
export async function expectConflict(pages: Page[], name: string): Promise<void> {
	for (const page of pages) {
		await openEntry(page, name);
		await expect(page.getByText(CONFLICT)).toBeVisible({ timeout: 90_000 });
	}
}

/**
 * Resolve a conflict on `page` by keeping the version it shows, and return the notes it kept
 * (one of `candidates`).
 */
export async function keepShown(page: Page, name: string, candidates: string[]): Promise<string> {
	await openEntry(page, name);
	await page.getByRole("button", { name: "Compare versions" }).click();
	await page.getByRole("button", { name: "Keep this one" }).click();
	await expect(page.getByText(CONFLICT)).toBeHidden();
	const shown = await page.locator("#root").innerText();
	const kept = candidates.find((c) => shown.includes(c));
	if (!kept) throw new Error(`none of ${candidates.join(", ")} is shown after resolving`);
	return kept;
}
