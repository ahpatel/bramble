/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cardMode } from "./card";
import type { EntryDetailBodyProps } from "./types";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const CARD = {
	id: "c1",
	type: "card",
	name: "Personal",
	cardholderName: "Alice Example",
	// Saved as typed, with spaces.
	number: "5555 5555 5555 4444",
	expMonth: "04",
	expYear: "29",
	cvv: "123",
} as unknown as EntryDetailBodyProps["entry"];

function show(entry = CARD, copy = vi.fn()) {
	const Detail = cardMode.Detail;
	render(
		<I18nProvider i18n={i18n}>
			<Detail entry={entry} copied={null} copy={copy} />
		</I18nProvider>,
	);
	return copy;
}

describe("card detail", () => {
	it("shows a revealed number in groups, however it was saved", () => {
		show({ ...CARD, number: "5555555555554444" } as typeof CARD);
		fireEvent.click(screen.getByRole("button", { name: "Show card number" }));
		expect(screen.getByText("5555 5555 5555 4444")).toBeTruthy();
	});

	it("copies the bare digits", () => {
		const copy = show();
		fireEvent.click(screen.getByRole("button", { name: /copy card number/i }));
		expect(copy).toHaveBeenCalledWith("card number", "5555555555554444");
	});

	it("copies the bare digits from the list row's menu too", () => {
		const items = cardMode.row(CARD).copyItems ?? [];
		const number = items.find((i) => i.label === "card number");
		expect(number?.value).toBe("5555555555554444");
	});
});
