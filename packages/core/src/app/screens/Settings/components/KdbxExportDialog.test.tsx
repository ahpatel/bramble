/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EntryConflict } from "../../../../sync";
import { KdbxExportDialog } from "./KdbxExportDialog";

const h = vi.hoisted(() => ({ conflicts: new Map<string, EntryConflict>() }));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ exportKdbx: async () => {}, conflicts: h.conflicts }),
}));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function show() {
	render(
		<I18nProvider i18n={i18n}>
			<KdbxExportDialog open onClose={() => {}} />
		</I18nProvider>,
	);
}

describe("the KeePass export dialog", () => {
	it("counts the vault's entries with other versions", () => {
		h.conflicts = new Map([
			["1", { versions: 1, deleted: false }],
			["2", { versions: 1, deleted: false }],
			["3", { versions: 0, deleted: true }],
		]);
		show();
		expect(
			screen.getByText(/2 entries have a sync conflict\. Only the version you see is exported\./),
		).toBeTruthy();
	});

	it("says nothing when no entry has another version", () => {
		h.conflicts = new Map([["3", { versions: 0, deleted: true }]]);
		show();
		expect(screen.queryByText(/sync conflict/)).toBeNull();
	});
});
