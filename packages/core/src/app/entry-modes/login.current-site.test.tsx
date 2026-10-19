/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { loginMode } from "./login";

// The website field's "use current site" button: shown only where the shell knows an http(s)
// tab, only on an empty row, and filling exactly the origin a new login is seeded with.

vi.mock("../../hooks/usePrefs", () => ({ usePrefs: () => ({ prefs: {} }) }));
vi.mock("../../hooks/useAliasProvider", () => ({ useAliasProvider: () => ({ enabled: false }) }));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

let latest: () => FieldValues = () => ({});

function Host({ urls }: { urls: string[] }) {
	const methods = useForm<FieldValues>({
		defaultValues: { ...loginMode.emptyForm({}), urls: urls.map((value) => ({ value })) },
	});
	latest = methods.getValues;
	const Fields = loginMode.Fields;
	return (
		<FormProvider {...methods}>
			<Fields />
		</FormProvider>
	);
}

function mount(origin: string | null, urls: string[] = [""]) {
	const getCurrentTabOrigin = vi.fn(async () => origin);
	const platform = { shell: { getCurrentTabOrigin } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<Host urls={urls} />
			</PlatformProvider>
		</I18nProvider>,
	);
	return { getCurrentTabOrigin };
}

const siteButtons = () => screen.queryAllByRole("button", { name: "Use current site" });
const urlInputs = () => screen.getAllByLabelText("Website URL") as HTMLInputElement[];

describe("login website field: use current site", () => {
	it("fills an empty row with the tab's origin and moves focus to it", async () => {
		mount("https://example.com");
		const [button] = await waitFor(() => {
			const found = siteButtons();
			expect(found).toHaveLength(1);
			return found;
		});
		expect(button?.getAttribute("title")).toBe("Use https://example.com");

		fireEvent.click(button!);

		expect(urlInputs()[0]?.value).toBe("https://example.com");
		expect(latest().urls).toEqual([{ value: "https://example.com" }]);
		expect(siteButtons()).toHaveLength(0);
		await waitFor(() => expect(document.activeElement).toBe(urlInputs()[0]));
	});

	it("only offers itself on empty rows, so a typed URL is never replaced", async () => {
		mount("https://example.com", ["https://kept.test", ""]);
		await waitFor(() => expect(siteButtons()).toHaveLength(1));
		// The one button sits on the empty second row.
		fireEvent.click(siteButtons()[0]!);
		expect(latest().urls).toEqual([
			{ value: "https://kept.test" },
			{ value: "https://example.com" },
		]);
	});

	it("comes back when the user clears the row", async () => {
		mount("https://example.com", ["https://kept.test"]);
		await waitFor(() => expect(urlInputs()).toHaveLength(1));
		expect(siteButtons()).toHaveLength(0);
		fireEvent.change(urlInputs()[0]!, { target: { value: "  " } });
		await waitFor(() => expect(siteButtons()).toHaveLength(1));
	});

	it("shows on a row added with Add URL", async () => {
		mount("http://localhost:8080", []);
		fireEvent.click(screen.getByRole("button", { name: /Add URL/ }));
		await waitFor(() => expect(siteButtons()).toHaveLength(1));
		fireEvent.click(siteButtons()[0]!);
		expect(latest().urls).toEqual([{ value: "http://localhost:8080" }]);
	});

	// Desktop and mobile report no tab, and the extension reports none for chrome://, about:
	// and its own pages: the shell's null is the only signal, so nothing is offered.
	it("is hidden when there is no current web page", async () => {
		const { getCurrentTabOrigin } = mount(null);
		await act(async () => {});
		expect(getCurrentTabOrigin).toHaveBeenCalled();
		expect(urlInputs()).toHaveLength(1);
		expect(siteButtons()).toHaveLength(0);
	});
});
