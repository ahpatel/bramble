// The parts of an entry that combine independently, and the stamps that say which write last
// changed each one. See docs/sync-conflicts.md, Phase B.
//
// This module is the ONLY writer of `partStamps`, `itemStamps` and `partStampsAt`: every write
// routes its new entry through `withPartStamps`, which derives them from the version it replaces
// and discards whatever the caller supplied, the way password-changelog.ts owns its field.

import type { Entry, EntryData } from "../hooks/useVault";
import type { Versioned } from "../sync/causal";
import { compareHlc, type Hlc } from "../sync/hlc";
import { normalizeEntryData } from "./entry-normalize";

export type ItemList = "urls" | "tags" | "passkeys";
export type PartStamps = Record<string, Hlc>;
export type ItemStamps = Partial<Record<ItemList, Record<string, Hlc>>>;

export const ITEM_LISTS: readonly ItemList[] = ["urls", "tags", "passkeys"];

/** The fields this module writes: vault bookkeeping, never content. */
export const PART_STAMP_FIELDS = ["partStamps", "itemStamps", "partStampsAt"] as const;

/** Fields that change together, so a combine never pairs one side's with the other's. */
const GROUPS: Record<string, Record<string, readonly string[]>> = {
	login: { credential: ["username", "password", "totp"] },
	card: { card: ["cardholderName", "number", "brand", "expMonth", "expYear", "cvv"] },
	"ssh-key": { key: ["publicKey", "privateKey", "passphrase", "keyType"] },
};

/** Derived, per-device or bookkeeping fields: never a part. */
const NOT_PARTS = new Set<string>([
	"id",
	"type",
	"createdAt",
	"updatedAt",
	"lastUsedAt",
	"breach",
	"passwordChangelog",
	...PART_STAMP_FIELDS,
	...ITEM_LISTS,
]);

/** The part name of a field named like one of its type's groups, so it can't take its place. */
const FIELD_PART = "field:";

/** The fields a part covers: a group's fields, or the field the part is named after. */
export function fieldsOfPart(type: string, part: string): readonly string[] {
	if (part.startsWith(FIELD_PART)) return [part.slice(FIELD_PART.length)];
	return GROUPS[type]?.[part] ?? [part];
}

/** `""`, `[]` and `undefined` are the same value; objects drop keys that normalize away. */
function normalize(value: unknown): unknown {
	if (value === undefined || value === null || value === "") return undefined;
	if (Array.isArray(value)) return value.length === 0 ? undefined : value.map(normalize);
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = normalize((value as Record<string, unknown>)[key]);
			if (v !== undefined) out[key] = v;
		}
		return Object.keys(out).length === 0 ? undefined : out;
	}
	return value;
}

export function partsEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Part name -> normalized value. Grouped fields are one part; every other field is its own. */
export function partsOf(data: EntryData): Map<string, unknown> {
	const record = data as unknown as Record<string, unknown>;
	const groups = GROUPS[data.type] ?? {};
	const grouped = new Set(Object.values(groups).flat());
	const parts = new Map<string, unknown>();
	for (const [name, fields] of Object.entries(groups)) {
		parts.set(name, normalize(Object.fromEntries(fields.map((f) => [f, record[f]]))));
	}
	for (const key of Object.keys(record)) {
		if (NOT_PARTS.has(key) || grouped.has(key)) continue;
		parts.set(key in groups ? `${FIELD_PART}${key}` : key, normalize(record[key]));
	}
	return parts;
}

/**
 * Item key -> item, for a list that combines item by item. Keys are stored and compared across
 * devices, so a tag's is case-folded without the locale `tagKey` uses for display.
 */
export function itemsOf(data: EntryData, list: ItemList): Map<string, unknown> {
	const items = (data as unknown as Record<string, unknown>)[list];
	if (!Array.isArray(items)) return new Map();
	if (list === "tags") return new Map(items.map((t: string) => [t.trim().toLowerCase(), t]));
	if (list === "passkeys") {
		return new Map(items.map((p: { credentialId: string }) => [p.credentialId, p]));
	}
	return new Map(items.map((u: string) => [u, u]));
}

/**
 * The stamps a version's parts and items carry. A version whose `partStampsAt` isn't its own stamp
 * was rewritten by a build that doesn't keep part stamps, so everything in it counts as changed
 * at its own stamp (`stale`).
 */
export function effectivePartStamps(
	data: EntryData,
	version: Versioned,
): { stale: boolean; parts: PartStamps; items: Record<ItemList, Record<string, Hlc>> } {
	const stale = !data.partStampsAt || compareHlc(data.partStampsAt, version.hlc) !== 0;
	const grouped = new Set(Object.values(GROUPS[data.type] ?? {}).flat());
	const parts: PartStamps = {};
	if (!stale) {
		for (const [name, stamp] of Object.entries(data.partStamps ?? {})) {
			if (!grouped.has(name)) parts[name] = stamp;
		}
	}
	// A stamp left out is the version's own (withPartStamps stores only older ones and clears).
	for (const name of partsOf(data).keys()) {
		if (stale || !parts[name]) parts[name] = version.hlc;
	}
	const items = {} as Record<ItemList, Record<string, Hlc>>;
	for (const list of ITEM_LISTS) {
		const known = stale ? {} : (data.itemStamps?.[list] ?? {});
		items[list] = Object.fromEntries(
			[...itemsOf(data, list).keys()].map((key) => [key, known[key] ?? version.hlc]),
		);
	}
	return { stale, parts, items };
}

/**
 * Stamp a new entry's parts and items against the version it replaces: unchanged parts keep their
 * stamp, changed ones (cleared included) take `hlc`, new items take `hlc`, removed items go.
 *
 * A resolution also replaces the versions the user chose against (`superseded`): wherever one of
 * them disagrees, the kept value is a choice made at `hlc`, so it takes `hlc` too. Keeping the old
 * stamp would let a later combine with an edit of a dropped version bring its value back.
 */
export function withPartStamps(
	next: Entry,
	prev: { data: EntryData; version: Versioned } | undefined,
	hlc: Hlc,
	superseded: readonly EntryData[] = [],
): Entry {
	const nextParts = partsOf(next);
	const before = prev ? effectivePartStamps(prev.data, prev.version) : undefined;
	const prevParts = prev ? partsOf(prev.data) : new Map<string, unknown>();
	const otherParts = superseded.map(partsOf);
	const partStamps: PartStamps = {};
	const names = new Set([
		...nextParts.keys(),
		...prevParts.keys(),
		...Object.keys(before?.parts ?? {}),
		...otherParts.flatMap((parts) => [...parts.keys()]),
	]);
	// Only stamps older than `hlc` are stored, plus clears: a present part or item without one is
	// read back as changed at the version's own stamp (effectivePartStamps).
	for (const name of names) {
		const stamp = before?.parts[name];
		const value = nextParts.get(name);
		const chosen = otherParts.some((parts) => !partsEqual(parts.get(name), value));
		if (stamp && !chosen && partsEqual(prevParts.get(name), value)) {
			if (value === undefined || compareHlc(stamp, hlc) !== 0) partStamps[name] = stamp;
		} else if (value === undefined && (stamp || chosen)) partStamps[name] = hlc;
	}
	const itemStamps: ItemStamps = {};
	for (const list of ITEM_LISTS) {
		const otherItems = superseded.map((data) => itemsOf(data, list));
		const kept: [string, Hlc][] = [];
		for (const k of itemsOf(next, list).keys()) {
			const stamp = before?.items[list][k];
			if (stamp && !otherItems.some((items) => !items.has(k)) && compareHlc(stamp, hlc) !== 0) {
				kept.push([k, stamp]);
			}
		}
		if (kept.length > 0) itemStamps[list] = Object.fromEntries(kept);
	}
	const { partStamps: _p, itemStamps: _i, ...rest } = next;
	return {
		...rest,
		...(Object.keys(partStamps).length > 0 ? { partStamps } : {}),
		...(Object.keys(itemStamps).length > 0 ? { itemStamps } : {}),
		partStampsAt: hlc,
	} as Entry;
}

/**
 * The JSON to seal for a write made outside EntryMutations (the extension background): the entry
 * with its parts stamped against the version it replaces, without its id.
 */
export function stampedPlaintext(
	id: string,
	next: EntryData,
	prev: { data: EntryData; version: Versioned } | undefined,
	hlc: Hlc,
): string {
	// Raw plaintext from an old build can lack `type`; parts are grouped by it.
	const normalize = (d: EntryData) => normalizeEntryData(d as unknown as Record<string, unknown>);
	const { id: _id, ...data } = withPartStamps(
		{ ...normalize(next), id } as Entry,
		prev && { data: normalize(prev.data), version: prev.version },
		hlc,
	);
	return JSON.stringify(data);
}
