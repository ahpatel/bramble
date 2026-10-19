/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cardMode } from "./card";
import { loginMode } from "./login";
import { noteMode } from "./note";
import { sshKeyMode } from "./ssh-key";
import type { EntryDetailBodyProps, EntryMode } from "./types";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const NOTES = "Door code 4512\n  Ask for Sam ";

const entry = (fields: object) => fields as unknown as EntryDetailBodyProps["entry"];

const MODES: [string, EntryMode, EntryDetailBodyProps["entry"], string][] = [
	[
		"login",
		loginMode,
		entry({ id: "l1", type: "login", name: "Bank", urls: [], username: "", password: "" }),
		"Copy notes",
	],
	[
		"card",
		cardMode,
		entry({ id: "c1", type: "card", name: "Visa", cardholderName: "", number: "4111", cvv: "" }),
		"Copy notes",
	],
	["secure note", noteMode, entry({ id: "n1", type: "note", name: "Wifi" }), "Copy content"],
	[
		"ssh key",
		sshKeyMode,
		entry({ id: "s1", type: "ssh-key", name: "Server", publicKey: "", privateKey: "" }),
		"Copy notes",
	],
];

function show(mode: EntryMode, value: EntryDetailBodyProps["entry"], copied: string | null = null) {
	const copy = vi.fn();
	const Detail = mode.Detail;
	render(
		<I18nProvider i18n={i18n}>
			<Detail entry={entry({ ...value, notes: NOTES })} copied={copied} copy={copy} />
		</I18nProvider>,
	);
	return copy;
}

describe.each(MODES)("%s detail notes", (_, mode, value, copyLabel) => {
	it("opts the text into selection", () => {
		show(mode, value);
		const text = screen.getByText(/Door code 4512/);
		expect(text.hasAttribute("data-selectable")).toBe(true);
		expect(text.closest(".select-none")).toBeNull();
	});

	it("copies the notes exactly as saved", () => {
		const copy = show(mode, value);
		fireEvent.click(screen.getByRole("button", { name: copyLabel }));
		expect(copy).toHaveBeenCalledWith("notes", NOTES);
	});

	it("confirms only its own copy", () => {
		show(mode, value, "notes");
		const button = screen.getByRole("button", { name: copyLabel });
		expect(button.querySelector(".lucide-check")).toBeTruthy();
		cleanup();
		show(mode, value, "username");
		const idle = screen.getByRole("button", { name: copyLabel });
		expect(idle.querySelector(".lucide-check")).toBeNull();
	});
});
