/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { RosterPayload } from "../../../../sync";
import { SyncConnectSection } from "./SyncConnectSection";

// Renaming lives on the "this device" row only. That is not a UI preference: winning the
// roster's last-writer-wins merge needs a freshly stamped entry, the stamp is inside the signed
// canonical, and only the owning device holds its signing key — so no other row can be renamed
// from here. What is under test is that the affordance appears exactly there, carries the typed
// name to the action, and the refreshed list shows it.

const h = vi.hoisted(() => {
	let group: { groupKey: string; roster: RosterPayload } | null = null;
	return {
		// Getters, so a test can seed and mutate the stored group directly.
		get group() {
			return group;
		},
		set group(v) {
			group = v;
		},
		renamed: null as string | null,
	};
});

function roster(): RosterPayload {
	return {
		devices: [
			{
				id: "dev-1",
				publicKey: "self-pub-key",
				label: "Chrome on Mac",
				addedAt: 1,
				hlc: { wall: 1000, counter: 0, node: "dev-1" },
				sigKey: "c2lnLWs=",
				sig: "c2ln",
			},
			{
				id: "dev-2",
				publicKey: "peer-pub-key",
				label: "iPhone",
				addedAt: 2,
				hlc: { wall: 1001, counter: 0, node: "dev-2" },
				sigKey: "c2lnLWsy",
				sig: "c2lnMg==",
			},
		],
		revoked: [],
	};
}

vi.mock("../../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/useVault")>()),
	useVault: () => ({ hasPasswordSlot: false }),
	useVaultActions: () => ({
		inviteDevice: vi.fn(),
		removeDevice: vi.fn(),
		verifyMasterPassword: vi.fn(),
		// A real store behind it: the saved name shows up when the panel re-reads the roster.
		renameSelf: vi.fn(async (name: string) => {
			h.renamed = name;
			const g = h.group;
			if (g) {
				const own = g.roster.devices.find((d) => d.publicKey === "self-pub-key");
				if (own) own.label = name;
			}
		}),
	}),
}));

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ syncKey: (k: string) => `${k}:v1` }),
}));

const platform = {
	target: "chromium",
	storage: {
		getMeta: async (key: string) => {
			if (key === "sync.group:v1") return h.group ?? undefined;
			return undefined;
		},
	},
	shell: {
		syncDevicePublicKey: async () => "self-pub-key",
		onSyncEvent: () => () => {},
		onSyncStatus: () => () => {},
	},
} as unknown as Platform;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<SyncConnectSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.group = { groupKey: "Z2s=", roster: roster() };
	h.renamed = null;
});

afterEach(() => {
	cleanup();
	h.group = { groupKey: "Z2s=", roster: roster() };
	h.renamed = null;
});

describe("renaming this device in the sync panel", () => {
	it("offers rename on this device's row and nothing on the peers'", async () => {
		mount();
		expect(await screen.findByText("Synced · 2 devices")).toBeTruthy();

		expect(screen.getByLabelText(/rename this device/i)).toBeTruthy();
		expect(screen.getAllByLabelText(/rename this device/i)).toHaveLength(1);
		// The peer row keeps its remove affordance, not a rename one.
		expect(screen.getByLabelText(/remove iphone/i)).toBeTruthy();
	});

	it("opens pre-filled with the current name and saves the edit to the roster", async () => {
		mount();
		fireEvent.click(await screen.findByLabelText(/rename this device/i));

		const field = screen.getByLabelText(/device name/i) as HTMLInputElement;
		expect(field.value).toBe("Chrome on Mac");
		fireEvent.change(field, { target: { value: "Anish's MacBook" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));

		await waitFor(() => expect(h.renamed).toBe("Anish's MacBook"));
		// The panel re-reads the roster after saving, so the new name is what the user sees.
		await waitFor(() => expect(screen.getByText("Anish's MacBook")).toBeTruthy());
		expect(screen.queryByText("Chrome on Mac")).toBeNull();
	});

	it("will not save an empty name", async () => {
		mount();
		fireEvent.click(await screen.findByLabelText(/rename this device/i));

		fireEvent.change(screen.getByLabelText(/device name/i), { target: { value: "  " } });

		const save = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		expect(h.renamed).toBeNull();
	});

	it("can be closed without changing anything", async () => {
		mount();
		fireEvent.click(await screen.findByLabelText(/rename this device/i));
		fireEvent.change(screen.getByLabelText(/device name/i), { target: { value: "New name" } });
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(h.renamed).toBeNull();
		expect(screen.queryByText(/rename this device/i)).toBeNull();
	});
});
