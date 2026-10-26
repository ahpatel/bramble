// Is this entry the same credential as one already in the vault?
//
// Used to spot a file being imported twice. The comparison is over the entry's CONTENT: two
// entries match when everything the file could carry matches, ignoring what the vault stamped
// on afterwards.
//
// Those stamps are why a naive whole-object compare finds nothing. `importMany` mints a fresh
// `id` and defaults `updatedAt` to the moment of import, so the same file imported twice
// produces two objects that differ before any content is examined. The same applies nested:
// a PasskeyCredential carries its own `createdAt`, which the Bitwarden importer falls back to
// `Date.now()` for when the export has no creation date.
//
// Content identity only catches the same FILE. The same login exported by another manager
// differs field by field (custom fields, extra URLs, notes), so a looser credential identity
// sits beside it: same site, username and password for a login, same number for a card. Those
// are held back for the user to confirm rather than dropped. See docs/encrypted-import.md.

import type { EntryData } from "../hooks/useVault";
import { PART_STAMP_FIELDS } from "./parts";

/**
 * Vault bookkeeping, stripped at any depth. `createdAt` is included because only some
 * importers can recover it from the file; leaving it in would make matching work for Bitwarden
 * and quietly fail for every format that doesn't carry a creation date. `archivedAt` is
 * included so re-importing the file an entry came from still recognizes the archived copy,
 * and `tags` for the same reason: an import can seed them, but they are curated locally
 * afterwards, and a hand-added tag must not make the source file look like a new entry. Part
 * stamps are sync bookkeeping every write adds.
 */
const METADATA_KEYS = new Set<string>([
	"id",
	"createdAt",
	"updatedAt",
	"lastUsedAt",
	"archivedAt",
	"tags",
	"breach",
	...PART_STAMP_FIELDS,
]);

/**
 * Canonical JSON: object keys sorted so a re-ordered but identical entry still matches (stored
 * entries come back through `normalizeEntryData`, which rebuilds them), `undefined` dropped so
 * an absent field and an explicitly-undefined one agree, and ARRAY ORDER PRESERVED because
 * urls in a different order really is a different entry.
 */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		if (METADATA_KEYS.has(key)) continue;
		const v = (value as Record<string, unknown>)[key];
		if (v === undefined) continue;
		out[key] = canonical(v);
	}
	return out;
}

/** A string that is equal for two entries holding the same credential. */
export function entryContentKey(entry: EntryData): string {
	return JSON.stringify(canonical(entry));
}

/** A website's host with case and `www.` dropped (a bare host read as https); an app link as itself. */
function siteKey(url: string): string {
	const raw = url.trim();
	if (!raw) return "";
	try {
		const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.hostname.toLowerCase().replace(/^www\./, "");
		}
		return raw.toLowerCase();
	} catch {
		return "";
	}
}

const fold = (s: string | undefined) => (s ?? "").trim().toLowerCase();

interface Credential {
	hosts: Set<string>;
	name: string;
	password: string;
}

function credentialOf(entry: EntryData): Credential | null {
	if (entry.type !== "login") return null;
	const hosts = new Set((entry.urls ?? []).map(siteKey).filter((h) => h !== ""));
	return { hosts, name: fold(entry.name), password: entry.password ?? "" };
}

/** The same site: a shared host or app link, or for two logins with neither, the same title. */
function sameSite(a: Credential, b: Credential): boolean {
	if (a.hosts.size === 0 || b.hosts.size === 0) {
		return a.hosts.size === 0 && b.hosts.size === 0 && a.name === b.name;
	}
	for (const h of a.hosts) if (b.hosts.has(h)) return true;
	return false;
}

const cardNumber = (entry: EntryData) =>
	entry.type === "card" ? (entry.number ?? "").replace(/\D/g, "") : "";

export interface ImportSplit {
	/** New to the vault: import these. */
	fresh: EntryData[];
	/** Identical to an entry the vault holds (or to one earlier in the batch): dropped. */
	duplicates: number;
	/** The same login (site, username, password) or card (number) in another shape: held back. */
	likelyDuplicates: EntryData[];
	/** In `fresh` but sharing a site and username with a vault login under another password. */
	passwordDiffers: number;
}

/**
 * Split incoming entries against the vault. Exact copies, including repeats within the batch,
 * are dropped; the same credential in another manager's shape is held back for the caller to
 * offer; everything else is fresh.
 */
export function splitAlreadyImported(
	existing: readonly EntryData[],
	incoming: readonly EntryData[],
): ImportSplit {
	const seen = new Set(existing.map(entryContentKey));
	const byUser = new Map<string, Credential[]>();
	const cards = new Set<string>();
	for (const entry of existing) {
		const cred = credentialOf(entry);
		if (cred && entry.type === "login") {
			const user = fold(entry.username);
			byUser.set(user, [...(byUser.get(user) ?? []), cred]);
		}
		const number = cardNumber(entry);
		if (number.length >= 12) cards.add(number);
	}

	const split: ImportSplit = { fresh: [], duplicates: 0, likelyDuplicates: [], passwordDiffers: 0 };
	for (const entry of incoming) {
		const key = entryContentKey(entry);
		if (seen.has(key)) {
			split.duplicates++;
			continue;
		}
		seen.add(key);

		const cred = credentialOf(entry);
		if (cred && entry.type === "login" && cred.password !== "") {
			const sameSiteAndUser = (byUser.get(fold(entry.username)) ?? []).filter((o) =>
				sameSite(o, cred),
			);
			if (sameSiteAndUser.some((o) => o.password === cred.password)) {
				split.likelyDuplicates.push(entry);
				continue;
			}
			if (fold(entry.username) !== "" && sameSiteAndUser.length > 0) split.passwordDiffers++;
		}
		const number = cardNumber(entry);
		if (number.length >= 12 && cards.has(number)) {
			split.likelyDuplicates.push(entry);
			continue;
		}
		split.fresh.push(entry);
	}
	return split;
}
