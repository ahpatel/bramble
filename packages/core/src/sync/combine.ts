// Combining sibling versions of one entry part by part. See docs/sync-conflicts.md, Phase B.
//
// The output is a wire protocol: two builds that combine the same inputs must write the same
// version, so any change to parts, normalization or the list rules bumps COMBINE_RULES_VERSION
// (combine.golden.test.ts pins the output of the current one).

import type { Entry, EntryData } from "../hooks/useVault";
import {
	effectivePartStamps,
	fieldsOfPart,
	ITEM_LISTS,
	type ItemList,
	type ItemStamps,
	itemsOf,
	type PartStamps,
	partsEqual,
	partsOf,
} from "../vault/parts";
import { withSupersededPasswords } from "../vault/password-changelog";
import type { EncryptedEntry } from "../vault-format";
import { type Causal, causalKey, inHistory, joinCausal, type Versioned } from "./causal";
import { compareHlc, type Hlc } from "./hlc";

/** Off until most devices record part stamps (release B2 flips it). */
export const COMBINE_CONCURRENT_EDITS = false;
/** The combine rules' version; a newer one's result descends from an older one's. */
export const COMBINE_RULES_VERSION = 1;

/** One version of an entry, sealed and decrypted. */
export interface Sibling {
	envelope: EncryptedEntry;
	data: EntryData;
}

/** A combined version: what to seal, its stamp and history, and the versions it replaces. */
export interface Combined {
	data: EntryData;
	hlc: Hlc;
	causal: Causal;
	replaces: EncryptedEntry[];
}

/**
 * Whether `other` has seen `stamp`, which `holder` carries. A stamp the holder records through its
 * vv (a write that carried a history) only counts as seen through the other's vv: a floor is an
 * older build's guess and may stand in for older builds' events, never for a newer build's change.
 */
export function seenBy(stamp: Hlc, holder: Versioned, other: Versioned): boolean {
	const tracked = holder.vv?.[stamp.node];
	if (tracked && compareHlc(stamp, tracked) <= 0) {
		const seen = other.vv?.[stamp.node];
		return seen !== undefined && compareHlc(stamp, seen) <= 0;
	}
	return inHistory(stamp.node, stamp, other);
}

interface Side {
	data: Record<string, unknown>;
	version: Versioned;
	stale: boolean;
	parts: PartStamps;
	items: Record<ItemList, Record<string, Hlc>>;
}

function sideOf(s: Sibling): Side {
	const eff = effectivePartStamps(s.data, s.envelope);
	return {
		data: s.data as unknown as Record<string, unknown>,
		version: s.envelope,
		stale: eff.stale,
		parts: eff.parts,
		items: eff.items,
	};
}

/** A part's stamp on a side; undefined means the part was never touched there. */
const partStamp = (side: Side, part: string): Hlc | undefined =>
	side.stale ? side.version.hlc : side.parts[part];

const later = (x: Hlc, y: Hlc) => (compareHlc(x, y) >= 0 ? x : y);

/** Which side's value a part takes, or a conflict when both changed it. `a` is the higher stamp. */
function choosePart(a: Side, b: Side, part: string, va: unknown, vb: unknown): "a" | "b" | null {
	const sa = partStamp(a, part);
	const sb = partStamp(b, part);
	if (partsEqual(va, vb)) return !sa || (sb && compareHlc(sb, sa) > 0) ? "b" : "a";
	if (!sa) return "b";
	if (!sb) return "a";
	const aSeen = seenBy(sa, a.version, b.version);
	const bSeen = seenBy(sb, b.version, a.version);
	if (aSeen && !bSeen) return "b";
	if (bSeen && !aSeen) return "a";
	if (aSeen && bSeen) return compareHlc(sa, sb) >= 0 ? "a" : "b";
	return null;
}

/** Combine two sides, `a` the higher stamp, or null when they conflict. */
function combinePair(a: Side, b: Side): Side | null {
	if (a.data.type !== b.data.type) return null;
	const type = String(a.data.type);
	const aParts = partsOf(a.data as unknown as EntryData);
	const bParts = partsOf(b.data as unknown as EntryData);
	const names = new Set([
		...aParts.keys(),
		...bParts.keys(),
		...Object.keys(a.parts),
		...Object.keys(b.parts),
	]);
	const out: Record<string, unknown> = { ...a.data };
	const parts: PartStamps = {};
	let credentialFrom = a;
	for (const name of [...names].sort()) {
		const pick = choosePart(a, b, name, aParts.get(name), bParts.get(name));
		if (!pick) return null;
		const from = pick === "a" ? a : b;
		if (name === "credential") credentialFrom = from;
		for (const field of fieldsOfPart(type, name)) {
			if (from.data[field] === undefined) delete out[field];
			else out[field] = from.data[field];
		}
		const stamp = partStamp(from, name);
		if (stamp) parts[name] = stamp;
	}
	const items = {} as Record<ItemList, Record<string, Hlc>>;
	for (const list of ITEM_LISTS) {
		const aItems = itemsOf(a.data as unknown as EntryData, list);
		const bItems = itemsOf(b.data as unknown as EntryData, list);
		const kept: [string, unknown, Hlc][] = [];
		for (const [key, item] of aItems) {
			const sa = a.items[list][key] as Hlc;
			const sb = b.items[list][key];
			// On both: kept once, as the higher stamp has it. On one: kept unless the other saw it go.
			if (sb) kept.push([key, item, later(sa, sb)]);
			else if (!seenBy(sa, a.version, b.version)) kept.push([key, item, sa]);
		}
		for (const [key, item] of bItems) {
			const sb = b.items[list][key] as Hlc;
			if (!aItems.has(key) && !seenBy(sb, b.version, a.version)) kept.push([key, item, sb]);
		}
		items[list] = Object.fromEntries(kept.map(([key, , stamp]) => [key, stamp]));
		if (kept.length > 0) out[list] = kept.map(([, item]) => item);
		else delete out[list];
	}
	const min = (x: unknown, y: unknown) =>
		typeof x === "number" && typeof y === "number" ? Math.min(x, y) : (x ?? y);
	const max = (x: unknown, y: unknown) =>
		typeof x === "number" && typeof y === "number" ? Math.max(x, y) : (x ?? y);
	out.createdAt = min(a.data.createdAt, b.data.createdAt);
	out.updatedAt = max(a.data.updatedAt, b.data.updatedAt);
	out.lastUsedAt = max(a.data.lastUsedAt, b.data.lastUsedAt);
	for (const k of ["createdAt", "updatedAt", "lastUsedAt"]) if (out[k] === undefined) delete out[k];
	if (type === "login") {
		if (credentialFrom.data.breach === undefined) delete out.breach;
		else out.breach = credentialFrom.data.breach;
	}
	const join = joinCausal([a.version, b.version]);
	return {
		data: out,
		version: { hlc: later(a.version.hlc, b.version.hlc), ...join },
		stale: false,
		parts,
		items,
	};
}

/** The synthetic writer and node of a combined version: unique to the exact set it replaces. */
async function mergeNode(inputs: readonly Sibling[]): Promise<string> {
	const text = inputs
		.map((s) => causalKey(s.envelope))
		.sort()
		.join("\n");
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
	);
	const b64 = btoa(String.fromCharCode(...digest.slice(0, 16)));
	return `~merge:${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * Combine sibling versions of one entry: fold them highest stamp first, leaving out any that
 * conflict with the running result. Null when fewer than two fold. A pure function of its inputs
 * (and the rules version), so every device that combines the same set writes the same version.
 */
export async function combineSiblings(
	siblings: readonly Sibling[],
	rulesVersion: number = COMBINE_RULES_VERSION,
): Promise<Combined | null> {
	const sorted = [...siblings].sort((x, y) => compareHlc(y.envelope.hlc, x.envelope.hlc));
	const [first, ...rest] = sorted;
	if (!first) return null;
	let acc = sideOf(first);
	const folded: Sibling[] = [first];
	for (const next of rest) {
		const combined = combinePair(acc, sideOf(next));
		if (!combined) continue;
		acc = combined;
		folded.push(next);
	}
	if (folded.length < 2) return null;
	const top = first.envelope.hlc;
	const hlc: Hlc = {
		wall: top.wall,
		counter: top.counter + rulesVersion,
		node: await mergeNode(folded),
	};
	const join = joinCausal(folded.map((s) => s.envelope));
	const causal: Causal = {
		vv: { ...join.vv, [hlc.node]: hlc },
		...(join.floor ? { floor: join.floor } : {}),
	};
	const { id: _id, ...data } = withSupersededPasswords(
		{
			...acc.data,
			partStamps: acc.parts,
			itemStamps: pruneEmpty(acc.items),
			partStampsAt: hlc,
		} as unknown as Entry,
		folded.map((s) => s.data),
		hlc.wall,
	);
	return { data: data as EntryData, hlc, causal, replaces: folded.map((s) => s.envelope) };
}

function pruneEmpty(items: Record<ItemList, Record<string, Hlc>>): ItemStamps {
	const out: ItemStamps = {};
	for (const list of ITEM_LISTS) if (Object.keys(items[list]).length > 0) out[list] = items[list];
	return out;
}
