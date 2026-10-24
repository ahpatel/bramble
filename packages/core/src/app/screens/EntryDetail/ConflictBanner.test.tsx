/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import { ConflictChangedError, type ConflictVersion, type Entry } from "../../../hooks/useVault";
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

function show(
	conflict: EntryConflict,
	{
		entry = NOTE,
		versions = [{ hlc: PHONE, data: { ...NOTE, notes: "theirs" } }] as ConflictVersion[],
		onResolve = vi.fn(async () => {}),
	} = {},
) {
	const onDelete = vi.fn(async () => {});
	const onReadVersions = vi.fn(async () => versions);
	const ui = (c: EntryConflict) => (
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<ConflictBanner
					entry={entry}
					conflict={c}
					onReadVersions={onReadVersions}
					onResolve={onResolve}
					onDelete={onDelete}
				/>
			</PlatformProvider>
		</I18nProvider>
	);
	const { rerender } = render(ui(conflict));
	return { onResolve, onDelete, onReadVersions, rerender: (c: EntryConflict) => rerender(ui(c)) };
}

const compare = async () => {
	fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
	await screen.findByRole("button", { name: "Use this one" });
};

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
		expect(onResolve).toHaveBeenCalledWith({ kind: "keep", seen: [] });
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
		await compare();
		fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
		expect(onDelete).toHaveBeenCalled();
	});

	it.each([
		["Use this one", { kind: "use", hlc: PHONE, seen: [PHONE] }],
		["Keep both", { kind: "keepBoth", hlc: PHONE, seen: [PHONE] }],
		["Keep this one", { kind: "keep", seen: [PHONE] }],
	] as const)("%s resolves with that choice and the versions seen", async (button, choice) => {
		const { onResolve } = show({ versions: 1, deleted: false });
		await compare();
		expect(screen.getByText("theirs")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: button }));
		expect(onResolve).toHaveBeenCalledWith(choice);
	});

	// Two passwords look the same masked, and the name, custom fields and tags live outside the
	// mode's body; the user has to see what they're choosing between (final review, finding B1).
	it("shows each version's name, custom fields and tags", async () => {
		const other = {
			...NOTE,
			name: "Wifi upstairs",
			customFields: [{ key: "PIN", value: "4321" }],
			tags: ["home"],
		};
		show({ versions: 1, deleted: false }, { versions: [{ hlc: PHONE, data: other }] });
		await compare();
		expect(screen.getByText("Wifi upstairs")).toBeTruthy();
		expect(screen.getByText("PIN")).toBeTruthy();
		expect(screen.getByText("home")).toBeTruthy();
	});

	it("says when a version's password differs, and when it holds a passkey the other doesn't", async () => {
		const login = {
			id: "l1",
			type: "login",
			name: "GitHub",
			urls: [],
			username: "u",
			password: "aaaaaaaaaaaaaaaaaaaa",
		} as unknown as Entry;
		const passkey = {
			credentialId: "AQID",
			rpId: "github.com",
			userHandle: "AQID",
			alg: -7,
			publicKeyCose: "AQID",
			privateKey: "AQID",
			signCount: 0,
			createdAt: 1,
		};
		const other = { ...login, password: "bbbbbbbbbbbbbbbbbbbb", passkeys: [passkey] };
		show(
			{ versions: 1, deleted: false },
			{ entry: login, versions: [{ hlc: PHONE, data: other }] },
		);
		await compare();
		expect(screen.getByText(/Its password is different from the version shown\./)).toBeTruthy();
		expect(screen.getByText(/It holds a passkey the version shown doesn't\./)).toBeTruthy();
	});

	// A failed resolution has to say so, and a sync landing mid-compare reloads the versions
	// rather than letting the user resolve blind (final review, findings B4 and B5).
	it("shows the error when a resolution fails, and reloads the versions when they changed", async () => {
		const onResolve = vi.fn(async () => {
			throw new ConflictChangedError("These versions changed while you were comparing them.");
		});
		const { onReadVersions } = show({ versions: 1, deleted: false }, { onResolve });
		await compare();
		fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
		expect(
			await screen.findByText(/These versions changed while you were comparing them\./),
		).toBeTruthy();
		await waitFor(() => expect(onReadVersions).toHaveBeenCalledTimes(2));
	});

	it("reloads the versions when the conflict changes", async () => {
		const { onReadVersions, rerender } = show({ versions: 1, deleted: false });
		await compare();
		rerender({ versions: 2, deleted: false });
		await waitFor(() => expect(onReadVersions).toHaveBeenCalledTimes(2));
	});
});
