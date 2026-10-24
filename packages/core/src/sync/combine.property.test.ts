// Random multi-device histories with combining on. A simulator plays three devices that edit one
// part at a time, delete, resolve and partially sync (merge, then combine), records the TRUE
// ancestry of every write, and checks what combining builds against it. See docs/sync-conflicts.md,
// Phase B. Every value a write sets carries its label, so a value names the write that set it.

import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { partsEqual, partsOf, withPartStamps } from "../vault/parts";
import { tagKey } from "../vault/tags";
import type { EncryptedEntry } from "../vault-format";
import { applyRemotePayload } from "./apply-remote";
import { causalKey, nextCausal, nextVersion, type Versioned } from "./causal";
import { type CombineCrypto, combinePayload } from "./combine";
import type { EntriesPayload, Tombstone } from "./entries-payload";
import { HybridClock } from "./hlc";
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

/** Ciphertext is the plaintext, so the simulator can read what combining sealed. */
const crypto: CombineCrypto = {
	decryptEntries: async (ps) =>
		ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null)),
	encryptEntry: async (json) => ({
		ciphertext: `ct:${json}`,
		iv: "i",
		wrappedDek: "w",
		dekIv: "d",
	}),
};

const PARTS = ["name", "notes", "credential"] as const;

interface Device {
	name: string;
	clock: HybridClock;
	payload: EntriesPayload;
	/** Delete labels this device has seen, per entry id. */
	deletes: Map<string, Set<string>>;
}

/** A write the simulator made: an add, an edit or a resolution, never a combine. */
interface Write {
	label: string;
	id: string;
	data: EntryData;
	/** The parts this write set: all of them for an add or a resolution, the edited one otherwise. */
	sets: ReadonlySet<string>;
	/** Every write this one supersedes, directly or not. */
	ancestors: ReadonlySet<string>;
}

const empty = (): EntriesPayload => ({ entries: [], tombstones: [] });
const keyOf = (id: string, v: Versioned) => `${id}|${causalKey(v)}`;
const live = (p: EntriesPayload) => [...p.entries, ...(p.conflicts ?? [])];
const open = (e: EncryptedEntry) => JSON.parse(e.ciphertext.slice(3)) as EntryData;

function canon(p: EntriesPayload): string {
	const keys = (tag: string, vs: readonly ({ id: string } & Versioned)[] | undefined) =>
		(vs ?? []).map((v) => `${tag}:${keyOf(v.id, v)}`);
	return [...keys("e", p.entries), ...keys("c", p.conflicts), ...keys("t", p.tombstones)]
		.sort()
		.join("\n");
}

class Sim {
	readonly rand: () => number;
	readonly devices: Device[];
	readonly writes: Write[] = [];
	/** Combined versions sealed, across every device. */
	combined = 0;
	/** Each version's true history (its own write included), by id and causal key. */
	private readonly truth = new Map<string, Set<string>>();
	/** Each delete's true history, by label. */
	private readonly deleteTruth = new Map<string, Set<string>>();
	private time = 1000;
	private labels = 0;

	constructor(seed: number) {
		this.rand = mulberry32(seed);
		this.devices = ["laptop", "phone", "tablet"].map((name) => {
			const skew = Math.floor(this.rand() * 3);
			return {
				name,
				clock: new HybridClock(name, () => this.time + skew),
				payload: empty(),
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

	/** The true history a write superseding these versions (and maybe the deletes) inherits. */
	private inherit(
		d: Device,
		id: string,
		versions: readonly EncryptedEntry[],
		withDeletes: boolean,
	) {
		const out = new Set<string>();
		for (const v of versions) for (const l of this.truth.get(keyOf(id, v)) ?? []) out.add(l);
		if (withDeletes) {
			for (const del of d.deletes.get(id) ?? []) {
				for (const l of this.deleteTruth.get(del) ?? []) out.add(l);
			}
		}
		return out;
	}

	private write(
		d: Device,
		w: Write,
		version: { hlc: EncryptedEntry["hlc"]; causal: object },
		prev?: { data: EntryData; version: EncryptedEntry },
		superseded: readonly EntryData[] = [],
	): void {
		const { id: _id, ...data } = withPartStamps(
			{ id: w.id, ...w.data } as Entry,
			prev,
			version.hlc,
			superseded,
		);
		const env: EncryptedEntry = {
			id: w.id,
			wrappedDek: "w",
			dekIv: "d",
			ciphertext: `ct:${JSON.stringify(data)}`,
			iv: "i",
			hlc: version.hlc,
			...version.causal,
		};
		this.writes.push({ ...w, data: data as EntryData });
		this.truth.set(keyOf(w.id, env), new Set([w.label, ...w.ancestors]));
		d.payload = mergeEntriesPayload(d.payload, { entries: [env], tombstones: [] });
	}

	add(d: Device, id: string): void {
		const label = this.label();
		const hlc = d.clock.send();
		const data = {
			type: "login",
			name: `name@${label}`,
			urls: [],
			username: `u@${label}`,
			password: `pw@${label}`,
			notes: `notes@${label}`,
		} as EntryData;
		const causal = nextCausal({ hlc, bases: [], held: [] });
		this.write(d, { label, id, data, sets: new Set(PARTS), ancestors: new Set() }, { hlc, causal });
	}

	edit(d: Device, id: string): void {
		const shown = d.payload.entries.find((e) => e.id === id)!;
		const prev = open(shown);
		const next = { ...prev } as Record<string, unknown>;
		const label = this.label();
		const r = Math.floor(this.rand() * 7);
		const tags = (prev.tags ?? []) as string[];
		if (r === 0) {
			next.password = `pw@${label}`;
			if (this.rand() < 0.5) next.username = `u@${label}`;
		} else if (r === 1) next.notes = `notes@${label}`;
		else if (r === 2) next.name = `name@${label}`;
		else if (r === 3) delete next.notes;
		else if (r === 4) {
			const tag = `t${Math.floor(this.rand() * 4)}`;
			if (!tags.some((t) => tagKey(t) === tagKey(tag))) next.tags = [...tags, tag];
		} else if (r === 5 && tags.length > 0) {
			const gone = this.pick(tags);
			next.tags = tags.filter((t) => t !== gone);
			if ((next.tags as string[]).length === 0) delete next.tags;
		} else {
			const url = `https://s${Math.floor(this.rand() * 4)}.example`;
			const urls = (next.urls ?? []) as string[];
			if (!urls.includes(url)) next.urls = [...urls, url];
		}
		const before = partsOf(prev);
		const after = partsOf(next as unknown as EntryData);
		const sets = new Set(PARTS.filter((p) => !partsEqual(before.get(p), after.get(p))));
		const version = nextVersion({
			hlc: d.clock.send(),
			bases: [shown],
			held: heldVersions(d.payload, id),
		});
		this.write(
			d,
			{
				label,
				id,
				data: next as unknown as EntryData,
				sets,
				ancestors: this.inherit(d, id, [shown], false),
			},
			version,
			{ data: prev, version: shown },
		);
	}

	remove(d: Device, id: string): void {
		const versions = live(d.payload).filter((e) => e.id === id);
		const tomb = d.payload.tombstones.find((t) => t.id === id);
		const hlc = d.clock.send();
		const label = this.label();
		const causal = nextCausal({
			hlc,
			bases: [...versions, ...(tomb ? [tomb] : [])],
			held: heldVersions(d.payload, id),
		});
		const t: Tombstone = { id, hlc, ...causal };
		this.deleteTruth.set(label, new Set([label, ...this.inherit(d, id, versions, true)]));
		const seen = d.deletes.get(id) ?? new Set<string>();
		seen.add(label);
		d.deletes.set(id, seen);
		d.payload = mergeEntriesPayload(d.payload, { entries: [], tombstones: [t] });
	}

	/** Keep the shown version over its siblings, the way EntryMutations.resolve does. */
	resolve(d: Device, id: string): void {
		const shown = d.payload.entries.find((e) => e.id === id);
		if (!shown) return;
		const versions = live(d.payload).filter((e) => e.id === id);
		const tomb = d.payload.tombstones.find((t) => t.id === id);
		const hlc = d.clock.send();
		const causal = nextCausal({
			hlc,
			bases: [...versions, ...(tomb ? [tomb] : [])],
			held: heldVersions(d.payload, id),
		});
		const data = open(shown);
		this.write(
			d,
			{
				label: this.label(),
				id,
				data,
				sets: new Set(PARTS),
				ancestors: this.inherit(d, id, versions, true),
			},
			{ hlc, causal },
			{ data, version: shown },
			versions.filter((e) => e !== shown).map(open),
		);
	}

	/** Combine, and give each combined version the true history of everything it replaced. */
	private async combine(p: EntriesPayload, ids: ReadonlySet<string>) {
		const out = await combinePayload(p, crypto, ids);
		this.combined += out.stamps.length;
		for (const id of ids) {
			const keys = (q: EntriesPayload) =>
				new Set(
					live(q)
						.filter((e) => e.id === id)
						.map((e) => keyOf(id, e)),
				);
			const before = keys(p);
			const after = keys(out.payload);
			const gone = [...before].filter((k) => !after.has(k));
			for (const k of after) {
				if (before.has(k)) continue;
				const history = this.truth.get(k) ?? new Set<string>();
				for (const g of gone) for (const l of this.truth.get(g) ?? []) history.add(l);
				this.truth.set(k, history);
			}
		}
		return out;
	}

	/** `to` takes in everything `from` holds, merging then combining. Returns whether it changed. */
	async sync(from: Device, to: Device): Promise<boolean> {
		const { changed } = await applyRemotePayload(
			{
				readLocal: async () => to.payload,
				witnessRemote: async (stamps) => {
					for (const s of stamps) to.clock.witness(s);
				},
				writeMerged: async (m) => {
					to.payload = m;
				},
				openable: async (es) => es.map(() => true),
				combineSiblings: (p, ids) => this.combine(p, ids),
			},
			from.payload,
			{ combine: true },
		);
		for (const [id, labels] of from.deletes) {
			const seen = to.deletes.get(id) ?? new Set<string>();
			for (const l of labels) seen.add(l);
			to.deletes.set(id, seen);
		}
		return changed;
	}

	async step(): Promise<void> {
		this.time += 1 + Math.floor(this.rand() * 3);
		const d = this.pick(this.devices);
		const visible = d.payload.entries.map((e) => e.id);
		const conflicted = [...entryConflicts(d.payload).keys()];
		const r = this.rand();
		if (r < 0.5 && visible.length > 0) this.edit(d, this.pick(visible));
		else if (r < 0.55 && visible.length > 0) this.remove(d, this.pick(visible));
		else if (r < 0.65 && conflicted.length > 0) this.resolve(d, this.pick(conflicted));
		else await this.sync(this.pick(this.devices.filter((x) => x !== d)), d);
	}

	/** Pairwise gossip until a full round changes nothing. Returns the rounds it took. */
	async gossip(maxRounds: number): Promise<number> {
		for (let round = 1; round <= maxRounds; round++) {
			let changed = false;
			for (const to of this.devices) {
				for (const from of this.devices) {
					if (from !== to && (await this.sync(from, to))) changed = true;
				}
			}
			if (!changed) return round;
		}
		return Number.POSITIVE_INFINITY;
	}
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const STEPS = 40;

/** Two entries every device starts with, then random steps. */
async function run(seed: number): Promise<Sim> {
	const sim = new Sim(seed);
	const [first] = sim.devices as [Device];
	sim.add(first, "e1");
	sim.add(first, "e2");
	for (const d of sim.devices) if (d !== first) await sim.sync(first, d);
	for (let i = 0; i < STEPS; i++) await sim.step();
	return sim;
}

const credentialOf = (data: EntryData) => JSON.stringify(partsOf(data).get("credential") ?? null);

describe("combine properties", () => {
	it("combining converges", async () => {
		for (const seed of SEEDS) {
			const sim = await run(seed);
			expect(await sim.gossip(20), `seed ${seed} gossip rounds`).toBeLessThanOrEqual(20);
			const [a, ...rest] = sim.devices.map((d) => canon(d.payload));
			for (const other of rest) expect(other, `seed ${seed} devices agree`).toBe(a);
		}
	});

	it("no entry nobody wrote", async () => {
		for (const seed of SEEDS) {
			const sim = await run(seed);
			const check = () => {
				const written = new Set(sim.writes.map((w) => `${w.id}|${credentialOf(w.data)}`));
				for (const d of sim.devices) {
					for (const e of live(d.payload)) {
						const tuple = `${e.id}|${credentialOf(open(e))}`;
						if (!written.has(tuple)) {
							throw new Error(`seed ${seed}: ${d.name} holds a credential no write made: ${tuple}`);
						}
					}
				}
			};
			check();
			await sim.gossip(20);
			check();
		}
	});

	it("each part ends at a write nothing else superseded", async () => {
		let combined = 0;
		for (const seed of SEEDS) {
			const sim = await run(seed);
			await sim.gossip(20);
			const payload = sim.devices[0]!.payload;
			const conflicted = entryConflicts(payload);
			for (const e of payload.entries) {
				if (conflicted.has(e.id)) continue;
				const parts = partsOf(open(e));
				for (const part of PARTS) {
					const setters = sim.writes.filter((w) => w.id === e.id && w.sets.has(part));
					const candidates = setters.filter((w) =>
						partsEqual(partsOf(w.data).get(part), parts.get(part)),
					);
					const current = candidates.some(
						(c) => !setters.some((w) => w !== c && w.ancestors.has(c.label)),
					);
					if (!current) {
						throw new Error(
							`seed ${seed}: ${e.id}.${part} = ${JSON.stringify(parts.get(part))} is not from a current write`,
						);
					}
				}
			}
			combined += sim.combined;
		}
		// The properties only mean something if combining happened along the way.
		expect(combined).toBeGreaterThan(SEEDS.length);
	});
});
