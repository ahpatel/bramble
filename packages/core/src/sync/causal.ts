// Causal history of an entry version, so a merge can tell an ancestor (an ordinary earlier edit)
// from a concurrent version (a conflict). See docs/sync-conflicts.md, Phase A.
//
// H(V) is every event (writer, stamp) with stamp <= V.floor, or stamp <= V.vv[writer]. A version
// with no vv was written by an older build and claims, LWW-style, every event up to its own stamp.

import { z } from "zod";
import { compareHlc, formatHlc, type Hlc, HlcSchema, isFutureStamp } from "./hlc";

/** Per writer key, the stamp of that writer's latest event in a version's history. */
export type VersionVector = Record<string, Hlc>;
export const VersionVectorSchema: z.ZodType<VersionVector> = z.record(z.string(), HlcSchema);

export interface Causal {
	vv: VersionVector;
	floor?: Hlc;
}

/** Anything that carries a stamp and, from a newer build, its causal history. */
export interface Versioned {
	readonly hlc: Hlc;
	readonly vv?: VersionVector;
	readonly floor?: Hlc;
}

const maxHlc = (a: Hlc | undefined, b: Hlc | undefined): Hlc | undefined =>
	!a ? b : !b ? a : compareHlc(a, b) >= 0 ? a : b;

const atOrBefore = (stamp: Hlc, bound: Hlc | undefined): boolean =>
	bound !== undefined && compareHlc(stamp, bound) <= 0;

/** A version's history; a legacy version (no vv) claims everything up to its stamp. */
export function causalOf(v: Versioned): Causal {
	if (!v.vv) return { vv: {}, floor: v.hlc };
	return v.floor ? { vv: v.vv, floor: v.floor } : { vv: v.vv };
}

/** The writer key of a version's own event: the vv key holding its stamp, or its node if legacy. */
export function writerOf(v: Versioned): string {
	if (!v.vv) return v.hlc.node;
	for (const [key, stamp] of Object.entries(v.vv)) {
		if (compareHlc(stamp, v.hlc) === 0) return key;
	}
	return v.hlc.node;
}

function causalHas(c: Causal, writer: string, stamp: Hlc): boolean {
	return atOrBefore(stamp, c.floor) || atOrBefore(stamp, c.vv[writer]);
}

/** Whether the event (writer, stamp) is in v's history. */
export function inHistory(writer: string, stamp: Hlc, v: Versioned): boolean {
	return causalHas(causalOf(v), writer, stamp);
}

/** Whether x is an ancestor of y: x's own event is in y's history. */
export function isAncestor(x: Versioned, y: Versioned): boolean {
	return inHistory(writerOf(x), x.hlc, y);
}

/** Whether all of inner's history is inside outer's. */
export function containsHistory(outer: Versioned, inner: Versioned): boolean {
	const o = causalOf(outer);
	const i = causalOf(inner);
	if (i.floor && !atOrBefore(i.floor, o.floor)) return false;
	return Object.entries(i.vv).every(([key, stamp]) => causalHas(o, key, stamp));
}

/** The union of these histories: per-writer max, and the max floor. */
export function joinCausal(versions: readonly Versioned[]): Causal {
	const vv: VersionVector = {};
	let floor: Hlc | undefined;
	for (const v of versions) {
		const c = causalOf(v);
		floor = maxHlc(floor, c.floor);
		for (const [key, stamp] of Object.entries(c.vv)) {
			const cur = vv[key];
			if (!cur || compareHlc(stamp, cur) > 0) vv[key] = stamp;
		}
	}
	return floor ? { vv, floor } : { vv };
}

/** The latest event under `key` across these versions, counting a legacy version's own event. */
function latestEvent(key: string, versions: readonly Versioned[]): Hlc | undefined {
	let latest: Hlc | undefined;
	for (const v of versions) {
		latest = maxHlc(latest, v.vv ? v.vv[key] : v.hlc.node === key ? v.hlc : undefined);
	}
	return latest;
}

/**
 * The history of a new write stamped `hlc` that supersedes `bases`, given every version held for
 * the entry. Writes under `hlc.node` unless the bases lack that key's latest event, which would
 * break the one-chain-per-writer rule; then it reuses a fork key of this node the bases do
 * contain, or mints one.
 */
export function nextCausal(a: {
	hlc: Hlc;
	bases: readonly Versioned[];
	held: readonly Versioned[];
}): Causal {
	const joined = joinCausal(a.bases);
	const known = [...a.held, ...a.bases];
	const safe = (key: string): boolean => {
		const latest = latestEvent(key, known);
		return latest === undefined || causalHas(joined, key, latest);
	};
	const node = a.hlc.node;
	let writer = node;
	if (!safe(node)) {
		const prefix = `${node}~`;
		const forks = [...new Set(known.flatMap((v) => Object.keys(v.vv ?? {})))]
			.filter((k) => k.startsWith(prefix))
			.sort();
		writer = forks.find(safe) ?? `${prefix}${formatHlc(a.hlc)}`;
	}
	const vv = { ...joined.vv, [writer]: a.hlc };
	return joined.floor ? { vv, floor: joined.floor } : { vv };
}

/**
 * A new write's stamp and history (see nextCausal). A forked write is stamped with its fork key as
 * the node, so a copy an older build strips of its vv still names the writer key its descendants
 * and deletes recorded; otherwise that copy would claim, LWW-style, versions it never saw.
 */
export function nextVersion(a: {
	hlc: Hlc;
	bases: readonly Versioned[];
	held: readonly Versioned[];
}): { hlc: Hlc; causal: Causal } {
	const causal = nextCausal(a);
	const writer = writerOf({ hlc: a.hlc, ...causal });
	if (writer === a.hlc.node) return { hlc: a.hlc, causal };
	const hlc = { ...a.hlc, node: writer };
	return { hlc, causal: { ...causal, vv: { ...causal.vv, [writer]: hlc } } };
}

/** Whether any stamp a version carries is implausibly far in the future. */
export function isFutureVersion(v: Versioned, now: number = Date.now()): boolean {
	if (isFutureStamp(v.hlc, now)) return true;
	if (v.floor && isFutureStamp(v.floor, now)) return true;
	return Object.values(v.vv ?? {}).some((s) => isFutureStamp(s, now));
}

/** A stable identity for a version's stamp and history, for change detection. */
export function causalKey(v: Versioned): string {
	const vv = v.vv
		? Object.entries(v.vv)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, s]) => `${k}=${formatHlc(s)}`)
				.join(",")
		: "-";
	return `${formatHlc(v.hlc)}|${vv}|${v.floor ? formatHlc(v.floor) : ""}`;
}
