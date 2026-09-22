// Lingui .po catalog adapter: fills empty msgstr entries for each target locale.
// Run after `lingui extract`, before `lingui compile`. Idempotent.

import { readFileSync, writeFileSync } from "node:fs";
import { LOCALES, PO_CATALOG } from "./locales.mjs";
import { translateBatch } from "./ollama.mjs";

// One .po quoted string. `\\.` before the character class is what makes an escaped quote part of
// the string instead of the end of it: with a plain `"[^]*?"`, a msgid containing \\" is read as
// ending there, the translator is handed a sentence cut off mid-clause, and it dutifully
// translates the fragment. That shipped truncated copy in five locales before it was noticed, so
// this pattern is the fix and `i18n-check` now fails on the symptom too.
const QUOTED = '"(?:\\\\.|[^"\\\\])*"';
const field = (name) => new RegExp(`^${name} ((?:${QUOTED}\\s*)+)`, "m");

function parsePo(text) {
	return text.split(/\n\n+/).map((block) => ({
		block,
		msgid: decode(block.match(field("msgid"))?.[1]),
		msgstr: decode(block.match(field("msgstr"))?.[1]),
	}));
}

function decode(raw) {
	if (!raw) return "";
	return [...raw.matchAll(new RegExp(QUOTED, "g"))]
		.map((m) => m[0].slice(1, -1))
		.join("")
		.replace(/\\n/g, "\n")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function encode(str) {
	return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export async function run() {
	console.log("• Lingui catalogs (.po)");
	for (const { code, name } of LOCALES) {
		const path = PO_CATALOG(code);
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			console.log(`  ${code}: no catalog yet (run lingui extract) — skipping`);
			continue;
		}
		const blocks = parsePo(text);
		const pending = blocks.filter((b) => b.msgid && !b.msgstr);
		if (!pending.length) {
			console.log(`  ${code}: up to date`);
			continue;
		}
		console.log(`  ${code}: translating ${pending.length} string(s)…`);
		const translations = await translateBatch(
			name,
			pending.map((b) => b.msgid),
		);
		let out = text;
		pending.forEach((b, i) => {
			const filled = b.block.replace(
				new RegExp(`^msgstr (?:${QUOTED}\\s*)+`, "m"),
				`msgstr ${encode(translations[i])}`,
			);
			out = out.replace(b.block, filled);
		});
		writeFileSync(path, out);
		console.log(`  ${code}: wrote ${pending.length}`);
	}
}
