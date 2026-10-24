/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import type { Entry } from "../../../hooks/useVault";
import type { EntryConflict } from "../../../sync";
import { ConflictBanner } from "./ConflictBanner";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const NOTE = { id: "n1", type: "note", name: "Wifi", notes: "shown" } as unknown as Entry;
const PHONE = { wall: 5, counter: 0, node: "phone" };
const platform = { clipboard: { copy: vi.fn(async () => {}) } } as unknown as Platform;

function show(conflict: EntryConflict) {
	const onResolve = vi.fn(async () => {});
	const onDelete = vi.fn(async () => {});
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<ConflictBanner
					entry={NOTE}
					conflict={conflict}
					onReadVersions={async () => [{ hlc: PHONE, data: { ...NOTE, notes: "theirs" } }]}
					onResolve={onResolve}
					onDelete={onDelete}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
	return { onResolve, onDelete };
}

const EDITED = /This entry was changed on two devices before they synced\./;
const DELETED = /This entry was deleted on one device and changed on another before they synced\./;

describe("ConflictBanner", () => {
	it("explains edits on two devices and offers to compare", () => {
		show({ versions: 1, deleted: false });
		expect(screen.getByText(EDITED)).toBeTruthy();
		expect(screen.queryByText(DELETED)).toBeNull();
		expect(screen.getByRole("button", { name: "Compare versions" })).toBeTruthy();
	});

	it("explains a delete on another device, and keeps it when asked", () => {
		const { onResolve } = show({ versions: 0, deleted: true });
		expect(screen.getByText(DELETED)).toBeTruthy();
		expect(screen.queryByText(EDITED)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
		expect(onResolve).toHaveBeenCalledWith({ kind: "keep" });
	});

	it("deletes it when asked", () => {
		const { onDelete } = show({ versions: 0, deleted: true });
		fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
		expect(onDelete).toHaveBeenCalled();
	});

	it("says both when both apply, and the compare view offers to delete", async () => {
		const { onDelete } = show({ versions: 1, deleted: true });
		expect(screen.getByText(EDITED)).toBeTruthy();
		expect(screen.getByText(DELETED)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete it" }));
		expect(onDelete).toHaveBeenCalled();
	});

	it.each([
		["Use this one", { kind: "use", hlc: PHONE }],
		["Keep both", { kind: "keepBoth", hlc: PHONE }],
		["Keep this one", { kind: "keep" }],
	] as const)("%s resolves with that choice", async (button, choice) => {
		const { onResolve } = show({ versions: 1, deleted: false });
		fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
		expect(await screen.findByText("theirs")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: button }));
		expect(onResolve).toHaveBeenCalledWith(choice);
	});
});
