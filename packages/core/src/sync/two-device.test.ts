// Two devices end to end: real EntryMutations on each, syncing through applyRemotePayload over
// createVaultSyncPort, the path every platform's sync takes. See docs/sync-conflicts.md, Phase A.

import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { conflictsOf, type VaultEntries, vaultEntriesFromPayload } from "../vault/entry-mutations";
import { harness } from "../vault/entry-mutations.harness";
import { applyRemotePayload, createVaultSyncPort } from "./apply-remote";
import type { EntriesPayload } from "./entries-payload";
import { olderBuildMerge } from "./older-build.harness";

type Device = ReturnType<typeof harness>;

const login = (name: string, password = "pw"): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password,
});

/** What the device would load after a write: the decrypted entries plus their sync state. */
async function load(d: Device): Promise<VaultEntries> {
	const payload = await d.mutations.readEntriesPayload();
	const decrypted = payload.entries.map(
		(e) => ({ id: e.id, ...JSON.parse(e.ciphertext.slice(3)) }) as Entry,
	);
	return vaultEntriesFromPayload(payload, decrypted);
}

/** `to` takes in what `from` holds, as a peer broadcast would deliver it. */
async function sync(from: Device, to: Device, combine = false): Promise<boolean> {
	const port = createVaultSyncPort({
		store: to.mutations,
		crypto: to.crypto,
		witnessRemote: async (stamps) => {
			for (const s of stamps) to.clock.witness(s);
		},
	});
	const { changed } = await applyRemotePayload(port, await from.mutations.readEntriesPayload(), {
		combine,
	});
	return changed;
}

async function both(a: Device, b: Device, combine = false): Promise<void> {
	await sync(a, b, combine);
	await sync(b, a, combine);
}

/** A laptop and a phone sharing one login, in sync. The clock is shared and settable. */
async function pair() {
	const time = { now: 1000 };
	const laptop = harness(() => time.now, "laptop");
	const phone = harness(() => time.now, "phone");
	const seeded = await laptop.mutations.add(await load(laptop), login("GitHub"));
	const id = seeded.entries[0]!.id;
	await sync(laptop, phone);
	return { time, laptop, phone, id };
}

const shown = (s: VaultEntries, id: string) => s.entries.find((e) => e.id === id);

describe("two devices", () => {
	it("both devices edit one login, sync, and both show the same conflict", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			const s = await load(d);
			expect(conflictsOf(s).get(id)).toEqual({ versions: 1, deleted: false });
			expect(shown(s, id)).toMatchObject({ password: "phone-pw" });
		}
	});

	it("resolving on one device clears it on the other after a sync", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		await both(laptop, phone);

		time.now = 4000;
		await laptop.mutations.resolve(await load(laptop), id, {
			kind: "use",
			data: login("GitHub", "laptop-pw"),
			superseded: [login("GitHub", "phone-pw")],
		});
		await sync(laptop, phone);

		const s = await load(phone);
		expect(conflictsOf(s).size).toBe(0);
		expect(shown(s, id)).toMatchObject({ password: "laptop-pw" });
	});

	it("phone deletes while laptop edits: the entry stays, flagged deleted, on both", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.remove(await load(phone), id);
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			const s = await load(d);
			expect(shown(s, id)).toMatchObject({ password: "laptop-pw" });
			expect(conflictsOf(s).get(id)).toEqual({ versions: 0, deleted: true });
		}
	});

	it("laptop edits around its own unresolved conflict and the sibling survives", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		await both(laptop, phone);

		// The laptop's own edit lost the display; it edits the phone's version without resolving.
		time.now = 4000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub Work", "phone-pw"));
		await both(laptop, phone);

		for (const d of [laptop, phone]) {
			const s = await load(d);
			expect(shown(s, id)).toMatchObject({ name: "GitHub Work" });
			expect(conflictsOf(s).get(id)).toEqual({ versions: 1, deleted: false });
			const [sibling] = s.conflicts;
			expect(sibling!.ciphertext).toContain("laptop-pw");
		}
	});

	it("an older build in the group degrades to LWW and never crashes", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		await both(laptop, phone);

		// An older build merges last-writer-wins over what it can parse, then edits that.
		let older: EntriesPayload = olderBuildMerge(
			{ entries: [], tombstones: [] },
			await phone.mutations.readEntriesPayload(),
		);
		const [current] = older.entries;
		const edited = {
			...current!,
			ciphertext: `ct:${JSON.stringify(login("GitHub", "older-pw"))}`,
			hlc: { wall: 5000, counter: 0, node: "older" },
		};
		older = olderBuildMerge(older, { entries: [edited], tombstones: [] });
		expect(older.conflicts).toBeUndefined();

		const port = (to: Device) =>
			createVaultSyncPort({
				store: to.mutations,
				crypto: to.crypto,
				witnessRemote: async () => {},
			});
		await applyRemotePayload(port(laptop), older);
		await applyRemotePayload(port(phone), older);

		for (const d of [laptop, phone]) {
			const s = await load(d);
			// Its write claims everything stamped before it, the way LWW always has.
			expect(shown(s, id)).toMatchObject({ password: "older-pw" });
			expect(conflictsOf(s).size).toBe(0);
		}
	});

	// Phase B (docs/sync-conflicts.md): with combining on, edits to different parts merge.
	it("password on the phone, notes on the laptop: both end with one entry holding both", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		time.now = 3000;
		await laptop.mutations.update(await load(laptop), id, {
			...login("GitHub"),
			notes: "laptop note",
		} as EntryData);
		await both(laptop, phone, true);
		for (const d of [laptop, phone]) {
			const s = await load(d);
			expect(conflictsOf(s).size).toBe(0);
			expect(shown(s, id)).toMatchObject({ password: "phone-pw", notes: "laptop note" });
		}
	});

	it("both devices combine the same siblings into the same version, then stop", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		time.now = 3000;
		await laptop.mutations.update(await load(laptop), id, {
			...login("GitHub"),
			notes: "n",
		} as EntryData);
		await both(laptop, phone, true);
		await both(laptop, phone, true);
		expect(await sync(laptop, phone, true)).toBe(false);
		expect(await sync(phone, laptop, true)).toBe(false);
		const [l, p] = [await load(laptop), await load(phone)];
		expect(l.stamps.get(id)?.node.startsWith("~merge:")).toBe(true);
		expect(l.stamps.get(id)).toEqual(p.stamps.get(id));
		expect(conflictsOf(l).size + conflictsOf(p).size).toBe(0);
	});

	it("with combining off, siblings stay siblings", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "phone-pw"));
		time.now = 3000;
		await laptop.mutations.update(await load(laptop), id, {
			...login("GitHub"),
			notes: "n",
		} as EntryData);
		await both(laptop, phone);
		expect(conflictsOf(await load(laptop)).get(id)).toEqual({ versions: 1, deleted: false });
	});

	it("a delete conflict is left for the user", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await laptop.mutations.update(await load(laptop), id, login("GitHub", "laptop-pw"));
		time.now = 3000;
		await phone.mutations.remove(await load(phone), id);
		await both(laptop, phone, true);
		expect(conflictsOf(await load(laptop)).get(id)).toEqual({ versions: 0, deleted: true });
	});
});

// Another writer on the same device (the extension background) doesn't wait for a merge; what it
// saves while one is in flight has to survive the merge's write.
describe("a merge and another writer on the same device", () => {
	it("a local write that lands during a merge is kept", async () => {
		const { time, laptop, phone, id } = await pair();
		time.now = 2000;
		await phone.mutations.update(await load(phone), id, login("GitHub", "new"));
		let wrote = false;
		const port = createVaultSyncPort({
			store: laptop.mutations,
			crypto: laptop.crypto,
			witnessRemote: async (stamps) => {
				for (const s of stamps) laptop.clock.witness(s);
				if (!wrote) {
					wrote = true;
					await laptop.mutations.add(await load(laptop), login("Bank"));
				}
			},
		});
		await applyRemotePayload(port, await phone.mutations.readEntriesPayload());
		const after = await load(laptop);
		expect(after.entries.map((e) => e.name).sort()).toEqual(["Bank", "GitHub"]);
		expect(after.entries.find((e) => e.id === id)).toMatchObject({ password: "new" });
	});
});
