// autofill-ui.ts carries its own copy of `html` / `escapeHtml` rather than importing
// content/template.ts, and that duplication is deliberate: the two are separate rollup
// entries, so a shared module would be hoisted into a chunk and the content script has to
// bundle flat (it loads as a classic script). See vite.config.ts.
//
// What the duplication costs is a way to drift. These are escapers, so drift means one entry
// gaining an XSS hole the other doesn't have, silently. Nothing else in the build would
// notice, so this test compares the two implementations directly. If it fails, fix BOTH
// copies; do not "resolve" it by importing one from the other.

import { describe, expect, it } from "vitest";
import uiSource from "../autofill-ui.ts?raw";
import { html as uiHtml } from "../autofill-ui-template";
import aliasSource from "./html/dropdown-alias.ts?raw";
import itemSource from "./html/dropdown-item.ts?raw";
import moreSource from "./html/dropdown-more.ts?raw";
import newLoginSource from "./html/dropdown-new-login.ts?raw";
import stylesSource from "./html/dropdown-styles.ts?raw";
import skinSource from "./skin.ts?raw";
import { html as contentHtml } from "./template";

const HOSTILE = [
	"<script>alert(1)</script>",
	'" onerror="alert(1)',
	"' onclick='alert(1)",
	"a & b < c > d",
	"&amp;already-escaped",
	"",
	"плохой ввод",
	"</textarea><svg onload=alert(1)>",
];

describe("autofill-ui and content templating stay identical", () => {
	it("escapes every interpolation the same way", () => {
		for (const value of HOSTILE) {
			expect(uiHtml`<p>${value}</p>`).toBe(contentHtml`<p>${value}</p>`);
		}
	});

	it("treats arrays as pre-escaped markup in both", () => {
		const parts = ["<b>", "kept", "</b>"];
		expect(uiHtml`<div>${parts}</div>`).toBe(contentHtml`<div>${parts}</div>`);
	});

	it("agrees on nullish and non-string values", () => {
		for (const value of [null, undefined, 0, false, 12.5]) {
			expect(uiHtml`<p>${value}</p>`).toBe(contentHtml`<p>${value}</p>`);
		}
	});
});

// The alias row exists twice for the same reason the escaper does, and unlike the escaper it is
// markup a person edits. A row added to one renderer and not the other is invisible until a
// user on a COEP page (or not on one) meets the half that was not updated. Comparing the
// rendered output catches the drift the escaper test cannot.
describe("the email-alias row is identical in both renderers", () => {
	/** The iframe entry is self-contained by design and runs side effects on import, so its row is
	 * read as source rather than imported. Comparing source is the point: this fails when one
	 * copy moves and the other does not. */
	function uiAliasRowSource(): string {
		const src = uiSource;
		const start = src.indexOf("function aliasRow(");
		expect(start).toBeGreaterThan(-1);
		return src.slice(start, src.indexOf("\nfunction ", start + 1));
	}

	function contentAliasRowSource(): string {
		const src = aliasSource;
		const start = src.indexOf("export function dropdownAlias(");
		expect(start).toBeGreaterThan(-1);
		return src.slice(start);
	}

	/** Every markup-bearing line, stripped of the differences that are allowed: the function's
	 * own name, indentation, and comments. What is left is the row itself. */
	function skeleton(src: string): string[] {
		return src
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("<") || l.startsWith("${") || l.includes('class="tp-'))
			.map((l) => l.replace(/\s+/g, " "));
	}

	it("renders the same markup for every state", () => {
		expect(skeleton(uiAliasRowSource())).toEqual(skeleton(contentAliasRowSource()));
	});

	it("keeps the same hooks the click handlers match on", () => {
		for (const src of [uiAliasRowSource(), contentAliasRowSource()]) {
			expect(src).toContain('data-tp-alias="1"');
			expect(src).toContain("tp-alias-busy");
			expect(src).toContain("tp-alias-error");
		}
	});
});

// The carried-card badge is a third thing living in both renderers. Added to one only it is
// invisible until a user on a COEP page (or not on one) meets the half that was not updated,
// and the symptom is subtle: the row order still changes, with nothing saying why.
describe("the carried-card badge is in both renderers", () => {
	it("is drawn by the iframe renderer", () => {
		expect(uiSource).toContain('class="tp-badge"');
		expect(uiSource).toContain('t("usedHere")');
		expect(uiSource).toContain(".tp-badge {");
	});

	it("is drawn by the shadow renderer", () => {
		expect(itemSource).toContain('class="tp-badge"');
		expect(itemSource).toContain('t("usedHere")');
		expect(stylesSource).toContain(".tp-badge {");
	});
});

// The "new login" row (#213) lives in both renderers too, for the same reason the alias row does.
describe("the new-login row is identical in both renderers", () => {
	const rowLines = (src: string, from: string): string[] => {
		const start = src.indexOf(from);
		expect(start).toBeGreaterThan(-1);
		const end = src.indexOf("`;", start);
		return src
			.slice(start, end)
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("<"));
	};

	it("renders the same markup", () => {
		expect(rowLines(uiSource, "function newLoginRow(")).toEqual(
			rowLines(newLoginSource, "export const dropdownNewLogin"),
		);
	});

	it("keeps the hook the click handlers match on", () => {
		for (const src of [uiSource, newLoginSource]) expect(src).toContain('data-tp-new-login="1"');
	});
});

// The iframe cannot import skin.ts as a value: both entries would share it, Vite would hoist it
// into a chunk, and the content script cannot import one. The constant is copied, so pin it.
describe("the corner-radius ceiling is the same in both renderers", () => {
	const value = (src: string): string | undefined => src.match(/const MAX_RADIUS = (\d+);/)?.[1];

	it("matches content/skin.ts", () => {
		expect(value(uiSource)).toBeDefined();
		expect(value(uiSource)).toBe(value(skinSource));
	});
});

// The avatar initials live twice for the same reason the escaper does. A name that produces a
// broken surrogate in one renderer and a whole emoji in the other is exactly the drift this
// catches; keep the two functions byte-identical.
describe("the avatar initials are identical in both renderers", () => {
	function initialsSource(src: string): string {
		const start = src.indexOf("function initials(");
		expect(start).toBeGreaterThan(-1);
		const end = src.indexOf("\n}\n", start);
		expect(end).toBeGreaterThan(start);
		return src.slice(start, end + 3);
	}

	it("renders the same initials", () => {
		expect(initialsSource(uiSource)).toBe(initialsSource(itemSource));
	});
});

// The note after a capped match list. Added to one renderer only, a user on a COEP page sees 50
// rows with no explanation, or the other sees a note with no cap.
describe("the capped-list note is in both renderers", () => {
	it("is drawn by the iframe renderer", () => {
		expect(uiSource).toContain('class="tp-more"');
		expect(uiSource).toContain('t("menuMore")');
		expect(uiSource).toContain(".tp-more {");
	});

	it("is drawn by the shadow renderer", () => {
		expect(moreSource).toContain('class="tp-more"');
		expect(moreSource).toContain('t("menuMore")');
		expect(stylesSource).toContain(".tp-more {");
	});
});

// The carried badge and the open action share one trailing slot and swap on hover. Without the
// slot in one renderer, that half stacks them side by side and the row's right edge moves.
describe("the trailing slot is in both renderers", () => {
	it("is drawn by the iframe renderer", () => {
		expect(uiSource).toContain('class="tp-trail"');
		expect(uiSource).toContain(".tp-trail {");
	});

	it("is drawn by the shadow renderer", () => {
		expect(itemSource).toContain('class="tp-trail"');
		expect(stylesSource).toContain(".tp-trail {");
	});

	it("keeps one monogram treatment rather than a per-entry palette", () => {
		for (const src of [uiSource, itemSource]) {
			expect(src).not.toContain("AVATAR_COLORS");
			expect(src).not.toMatch(/style="background:/);
		}
	});
});
