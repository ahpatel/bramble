// Enpass .json export: `{ folders, items }`, each item a template with a flat `fields` list.
// Enpass documents none of it. The shape here is what real exports carry, as read by Bitwarden's
// importer (bitwarden/clients, libs/importer/src/importers/enpass) and its test data. Every
// template field is exported whether filled or not, so blank fields are the norm, not a fault.

import { z } from "zod";
import type { CardEntryData, EntryData, LoginEntryData } from "../hooks/useVault";
import { cardBrand, cardBrandNamed } from "../util/card";
import { normalizeTags } from "../vault/tags";
import { asText, hostLabel, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// 0/1 in every export seen; booleans tolerated.
const flag = z.union([z.number(), z.boolean()]).nullish();
const fieldSchema = z.object({
	type: z.string().nullish(),
	label: z.string().nullish(),
	value: z.union([z.string(), z.number()]).nullish(),
	sensitive: flag,
	deleted: flag,
});
const itemSchema = z.object({
	title: z.string().nullish(),
	note: z.string().nullish(),
	template_type: z.string().nullish(),
	fields: z.array(fieldSchema).nullish(),
	folders: z.array(z.string()).nullish(),
	attachments: z.array(z.unknown()).nullish(),
	trashed: flag,
	archived: flag,
	createdAt: z.number().nullish(),
	updated_at: z.number().nullish(),
});
const exportSchema = z.object({
	items: z.array(itemSchema),
	folders: z
		.array(
			z.object({
				uuid: z.string().nullish(),
				parent_uuid: z.string().nullish(),
				title: z.string().nullish(),
			}),
		)
		.nullish(),
});

type EnpassItem = z.infer<typeof itemSchema>;
type Folders = z.infer<typeof exportSchema>["folders"];

const FORMAT_ERROR = "This doesn't look like an Enpass .json export.";

// Masked whatever the `sensitive` flag says.
const SECRET_TYPES = new Set(["password", "totp", "pin", "ccPin", "ccCvc", "ccTxnpassword"]);

interface Field {
	type: string;
	label: string;
	value: string;
	hidden: boolean;
}

/** The fields that hold something: not deleted, not a section heading, not blank. */
function liveFields(item: EnpassItem): Field[] {
	const out: Field[] = [];
	for (const f of item.fields ?? []) {
		const type = f.type ?? "";
		const value = f.value == null ? "" : String(f.value);
		if (f.deleted || type === "section" || value === "") continue;
		out.push({
			type,
			label: f.label?.trim() || type,
			value,
			hidden: Boolean(f.sensitive) || SECRET_TYPES.has(type),
		});
	}
	return out;
}

const extra = (f: Field): RawField => ({ key: f.label, value: f.value, hidden: f.hidden });

type Base = Pick<EntryData, "name" | "notes" | "tags" | "createdAt" | "updatedAt" | "archivedAt">;

function toLogin(fields: Field[], base: Base): LoginEntryData {
	// Enpass's login template has both; the email stands in only when the username is blank.
	const login = fields.find((f) => f.type === "username") ?? fields.find((f) => f.type === "email");
	let password = "";
	let totp = "";
	const urls: string[] = [];
	const extras: RawField[] = [];
	for (const f of fields) {
		if (f === login) continue;
		if (f.type === "password" && !password) password = f.value;
		// Either a bare base32 secret or an otpauth:// URI; parseTotp accepts both.
		else if (f.type === "totp" && !totp) totp = f.value;
		else if (f.type === "url") urls.push(f.value);
		else extras.push(extra(f));
	}
	const username = login?.value ?? "";
	return {
		type: "login",
		...base,
		name: base.name || hostLabel(urls[0] ?? "") || username,
		urls,
		username,
		password,
		totp: totp || undefined,
		customFields: toCustomFields(extras),
	};
}

type Expiry = Pick<CardEntryData, "expMonth" | "expYear">;

/** "MM/YY" or "MM/YYYY", the forms Enpass writes. */
function splitExpiry(value: string): Expiry | null {
	const m = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(value.trim());
	const month = Number(m?.[1]);
	if (!m?.[2] || month < 1 || month > 12) return null;
	return { expMonth: String(month), expYear: m[2] };
}

function toCard(fields: Field[], base: Base): CardEntryData {
	let cardholderName = "";
	let number = "";
	let cvv = "";
	let expiry: Expiry | null = null;
	let named: string | undefined;
	const extras: RawField[] = [];
	for (const f of fields) {
		const readExpiry: Expiry | null =
			f.type === "ccExpiry" && !expiry ? splitExpiry(f.value) : null;
		// The number decides the brand where it can; a type that names none is kept as written.
		const readBrand: string | undefined =
			f.type === "ccType" && !named ? cardBrandNamed(f.value) : undefined;
		if (f.type === "ccName" && !cardholderName) cardholderName = f.value;
		else if (f.type === "ccNumber" && !number) number = f.value;
		else if (f.type === "ccCvc" && !cvv) cvv = f.value;
		else if (readExpiry) expiry = readExpiry;
		else if (readBrand) named = readBrand;
		else extras.push(extra(f));
	}
	return {
		type: "card",
		...base,
		cardholderName,
		number,
		brand: cardBrand(number) ?? named,
		expMonth: expiry?.expMonth ?? "",
		expYear: expiry?.expYear ?? "",
		cvv,
		customFields: toCustomFields(extras),
	};
}

/** Each folder's path from the top, so nested folders become one tag per level. */
function folderPaths(folders: Folders): (uuid: string) => string[] {
	const byId = new Map((folders ?? []).filter((f) => f.uuid).map((f) => [f.uuid, f]));
	return (uuid) => {
		const path: string[] = [];
		const seen = new Set<string>();
		for (let f = byId.get(uuid); f?.uuid && !seen.has(f.uuid); f = byId.get(f.parent_uuid ?? "")) {
			seen.add(f.uuid);
			path.unshift(f.title ?? "");
		}
		return path;
	};
}

const seconds = (s: number | null | undefined): number | undefined => (s ? s * 1000 : undefined);

/** Parse an Enpass .json export into Bramble entries. Throws on non-Enpass input. */
export function parseEnpass(raw: string | Uint8Array): ImportResult {
	let json: unknown;
	try {
		json = JSON.parse(asText(raw));
	} catch {
		throw new Error(FORMAT_ERROR);
	}
	const parsed = exportSchema.safeParse(json);
	if (!parsed.success) throw new Error(FORMAT_ERROR);

	const pathOf = folderPaths(parsed.data.folders);
	const importedAt = Date.now();
	const imported: EntryData[] = [];
	let trashed = 0;
	let attachments = 0;

	for (const item of parsed.data.items) {
		// Enpass's export dialog can include the trash; trashed is not something to bring back.
		if (item.trashed) {
			trashed++;
			continue;
		}
		attachments += item.attachments?.length ?? 0;
		const updatedAt = seconds(item.updated_at);
		const base: Base = {
			name: item.title?.trim() ?? "",
			notes: item.note || undefined,
			// Enpass calls them folders in the file and tags in the app.
			tags: normalizeTags((item.folders ?? []).flatMap(pathOf)),
			createdAt: seconds(item.createdAt),
			updatedAt,
			archivedAt: item.archived ? (updatedAt ?? importedAt) : undefined,
		};
		const fields = liveFields(item);
		const template = item.template_type ?? "";
		if (template.startsWith("creditcard.")) {
			imported.push(toCard(fields, base));
		} else if (
			template.startsWith("login.") ||
			template.startsWith("password.") ||
			// Any other template with a password (an email account, a server) is a login in all
			// but name. Identities aside: their password is one detail among many.
			(!template.startsWith("identity.") && fields.some((f) => f.type === "password"))
		) {
			imported.push(toLogin(fields, base));
		} else {
			imported.push({ type: "note", ...base, customFields: toCustomFields(fields.map(extra)) });
		}
	}

	const warnings: string[] = [];
	if (trashed > 0) warnings.push(`${trashed} item(s) in Enpass's trash were left out.`);
	if (attachments > 0) {
		warnings.push(
			`${attachments} attachment(s) weren't imported, as attachments aren't supported yet. Save them from Enpass before you delete it.`,
		);
	}
	return summarize(imported, trashed, warnings);
}
