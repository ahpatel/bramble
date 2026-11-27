import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ack,
	activate,
	createMailbox,
	inbox,
	newMessageId,
	postMessage,
	setup,
	uploadBlob,
} from "../test/harness.ts";
import { expiryMarkers, mailboxes, members, messages } from "./schema.ts";
import { chunk } from "./sql.ts";
import { sweep } from "./sweep.ts";
import { DAY_MS, dayOf } from "./time.ts";

const HOUR_MS = 3_600_000;
const NOTHING = { messages: 0, blobs: 0, markers: 0, mailboxes: 0, orphans: 0, more: false };

/** A and B active in a mailbox whose retention is 7 days (the ceiling stays 365). */
async function pair() {
	const { server, devices } = await setup(2);
	const [a, b] = [devices[0]!, devices[1]!];
	const id = await createMailbox(a, [b]);
	await activate(id, b);
	expect((await a.request("PATCH", `/v1/mailboxes/${id}`, { retentionDays: 7 })).status).toBe(204);
	return { server, a, b, id };
}

describe("sweep", () => {
	it("expires a message at retention and leaves a marker for each recipient that missed it", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, messages: 2 });
		const box = await inbox(b, id);
		expect(box.messages).toEqual([]);
		expect(box.markers).toEqual([
			{ id: expect.any(Number), sender: a.sigKey, count: 2, expiredAt: server.clock.now },
		]);
	});

	it("keeps a message one millisecond before it expires", async () => {
		const { server, a, b, id } = await pair();
		const { msgId } = await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS - 1;
		expect(await sweep(server.deps)).toEqual(NOTHING);
		expect((await inbox(b, id)).messages.map((m) => m.id)).toEqual([msgId]);
	});

	it("adds to an existing marker rather than starting another", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		expect((await inbox(b, id)).markers.map((m) => m.count)).toEqual([2]);
	});

	it("deletes a marker once its member acknowledges it, and old markers on their own", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		const [marker] = (await inbox(b, id)).markers;
		await ack(b, id, { markers: [marker!.id] });
		expect((await inbox(b, id)).markers).toEqual([]);

		await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		server.clock.now += 365 * DAY_MS + 1;
		await inbox(a, id); // a check-in keeps the mailbox from being abandoned
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, markers: 1 });
		expect((await inbox(b, id)).markers).toEqual([]);
	});

	it("expires blobs without leaving markers", async () => {
		const { server, a, b, id } = await pair();
		const { hash } = await uploadBlob(a, id, randomBytes(64), { to: [b] });
		server.clock.now += 7 * DAY_MS;
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, blobs: 1 });
		const box = await inbox(b, id);
		expect(box.blobs).toEqual([]);
		expect(box.markers).toEqual([]);
		expect((await b.request("GET", `/v1/mailboxes/${id}/blobs/${hash}`)).status).toBe(404);
	});

	it("deletes a mailbox nobody has checked in to for the ceiling, bodies included", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		server.clock.now += 365 * DAY_MS + 1;
		const report = await sweep(server.deps);
		expect(report.mailboxes).toBe(1);
		expect((await a.request("GET", `/v1/mailboxes/${id}/members`)).status).toBe(404);
		let n = 0;
		for await (const _ of server.deps.bodies.keys()) n++;
		expect(n).toBe(0);
	});

	it("keeps a mailbox someone checked in to within the ceiling", async () => {
		const { server, a, b, id } = await pair();
		server.clock.now += 300 * DAY_MS;
		await inbox(b, id);
		server.clock.now += 100 * DAY_MS;
		expect((await sweep(server.deps)).mailboxes).toBe(0);
		expect((await a.request("GET", `/v1/mailboxes/${id}/members`)).status).toBe(200);
	});

	it("keeps a recent orphan body and deletes an old one", async () => {
		const { server, id } = await pair();
		await server.deps.bodies.put(`m/${id}/${newMessageId()}`, new Uint8Array([1]));
		expect((await sweep(server.deps)).orphans).toBe(0);
		server.clock.now += HOUR_MS + 1;
		expect((await sweep(server.deps)).orphans).toBe(1);
	});

	it("a run stops at its query budget, and the next carries on", async () => {
		const { server, a, b, id } = await pair();
		for (let i = 0; i < 5; i++) await postMessage(a, id, { to: [b] });
		server.clock.now += 7 * DAY_MS;
		// Two batches of two: a select, then the markers (two statements) and the delete.
		const budget = { steps: { messages: 8 }, batchSize: 2 };
		expect(await sweep(server.deps, budget)).toEqual({ ...NOTHING, messages: 4, more: true });
		expect(await sweep(server.deps)).toEqual({ ...NOTHING, messages: 1 });
	});

	it("the orphan pass resumes where it stopped, and wraps", async () => {
		const { server, id } = await pair();
		for (let i = 0; i < 7; i++) {
			await server.deps.bodies.put(`m/${id}/orphan${i}`, new Uint8Array([1]));
		}
		server.clock.now += HOUR_MS + 1;
		const runs = [await sweep(server.deps, { orphanKeys: 3 })];
		runs.push(await sweep(server.deps, { orphanKeys: 3 }));
		// Before every key already listed: only a pass that wraps to the start can find it.
		await server.deps.bodies.put(`m/${id}/aaa`, new Uint8Array([1]));
		server.clock.now += HOUR_MS + 1;
		runs.push(await sweep(server.deps, { orphanKeys: 3 }));
		runs.push(await sweep(server.deps, { orphanKeys: 3 }));
		expect(runs.map((r) => r.orphans)).toEqual([3, 3, 1, 1]);
		expect(runs.map((r) => r.more)).toEqual([true, true, false, false]);
	});

	it("an orphan pass that fails part-way keeps the place it reached", async () => {
		const starts: (string | undefined)[] = [];
		const [first, second] = ["A".repeat(43), "B".repeat(43)];
		let failing = true;
		const { server } = await setup(1, {
			wrapBodies: (inner) => ({
				...inner,
				keys: (startAfter) => {
					starts.push(startAfter);
					return inner.keys(startAfter);
				},
				deleteMany: async (keys) => {
					if (failing && keys.some((key) => key.includes(second))) throw new Error("R2 is down");
					await inner.deleteMany(keys);
				},
			}),
		});
		await server.deps.bodies.put(`m/${first}/one`, new Uint8Array([1]));
		await server.deps.bodies.put(`m/${second}/one`, new Uint8Array([1]));
		server.clock.now += HOUR_MS + 1;
		await expect(sweep(server.deps)).rejects.toThrow("R2 is down");
		failing = false;
		expect((await sweep(server.deps)).orphans).toBe(1);
		expect(starts).toEqual([undefined, `m/${first}/one`]);
	});

	it("a body younger than the grace period is never an orphan, across runs", async () => {
		const { server, id } = await pair();
		for (let i = 0; i < 4; i++) {
			await server.deps.bodies.put(`m/${id}/old${i}`, new Uint8Array([1]));
		}
		server.clock.now += HOUR_MS + 1;
		const young = `m/${id}/old9`;
		await server.deps.bodies.put(young, new Uint8Array([1]));
		for (let i = 0; i < 3; i++) await sweep(server.deps, { orphanKeys: 2 });
		const left: string[] = [];
		for await (const { key } of server.deps.bodies.keys()) left.push(key);
		expect(left).toEqual([young]);
	});

	it("an expiry backlog leaves the later steps their share", async () => {
		const { server } = await setup(1);
		const { db } = server.deps;
		const now = server.clock.now;
		const ids = Array.from({ length: 300 }, (_, i) => `busy${i}`);
		const insert = async <T>(rows: T[], put: (part: T[]) => Promise<unknown>) => {
			for (const part of chunk(rows, 100)) await put(part);
		};
		await insert(
			[
				...ids.map((id) => ({ id, retentionDays: 7, createdAt: now, accountId: null })),
				{ id: "abandoned", retentionDays: 7, createdAt: now - 400 * DAY_MS, accountId: null },
			],
			(part) => db.insert(mailboxes).values(part),
		);
		await insert(
			[
				...ids.map((mailboxId) => ({
					mailboxId,
					sigKey: "k",
					status: "active" as const,
					addedAt: now,
					lastCheckedDay: dayOf(now),
				})),
				{
					mailboxId: "abandoned",
					sigKey: "k",
					status: "active" as const,
					addedAt: 0,
					lastCheckedDay: null,
				},
			],
			(part) => db.insert(members).values(part),
		);
		await insert(
			ids.map((mailboxId) => ({
				mailboxId,
				id: "m".repeat(22),
				sender: "k",
				size: 0,
				createdAt: now - 2 * DAY_MS,
				expiresAt: now - 1,
			})),
			(part) => db.insert(messages).values(part),
		);
		await db.insert(expiryMarkers).values({
			mailboxId: ids[0] as string,
			member: "k",
			sender: "k",
			count: 1,
			expiredAt: now - 400 * DAY_MS,
		});
		const report = await sweep(server.deps);
		expect(report.mailboxes).toBe(1);
		expect(report.markers).toBe(1);
		expect(report.more).toBe(true);
	});

	it("is a no-op the second time", async () => {
		const { server, a, b, id } = await pair();
		await postMessage(a, id, { to: [b] });
		await uploadBlob(a, id, randomBytes(32), { to: [b] });
		server.clock.now += 7 * DAY_MS;
		await sweep(server.deps);
		expect(await sweep(server.deps)).toEqual(NOTHING);
	});
});
