import { collectBlobs, syncWants, uploadWanted } from "@core/sync/mailbox/files";
import { sha256Hex } from "@core/sync/mailbox/protocol";
import { postChanges } from "@core/sync/mailbox/send";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLogin, attachFile, type TestDevice, testGroup } from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

/** A creates the mailbox listing everyone; the named others activate. */
async function group(names: string[], active: string[]): Promise<TestDevice[]> {
	const devices = await testGroup(box, names);
	const [first] = devices as [TestDevice];
	await first.ctx.api.create({ members: devices.map((d) => d.sigKey) });
	for (const d of devices) if (active.includes(d.name)) await d.ctx.api.activate(true);
	return devices;
}

/** a and b in the roster and active; `planted`, listed by b, active, and in no roster. */
async function withPlanted(): Promise<[TestDevice, TestDevice, TestDevice]> {
	const [a, b, planted] = (await testGroup(box, ["a", "b", "planted"])) as [
		TestDevice,
		TestDevice,
		TestDevice,
	];
	for (const d of [a, b]) {
		d.roster.current.devices = d.roster.current.devices.filter((e) => e.id !== "planted");
	}
	await a.ctx.api.create({ members: [a.sigKey, b.sigKey] });
	await b.ctx.api.activate(true);
	await b.ctx.api.changeMembers({ add: [planted.sigKey], remove: [] });
	await planted.ctx.api.activate(true);
	return [a, b, planted];
}

const fetchable = async (d: TestDevice, hash: string) =>
	d.ctx.blobs.mover.download(hash, await d.ctx.api.blobRequest("GET", hash));

/** `to` merges `from`'s whole vault directly, without the mailbox. */
async function mergeDirect(from: TestDevice, to: TestDevice) {
	await to.ctx.vault.apply({
		entries: await from.vault.mutations.readEntriesPayload(),
		roster: from.roster.current,
	});
}

describe("file blobs through the mailbox", () => {
	it("lists the blobs its manifest names but its store lacks", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([1, 2, 3]));
		await mergeDirect(a, b);
		await syncWants(b.ctx, b.state, await b.vault.mutations.readEntriesPayload());
		expect(b.state.wants).toEqual([hash]);
		expect((await a.ctx.api.inbox()).wanted).toEqual([{ hash, by: [b.sigKey] }]);
	});

	it("uploads what another member wants and holds", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([4, 5]));
		const by = [b.sigKey];
		await uploadWanted(
			a.ctx,
			[
				{ hash, by },
				{ hash: "f".repeat(64), by },
			],
			a.roster.current,
		);
		expect((await b.ctx.api.inbox()).blobs.map((x) => x.hash)).toEqual([hash]);
	});

	it("a member that joins later gets a held attachment through its want", async () => {
		const [a, b, c] = (await group(["a", "b", "c"], ["b"])) as [TestDevice, TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([6, 7, 8]));
		await uploadWanted(a.ctx, [{ hash, by: [b.sigKey] }], a.roster.current);
		await c.ctx.api.activate(true);
		await mergeDirect(a, c);
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		expect(c.state.wants).toEqual([hash]);
		await uploadWanted(a.ctx, (await a.ctx.api.inbox()).wanted, a.roster.current);
		await collectBlobs(c.ctx, (await c.ctx.api.inbox()).blobs);
		expect(await c.blobs.has(hash)).toBe(true);
	});

	it("a key the roster doesn't hold is sent no attachment", async () => {
		const [a, b, planted] = await withPlanted();
		await postChanges(a.ctx, a.state, await a.ctx.vault.readLocal());
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([1, 2]));
		await postChanges(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect((await b.ctx.api.inbox()).blobs.map((x) => x.hash)).toEqual([hash]);
		expect((await planted.ctx.api.inbox()).blobs).toEqual([]);
		expect(await fetchable(planted, hash)).toBe("missing");
	});

	it("a want from a key the roster doesn't hold is not served", async () => {
		const [a, , planted] = await withPlanted();
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([3, 4]));
		await planted.ctx.api.wants([hash]);
		const { wanted } = await a.ctx.api.inbox();
		expect(wanted).toEqual([{ hash, by: [planted.sigKey] }]);
		await uploadWanted(a.ctx, wanted, a.roster.current);
		expect((await planted.ctx.api.inbox()).blobs).toEqual([]);
		expect(await fetchable(planted, hash)).toBe("missing");
	});

	it("fetches new wants directly a few at a time until every one was tried", async () => {
		const devices = await testGroup(box, ["a", "b", "c"], { limits: { directGets: 1 } });
		const [a, b, c] = devices as [TestDevice, TestDevice, TestDevice];
		await a.ctx.api.create({ members: devices.map((d) => d.sigKey) });
		await b.ctx.api.activate(true);
		await c.ctx.api.activate(true);
		const entry = await addLogin(a, "Passport");
		const one = await attachFile(a, entry, new Uint8Array([21]));
		const two = await attachFile(a, entry, new Uint8Array([22]));
		const by = [b.sigKey, c.sigKey];
		await uploadWanted(
			a.ctx,
			[
				{ hash: one, by },
				{ hash: two, by },
			],
			a.roster.current,
		);
		await mergeDirect(a, c);
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		expect(await c.blobs.has(one)).toBe(true);
		expect(await c.blobs.has(two)).toBe(true);
	});

	it("collects a delivered blob, and acknowledges one it holds without downloading", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const entry = await addLogin(a, "Passport");
		const fresh = await attachFile(a, entry, new Uint8Array([9]));
		const held = await attachFile(a, entry, new Uint8Array([10]));
		await b.blobs.put(held, new Uint8Array([10]));
		const by = [b.sigKey];
		await uploadWanted(
			a.ctx,
			[
				{ hash: fresh, by },
				{ hash: held, by },
			],
			a.roster.current,
		);

		const downloads: string[] = [];
		const mover = b.ctx.blobs.mover;
		b.ctx.blobs.mover = {
			upload: mover.upload,
			download: (hash, req) => {
				downloads.push(hash);
				return mover.download(hash, req);
			},
		};
		const acked = await collectBlobs(b.ctx, (await b.ctx.api.inbox()).blobs);
		expect(acked.sort()).toEqual([fresh, held].sort());
		expect(downloads).toEqual([fresh]);
		expect(await b.blobs.read(fresh)).toEqual(new Uint8Array([9]));
		expect(await sha256Hex(await b.blobs.read(held))).toBe(held);
	});
});
