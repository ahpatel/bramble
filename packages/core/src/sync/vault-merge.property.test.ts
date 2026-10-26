// Random multi-device histories against the sibling merge. A simulator plays three devices that
// add, edit, delete, resolve and partially sync, records the TRUE ancestry of every version it
// writes, and checks the merge against it. See docs/sync-conflicts.md, Phase A.

import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import { payloadsEquivalent } from "./apply-remote";
import { causalKey, isAncestor, nextCausal, nextVersion, type Versioned } from "./causal";
import type { EntriesPayload, Tombstone } from "./entries-payload";
import { compareHlc, type Hlc, HybridClock } from "./hlc";
import { olderBuildMerge } from "./older-build.harness";
import { entryConflicts, heldVersions, mergeEntriesPayload } from "./vault-merge";

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Device {
	name: string;
	clock: HybridClock;
	payload: EntriesPayload;
	older: boolean;
	/** Delete labels this device has seen, per entry id. */
	deletes: Map<string, Set<string>>;
}

interface Version {
	label: string;
	id: string;
	v: Versioned;
	/** Every version this one supersedes, directly or not. */
	ancestors: Set<string>;
}

const empty = (): EntriesPayload => ({ entries: [], tombstones: [] });
const stampsOf = (p: EntriesPayload): Hlc[] =>
	[...p.entries, ...(p.conflicts ?? []), ...p.tombstones].flatMap((v) => [
		v.hlc,
		...(v.floor ? [v.floor] : []),
		...Object.values(v.vv ?? {}),
	]);

/** A payload as a sorted list of version keys, for order-free comparison. */
function canon(p: EntriesPayload): string {
	const keys = (tag: string, vs: readonly ({ id: string } & Versioned)[] | undefined) =>
		(vs ?? []).map((v) => `${tag}:${v.id}|${causalKey(v)}`);
	return [...keys("e", p.entries), ...keys("c", p.conflicts), ...keys("t", p.tombstones)]
		.sort()
		.join("\n");
}

class Sim {
	readonly rand: () => number;
	readonly devices: Device[];
	readonly versions = new Map<string, Version>();
	private time = 1000;
	private labels = 0;
	private ids = 0;

	constructor(seed: number, olderCount = 0) {
		this.rand = mulberry32(seed);
		this.devices = ["laptop", "phone", "tablet"].map((name, i) => {
			const skew = Math.floor(this.rand() * 3);
			return {
				name,
				clock: new HybridClock(name, () => this.time + skew),
				payload: empty(),
				older: i >= 3 - olderCount,
				deletes: new Map(),
			};
		});
	}

	private pick<T>(xs: readonly T[]): T {
		return xs[Math.floor(this.rand() * xs.length)]!;
	}

	private label(): string {
		this.labels += 1;
		return `v${this.labels}`;
	}

	private envelope(id: string, label: string, hlc: Hlc, causal: object): EncryptedEntry {
		return { id, wrappedDek: "w", dekIv: "d", ciphertext: label, iv: "i", hlc, ...causal };
	}

	/** The true ancestors a write superseding these versions inherits. */
	private inherit(
		d: Device,
		id: string,
		live: readonly EncryptedEntry[],
		withTomb: boolean,
	): Set<string> {
		const out = new Set<string>();
		const add = (label: string) => {
			out.add(label);
			for (const a of this.versions.get(label)?.ancestors ?? []) out.add(a);
		};
		for (const e of live) add(e.ciphertext);
		if (withTomb) for (const del of d.deletes.get(id) ?? []) add(del);
		return out;
	}

	private apply(d: Device, write: EntriesPayload): void {
		d.payload = d.older ? olderBuildMerge(d.payload, write) : mergeEntriesPayload(d.payload, write);
	}

	add(d: Device): void {
		this.ids += 1;
		const id = `e${this.ids}`;
		const hlc = d.clock.send();
		const label = this.label();
		const causal = d.older ? {} : nextCausal({ hlc, bases: [], held: [] });
		const env = this.envelope(id, label, hlc, causal);
		this.versions.set(label, { label, id, v: env, ancestors: new Set() });
		this.apply(d, { entries: [env], tombstones: [] });
	}

	edit(d: Device, id: string): void {
		const shown = d.payload.entries.find((e) => e.id === id)!;
		const label = this.label();
		const version = d.older
			? { hlc: d.clock.send(), causal: {} }
			: nextVersion({ hlc: d.clock.send(), bases: [shown], held: heldVersions(d.payload, id) });
		const env = this.envelope(id, label, version.hlc, version.causal);
		this.versions.set(label, { label, id, v: env, ancestors: this.inherit(d, id, [shown], false) });
		this.apply(d, { entries: [env], tombstones: [] });
	}

	/** Every live version and the tombstone of an id, as the bases of a delete or a resolution. */
	private all(d: Device, id: string) {
		const live = [...d.payload.entries, ...(d.payload.conflicts ?? [])].filter((e) => e.id === id);
		const tomb = d.payload.tombstones.find((t) => t.id === id);
		return { live, bases: [...live, ...(tomb ? [tomb] : [])] };
	}

	remove(d: Device, id: string): void {
		const { live, bases } = this.all(d, id);
		const hlc = d.clock.send();
		const label = this.label();
		const causal = d.older ? {} : nextCausal({ hlc, bases, held: heldVersions(d.payload, id) });
		const t: Tombstone = { id, hlc, ...causal };
		this.versions.set(label, { label, id, v: t, ancestors: this.inherit(d, id, live, true) });
		const seen = d.deletes.get(id) ?? new Set<string>();
		seen.add(label);
		d.deletes.set(id, seen);
		this.apply(d, { entries: [], tombstones: [t] });
	}

	resolve(d: Device, id: string): void {
		const { live, bases } = this.all(d, id);
		const hlc = d.clock.send();
		const label = this.label();
		const causal = nextCausal({ hlc, bases, held: heldVersions(d.payload, id) });
		const env = this.envelope(id, label, hlc, causal);
		this.versions.set(label, { label, id, v: env, ancestors: this.inherit(d, id, live, true) });
		this.apply(d, { entries: [env], tombstones: [] });
	}

	/** `to` takes in everything `from` holds. Returns whether `to` changed. */
	sync(from: Device, to: Device): boolean {
		const before = to.payload;
		for (const s of stampsOf(from.payload)) to.clock.witness(s);
		this.apply(to, from.payload);
		for (const [id, labels] of from.deletes) {
			const seen = to.deletes.get(id) ?? new Set<string>();
			for (const l of labels) seen.add(l);
			to.deletes.set(id, seen);
		}
		return !payloadsEquivalent(before, to.payload);
	}

	step(): void {
		this.time += 1 + Math.floor(this.rand() * 3);
		const d = this.pick(this.devices);
		const visible = d.payload.entries.map((e) => e.id);
		const conflicted = d.older ? [] : [...entryConflicts(d.payload).keys()];
		const r = this.rand();
		if (r < 0.15 || visible.length === 0) this.add(d);
		else if (r < 0.5) this.edit(d, this.pick(visible));
		else if (r < 0.6) this.remove(d, this.pick(visible));
		else if (r < 0.7 && conflicted.length > 0) this.resolve(d, this.pick(conflicted));
		else {
			const other = this.pick(this.devices.filter((x) => x !== d));
			this.sync(other, d);
		}
	}

	/** Pairwise gossip until a full round changes nothing. Returns the rounds it took. */
	gossip(maxRounds: number): number {
		for (let round = 1; round <= maxRounds; round++) {
			let changed = false;
			for (const to of this.devices) {
				for (const from of this.devices) if (from !== to && this.sync(from, to)) changed = true;
			}
			if (!changed) return round;
		}
		return Number.POSITIVE_INFINITY;
	}
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const STEPS = 40;

function run(seed: number, olderCount = 0): Sim {
	const sim = new Sim(seed, olderCount);
	for (let i = 0; i < STEPS; i++) sim.step();
	return sim;
}

describe("sibling merge properties", () => {
	it("isAncestor matches the true ancestry", () => {
		for (const seed of SEEDS) {
			const sim = run(seed);
			const all = [...sim.versions.values()];
			for (const x of all) {
				for (const y of all) {
					if (x === y || x.id !== y.id) continue;
					const truth = y.ancestors.has(x.label);
					if (isAncestor(x.v, y.v) !== truth) {
						throw new Error(`seed ${seed}: isAncestor(${x.label}, ${y.label}) should be ${truth}`);
					}
				}
			}
		}
	});

	it("converges in every merge order", () => {
		for (const seed of SEEDS) {
			const [a, b, c] = run(seed).devices.map((d) => d.payload) as [
				EntriesPayload,
				EntriesPayload,
				EntriesPayload,
			];
			const m = mergeEntriesPayload;
			const left = canon(m(m(a, b), c));
			expect(canon(m(a, m(b, c))), `seed ${seed} right fold`).toBe(left);
			expect(canon(m(m(c, a), b)), `seed ${seed} shuffled`).toBe(left);
			for (const [x, y] of [
				[a, b],
				[b, c],
				[a, c],
			] as const) {
				expect(canon(m(x, y)), `seed ${seed} commutative`).toBe(canon(m(y, x)));
				expect(canon(m(x, x)), `seed ${seed} idempotent`).toBe(canon(x));
			}
		}
	});

	it("nothing is lost unless something saw it", () => {
		for (const seed of SEEDS) {
			const sim = run(seed);
			const [a, b, c] = sim.devices.map((d) => d.payload) as [
				EntriesPayload,
				EntriesPayload,
				EntriesPayload,
			];
			const final = mergeEntriesPayload(mergeEntriesPayload(a, b), c);
			const kept = [...final.entries, ...(final.conflicts ?? [])].map((e) => e.ciphertext);
			const all = [...sim.versions.values()];
			const deletes = all.filter((x) => !("ciphertext" in x.v));
			for (const x of all) {
				if (!("ciphertext" in x.v)) continue;
				const seen =
					kept.includes(x.label) ||
					kept.some((k) => sim.versions.get(k)!.ancestors.has(x.label)) ||
					deletes.some((d) => d.id === x.id && d.ancestors.has(x.label));
				if (!seen) throw new Error(`seed ${seed}: ${x.label} was lost`);
			}
		}
	});

	// With an older build in the group, a stale copy it relays before the original arrives can still
	// prune versions (docs/sync-conflicts.md, "Older builds"), but never below today's LWW: the
	// version LWW would keep survives, and an entry every delete saw stays deleted.
	it("a mixed group never does worse than LWW", () => {
		for (const seed of SEEDS) {
			const sim = run(seed, 1);
			sim.gossip(20);
			const final = sim.devices[0]!.payload;
			const kept = new Set([...final.entries, ...(final.conflicts ?? [])].map((e) => e.ciphertext));
			const byId = new Map<string, Version[]>();
			for (const v of sim.versions.values()) byId.set(v.id, [...(byId.get(v.id) ?? []), v]);
			for (const [id, versions] of byId) {
				const live = versions.filter((v) => "ciphertext" in v.v);
				const deletes = versions.filter((v) => !("ciphertext" in v.v));
				const newest = live.reduce((a, b) => (compareHlc(a.v.hlc, b.v.hlc) >= 0 ? a : b));
				const lastDelete = deletes.reduce<Version | undefined>(
					(a, b) => (!a || compareHlc(b.v.hlc, a.v.hlc) > 0 ? b : a),
					undefined,
				);
				if (!lastDelete || compareHlc(newest.v.hlc, lastDelete.v.hlc) > 0) {
					expect(kept.has(newest.label), `seed ${seed}: LWW keeps ${newest.label}`).toBe(true);
				}
				const allSeen = live.every((v) => deletes.some((d) => d.ancestors.has(v.label)));
				if (allSeen) {
					expect(
						final.entries.some((e) => e.id === id),
						`seed ${seed}: ${id} came back after deletes saw every version`,
					).toBe(false);
				}
			}
		}
	});

	it("a mixed group converges", () => {
		for (const seed of SEEDS) {
			const sim = run(seed, 1);
			expect(sim.gossip(20), `seed ${seed} gossip rounds`).toBeLessThanOrEqual(20);
			const [laptop, phone, older] = sim.devices as [Device, Device, Device];
			expect(canon(phone.payload), `seed ${seed} newer devices agree`).toBe(canon(laptop.payload));
			const deleted = new Set(
				[...entryConflicts(laptop.payload)].filter(([, c]) => c.deleted).map(([id]) => id),
			);
			const shown = (p: EntriesPayload) =>
				Object.fromEntries(
					p.entries.filter((e) => !deleted.has(e.id)).map((e) => [e.id, causalKey({ hlc: e.hlc })]),
				);
			expect(shown(older.payload), `seed ${seed} older build agrees`).toEqual(
				shown(laptop.payload),
			);
		}
	});
});
