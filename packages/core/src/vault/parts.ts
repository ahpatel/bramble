// The parts of an entry that combine independently, and the stamps that say which write last
// changed each one. See docs/sync-conflicts.md, Phase B.
//
// This module is the ONLY writer of `partStamps`, `itemStamps` and `partStampsAt`: every write
// routes its new entry through `withPartStamps`, which derives them from the version it replaces
// and discards whatever the caller supplied, the way password-changelog.ts owns its field.

import type { Entry, EntryData } from "../hooks/useVault";
import type { Versioned } from "../sync/causal";
import { compareHlc, type Hlc } from "../sync/hlc";
import { tagKey } from "./tags";

export type ItemList = "urls" | "tags" | "passkeys";
export type PartStamps = Record<string, Hlc>;
export type ItemStamps = Partial<Record<ItemList, Record<string, Hlc>>>;

export const ITEM_LISTS: readonly ItemList[] = ["urls", "tags", "passkeys"];

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
	"partStamps",
	"itemStamps",
	"partStampsAt",
	...ITEM_LISTS,
]);

/** The fields a part covers: a group's fields, or the field the part is named after. */
export function fieldsOfPart(type: string, part: string): readonly string[] {
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
		parts.set(key, normalize(record[key]));
	}
	return parts;
}

/** Item key -> item, for a list that combines item by item. */
export function itemsOf(data: EntryData, list: ItemList): Map<string, unknown> {
	const items = (data as unknown as Record<string, unknown>)[list];
	if (!Array.isArray(items)) return new Map();
	if (list === "tags") return new Map(items.map((t: string) => [tagKey(t), t]));
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
	const parts: PartStamps = stale ? {} : { ...data.partStamps };
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
 */
export function withPartStamps(
	next: Entry,
	prev: { data: EntryData; version: Versioned } | undefined,
	hlc: Hlc,
): Entry {
	const nextParts = partsOf(next);
	const before = prev ? effectivePartStamps(prev.data, prev.version) : undefined;
	const prevParts = prev ? partsOf(prev.data) : new Map<string, unknown>();
	const partStamps: PartStamps = {};
	const names = new Set([
		...nextParts.keys(),
		...prevParts.keys(),
		...Object.keys(before?.parts ?? {}),
	]);
	for (const name of names) {
		const stamp = before?.parts[name];
		if (stamp && partsEqual(prevParts.get(name), nextParts.get(name))) partStamps[name] = stamp;
		else if (nextParts.get(name) !== undefined || stamp) partStamps[name] = hlc;
	}
	const itemStamps: ItemStamps = {};
	for (const list of ITEM_LISTS) {
		const keys = [...itemsOf(next, list).keys()];
		if (keys.length === 0) continue;
		itemStamps[list] = Object.fromEntries(keys.map((k) => [k, before?.items[list][k] ?? hlc]));
	}
	return { ...next, partStamps, itemStamps, partStampsAt: hlc };
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
	const { id: _id, ...data } = withPartStamps({ id, ...next } as Entry, prev, hlc);
	return JSON.stringify(data);
}
