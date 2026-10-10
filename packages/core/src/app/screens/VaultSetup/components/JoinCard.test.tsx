/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { JoinCard } from "./JoinCard";

// The join form is the one place a device can name itself before it ever appears on another
// device's list as another "Chrome on Mac". What is under test is that the typed name travels
// to the join, and that an empty field means "use the automatic label" rather than a blank one.

const h = vi.hoisted(() => ({
	deviceLabel: "Chrome on Mac",
	joined: null as { deviceName: string | undefined } | null,
}));

const platform = {
	target: "chromium",
	storage: {},
	shell: {
		deviceLabel: () => h.deviceLabel,
		scanQrFromActiveTab: vi.fn(async () => null),
	},
} as unknown as Platform;

function mount() {
	const onJoin = vi.fn(async (_code: string, _unlock: unknown, deviceName?: string) => {
		h.joined = { deviceName };
	});
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<JoinCard onJoin={onJoin} busy={false} error={null} />
			</PlatformProvider>
		</I18nProvider>,
	);
	return onJoin;
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	h.joined = null;
});

function fillAndSubmit(deviceName?: string) {
	fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "CODE" } });
	fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
	if (deviceName !== undefined) {
		fireEvent.change(screen.getByLabelText(/device name/i), { target: { value: deviceName } });
	}
	fireEvent.click(screen.getByRole("button", { name: /join vault/i }));
}

describe("the join form's device name", () => {
	it("sends a typed name along with the join", async () => {
		const onJoin = mount();
		fillAndSubmit("Anish's MacBook");
		await waitFor(() => expect(h.joined).not.toBeNull());
		expect(onJoin).toHaveBeenCalledWith("CODE", expect.anything(), "Anish's MacBook");
	});

	it("passes no name when left empty, so the automatic label applies", async () => {
		// Empty must mean the auto label, not a blank roster entry: the field is optional.
		mount();
		fillAndSubmit();
		await waitFor(() => expect(h.joined).not.toBeNull());
		expect(h.joined?.deviceName).toBeUndefined();
	});

	it("trims whitespace rather than sending a padded name", async () => {
		mount();
		fillAndSubmit("  Office Mac  ");
		await waitFor(() => expect(h.joined).not.toBeNull());
		expect(h.joined?.deviceName).toBe("Office Mac");
	});

	it("tells the user what the default will be, so the choice is explicit", () => {
		mount();
		expect(screen.getByText(/chrome on mac/i)).toBeTruthy();
	});

	it("caps the name so it cannot bloat the roster entry", () => {
		mount();
		expect(screen.getByLabelText(/device name/i).getAttribute("maxlength")).toBe("60");
	});
});
