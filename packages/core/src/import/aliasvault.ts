// AliasVault CSV export. Nothing documents the columns; they are the ones AliasVault's own
// exporter writes (core/client/src/transfer/export/AliasVaultCsvExportService.ts in
// aliasvault/aliasvault). The file is read by header name, because the columns have changed:
// older exports have no card columns and carry an AliasNickName one.
//
// The CSV is AliasVault's lossy export. Passkeys, attachments, tags, custom fields, archive
// state and every TOTP code after the first never reach the file, so there is nothing here to
// warn about per item; the provider card says so instead.

import type { EntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { normalizeTags } from "../vault/tags";
import { ALIASVAULT_CSV, assertFormat, headerLabels } from "./csv-format";
import {
	asText,
	hostLabel,
	parseCsvRows,
	type RawField,
	summarize,
	toCustomFields,
} from "./shared";
import type { ImportResult } from "./types";

const COLUMNS = {
	name: "servicename",
	folder: "folderpath",
	url: "serviceurl",
	username: "username",
	password: "currentpassword",
	email: "aliasemail",
	totp: "twofactorsecret",
	cardholder: "cardholdername",
	number: "cardnumber",
	expMonth: "cardexpirymonth",
	expYear: "cardexpiryyear",
	cvv: "cardcvv",
	pin: "cardpin",
	notes: "notes",
	createdAt: "createdat",
	updatedAt: "updatedat",
} as const;

// The generated identity behind an alias, kept as fields on its login.
const IDENTITY: readonly [column: string, label: string][] = [
	["aliasfirstname", "First name"],
	["aliaslastname", "Last name"],
	["aliasnickname", "Nickname"],
	["aliasgender", "Gender"],
	["aliasbirthdate", "Birth date"],
];

const KNOWN = new Set<string>([...Object.values(COLUMNS), ...IDENTITY.map(([c]) => c)]);

// "MM/dd/yyyy HH:mm:ss" in current exports, "yyyy-MM-dd HH:mm:ss" in older ones. Both UTC.
const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/;

interface DateParts {
	y: string;
	mo: string;
	d: string;
	h: string;
	mi: string;
	s: string;
}

function dateParts(value: string): DateParts | null {
	const v = value.trim();
	const us = US_DATE.exec(v);
	if (us) {
		const [, mo = "", d = "", y = "", h = "0", mi = "0", s = "0"] = us;
		return { y, mo, d, h, mi, s };
	}
	const iso = ISO_DATE.exec(v);
	if (iso) {
		const [, y = "", mo = "", d = "", h = "0", mi = "0", s = "0"] = iso;
		return { y, mo, d, h, mi, s };
	}
	return null;
}

/** Epoch ms, or undefined for anything unreadable (including an impossible date like 02/30). */
function timestamp(value: string): number | undefined {
	const p = dateParts(value);
	if (!p) return undefined;
	const t = Date.UTC(+p.y, +p.mo - 1, +p.d, +p.h, +p.mi, +p.s);
	const date = new Date(t);
	return date.getUTCMonth() === +p.mo - 1 && date.getUTCDate() === +p.d ? t : undefined;
}

/** The date alone, since AliasVault pads a birth date with midnight; verbatim if unreadable. */
function birthDate(value: string): string {
	const p = dateParts(value);
	return p ? `${p.y}-${p.mo}-${p.d}` : value;
}

/** Parse an AliasVault CSV export (`ServiceName,FolderPath,ServiceUrl,Username,…`). */
export function parseAliasVault(raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = headerLabels(rows[0]);
	assertFormat(ALIASVAULT_CSV, header);

	const at = (row: string[], column: string): string => {
		const i = header.indexOf(column);
		return i === -1 ? "" : (row[i] ?? "");
	};
	// Columns this parser doesn't know, by their label as written, so a future one is kept.
	const unknown = (rows[0] ?? [])
		.map((label, i) => ({ label: label.trim(), i }))
		.filter(({ label }) => label && !KNOWN.has(label.toLowerCase()));

	const imported: EntryData[] = [];
	let skipped = 0;
	let foldered = 0;

	for (const row of rows.slice(1)) {
		const get = (column: string) => at(row, column);
		const name = get(COLUMNS.name).trim();
		const notes = get(COLUMNS.notes) || undefined;
		const createdAt = timestamp(get(COLUMNS.createdAt));
		const updatedAt = timestamp(get(COLUMNS.updatedAt));
		const extras: RawField[] = unknown.map(({ label, i }) => ({ key: label, value: row[i] ?? "" }));

		// AliasVault folders nest with slashes ("Work/Clients"). One tag per level, as LastPass.
		const tags = normalizeTags(get(COLUMNS.folder).split("/"));
		const base = { name, notes, tags, createdAt, updatedAt };

		const number = get(COLUMNS.number);
		const card = {
			cardholderName: get(COLUMNS.cardholder),
			number,
			expMonth: get(COLUMNS.expMonth).trim(),
			expYear: get(COLUMNS.expYear).trim(),
			cvv: get(COLUMNS.cvv),
			pin: get(COLUMNS.pin),
		};

		const url = get(COLUMNS.url);
		const username = get(COLUMNS.username);
		const password = get(COLUMNS.password);
		const email = get(COLUMNS.email);
		const totp = get(COLUMNS.totp);
		const identity: RawField[] = IDENTITY.map(([column, label]) => {
			const value = get(column);
			return { key: label, value: column === "aliasbirthdate" && value ? birthDate(value) : value };
		});

		let entry: EntryData;
		if (Object.values(card).some((v) => v.trim())) {
			const month = Number(card.expMonth);
			entry = {
				type: "card",
				...base,
				cardholderName: card.cardholderName,
				number,
				brand: cardBrand(number),
				// "03" and "3" are the same month; the vault stores it without the zero.
				expMonth: card.expMonth && Number.isInteger(month) ? String(month) : card.expMonth,
				expYear: card.expYear,
				cvv: card.cvv,
				customFields: toCustomFields([{ key: "PIN", value: card.pin, hidden: true }, ...extras]),
			};
		} else if (url || username || password || email || totp || identity.some((f) => f.value)) {
			// ServiceUrl holds every URL of the item, comma-separated.
			const urls = url
				.split(",")
				.map((u) => u.trim())
				.filter(Boolean);
			// The alias email is the login for most aliases; kept as a field only when distinct.
			const emailField: RawField[] =
				username && email !== username ? [{ key: "Email", value: email }] : [];
			entry = {
				type: "login",
				...base,
				name: name || hostLabel(urls[0] ?? "") || username || email,
				urls,
				username: username || email,
				password,
				// Either a bare base32 secret or an otpauth:// URI; parseTotp accepts both.
				totp: totp || undefined,
				customFields: toCustomFields([...emailField, ...identity, ...extras]),
			};
		} else if (name || notes || extras.some((f) => f.value)) {
			entry = { type: "note", ...base, customFields: toCustomFields(extras) };
		} else {
			skipped++;
			continue;
		}
		if (tags) foldered++;
		imported.push(entry);
	}

	const warnings: string[] = [];
	if (foldered > 0) {
		warnings.push(`${foldered} item(s) were in an AliasVault folder, imported as tags.`);
	}
	return summarize(imported, skipped, warnings);
}
