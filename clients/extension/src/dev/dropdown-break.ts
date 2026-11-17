// Dev-only break harness for the autofill dropdown. It is not a build input, so it never ships.
//
// The worst case enters through the same boundary as the demo case: an array of login rows passed
// to the real `dropdownItem` / `dropdownSuggest` / `dropdownLocked` templates and the real
// `dropdownStyles` sheet. Nothing in the component is edited to produce a break.
//
// Open http://localhost:5174/dev/dropdown-break.html after `pnpm --filter @vault/platform-extension exec vite`.

type Locale = "en" | "de";
type Theme = "light" | "dark";
type Layout = "compact" | "normal";
type State = "demo" | "worst" | "empty" | "one" | "thousand" | "suggest" | "locked";

type Fixture = {
	id: string;
	name: string;
	secondary: string;
	carried?: boolean;
};

const MESSAGES: Record<Locale, Record<string, string>> = {
	en: {
		usedHere: "Used here",
		openEntryDetails: "Open in Bramble",
		suggestPasswordUse: "Use suggested password",
		suggestPasswordRegenerate: "Generate another",
		menuMore: "Keep typing to narrow the list",
		vaultLocked: "Vault locked",
		vaultLockedUnlockHint: "Unlock Bramble to fill",
	},
	de: {
		usedHere: "Hier verwendet",
		openEntryDetails: "In Bramble öffnen",
		suggestPasswordUse: "Vorgeschlagenes Passwort verwenden",
		suggestPasswordRegenerate: "Anderes erzeugen",
		menuMore: "Weitertippen, um die Liste einzugrenzen",
		vaultLocked: "Tresor gesperrt",
		vaultLockedUnlockHint: "Bramble entsperren, um auszufüllen",
	},
};

const params = new URLSearchParams(location.search);
const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
	const value = params.get(key);
	return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
};

let state = pick<State>(
	"state",
	["demo", "worst", "empty", "one", "thousand", "suggest", "locked"],
	"demo",
);
let layout = pick<Layout>("layout", ["compact", "normal"], "compact");
let locale = pick<Locale>("locale", ["en", "de"], "en");
let theme = pick<Theme>("theme", ["light", "dark"], "light");

// content-api reads globalThis.chrome at import time, so the stub goes in before the dynamic
// imports. The real templates call t() at render time, which reads this mutable table.
(globalThis as unknown as { chrome: unknown }).chrome = {
	i18n: { getMessage: (key: string) => MESSAGES[locale][key] ?? key },
};

const { dropdownItem } = await import("../content/html/dropdown-item");
const { dropdownSuggest } = await import("../content/html/dropdown-suggest");
const { dropdownLocked } = await import("../content/html/dropdown-locked");
const { dropdownMore } = await import("../content/html/dropdown-more");
const { dropdownStyles } = await import("../content/html/dropdown-styles");

const DEMO: Fixture[] = [
	{ id: "1", name: "Example Login", secondary: "alice@example.com" },
	{ id: "2", name: "Work account", secondary: "alice@work.example.com" },
	{ id: "3", name: "Personal", secondary: "alice.personal@example.com", carried: true },
];

// One dataset, many failures spread across rows. Every value is realistic or schema-possible:
// the login name and username fields have no maxLength and no schema limit, so they are unbounded.
const WORST: Fixture[] = [
	{
		id: "1",
		name: "Aleksandra Wiśniewska-Kowalczyk",
		secondary: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
		carried: true,
	},
	{
		id: "2",
		name: "Christopher Alexander Montgomery III",
		secondary: "first.last+billing-notifications@example.com",
	},
	{ id: "3", name: "Jo", secondary: "a@b.co" },
	{ id: "4", name: "🦊 Fox", secondary: "priya@example.com" },
	{ id: "5", name: "Đặng Thị Ngọc Hân", secondary: "ops@sub.department.region.example.co.uk" },
	{ id: "6", name: "王秀英", secondary: "wang.xiuying@example.com" },
	{ id: "7", name: "", secondary: "noname@example.com" },
	{ id: "8", name: "Costco", secondary: "" },
];

const LONG_PASSWORD = "correct-horse-battery-staple-7Q!mZ#vR2pL@xN4kT&wY9cF6hJ8sD1gB5";

const host = document.getElementById("menu") as HTMLElement;
const empty = document.getElementById("empty") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `${dropdownStyles}<div class="tp-dropdown" role="listbox"></div>`;
const list = shadow.querySelector<HTMLElement>(".tp-dropdown")!;

function rowsFor(next: State): Fixture[] {
	if (next === "demo") return DEMO;
	if (next === "worst") return WORST;
	if (next === "one") return [DEMO[0]!];
	if (next === "thousand") {
		return Array.from({ length: 1000 }, (_, i) => ({
			id: String(i),
			name: `Account ${i}`,
			secondary: `user${i}@example.com`,
			carried: i === 0,
		}));
	}
	return [];
}

function render(): void {
	document.body.classList.toggle("dark", theme === "dark");
	host.style.setProperty("--tp-surface", theme === "dark" ? "#23262b" : "#ffffff");
	host.style.setProperty("--tp-foreground", theme === "dark" ? "#f2f3f5" : "#17202b");
	host.style.setProperty("--tp-border", theme === "dark" ? "#3a3d44" : "#dfe3e8");
	// The real skin returns a muted colour with a 4.5:1 floor; mirror that here so the dark
	// state shows what the component will draw, not the old fixed theme grey.
	host.style.setProperty("--tp-muted", theme === "dark" ? "#b9bec7" : "#5a6068");

	empty.style.display = "none";
	host.style.display = "block";
	list.innerHTML = "";

	if (state === "empty") {
		host.style.display = "none";
		empty.style.display = "block";
		statusEl.textContent = "0 rows: the mark hides, so no menu is drawn";
	} else if (state === "suggest") {
		list.innerHTML = dropdownSuggest(LONG_PASSWORD);
		statusEl.textContent = `Suggest row · ${LONG_PASSWORD.length}-character password · ${locale.toUpperCase()}`;
	} else if (state === "locked") {
		list.innerHTML = dropdownLocked();
		statusEl.textContent = `Locked row · ${locale.toUpperCase()}`;
	} else {
		const rows = rowsFor(state);
		// The content script caps the rendered list at 50 and appends the note; mirror that here so
		// the toggle shows the fixed component, not the raw 1,000-row worst case.
		const shown = state === "thousand" ? rows.slice(0, 50) : rows;
		const more = shown.length < rows.length;
		const started = performance.now();
		list.innerHTML =
			shown
				.map((row) =>
					dropdownItem({
						id: row.id,
						name: row.name,
						secondary: row.secondary,
						carried: row.carried,
						compact: layout === "compact",
					}),
				)
				.join("") + (more ? dropdownMore() : "");
		const elapsed = performance.now() - started;
		const noun = shown.length === 1 ? "row" : "rows";
		statusEl.textContent =
			state === "thousand"
				? `${rows.length.toLocaleString()} matches · ${shown.length} ${noun} + note in ${elapsed.toFixed(1)} ms · ${layout} · ${locale.toUpperCase()}`
				: `${shown.length} ${noun} · ${layout} · ${locale.toUpperCase()} · ${theme} field`;
	}

	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-state]")) {
		button.setAttribute("aria-pressed", String(button.dataset.state === state));
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-layout]")) {
		button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
		button.setAttribute("aria-pressed", String(button.dataset.locale === locale));
	}
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme]")) {
		button.setAttribute("aria-pressed", String(button.dataset.theme === theme));
	}

	const url = new URL(location.href);
	url.searchParams.set("state", state);
	url.searchParams.set("layout", layout);
	url.searchParams.set("locale", locale);
	url.searchParams.set("theme", theme);
	history.replaceState(null, "", url);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-state]")) {
	button.addEventListener("click", () => {
		state = button.dataset.state as State;
		render();
	});
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-layout]")) {
	button.addEventListener("click", () => {
		layout = button.dataset.layout as Layout;
		render();
	});
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-locale]")) {
	button.addEventListener("click", () => {
		locale = button.dataset.locale as Locale;
		render();
	});
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme]")) {
	button.addEventListener("click", () => {
		theme = button.dataset.theme as Theme;
		render();
	});
}

render();

export {};
