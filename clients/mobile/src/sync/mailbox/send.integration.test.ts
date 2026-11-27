import { drainInbox } from "@core/sync/mailbox/receive";
import { answerRequests, compact, postChanges, requestSnapshot } from "@core/sync/mailbox/send";
import { addDevice, revokeDevice } from "@core/sync/roster";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	activeGroup,
	addLogin,
	attachFile,
	inboxKinds,
	names,
	type TestDevice,
	testGroup,
} from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

async function pair(opts?: Parameters<typeof activeGroup>[2]) {
	return (await activeGroup(box, ["a", "b"], opts)) as [TestDevice, TestDevice];
}
const post = async (d: TestDevice) => postChanges(d.ctx, d.state, await d.ctx.vault.readLocal());

describe("sending", () => {
	it("posts a closed delta with the next sequence number, then nothing until the next change", async () => {
		const [a, b] = await pair();
		await addLogin(a, "Passport");
		expect(await post(a)).toBe("posted");
		expect(a.state.nextSeq).toBe(2);
		expect(await post(a)).toBe("nothing");
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual(["Passport"]);
		expect(b.state.senders[a.sigKey]?.through).toBe(1);
	});

	it("posts the roster when only the roster changed", async () => {
		const [a, b] = await pair();
		await addLogin(a, "Passport");
		await post(a);
		expect(await post(a)).toBe("nothing");
		const paired = {
			id: "z",
			publicKey: "pk-z",
			label: "z",
			addedAt: 2,
			hlc: { wall: 2, counter: 0, node: "a" },
		};
		a.roster.current = addDevice(a.roster.current, paired);
		expect(await post(a)).toBe("posted");
		await drainInbox(b.ctx, b.state);
		expect(b.roster.current.devices.map((d) => d.id)).toContain("z");
		expect(await post(a)).toBe("nothing");
	});

	it("uploads a new attachment before the delta that names it", async () => {
		const [a, b] = await pair();
		const entry = await addLogin(a, "Passport");
		await post(a);
		await drainInbox(b.ctx, b.state);
		const hash = await attachFile(a, entry, new Uint8Array([1, 2, 3]));
		await post(a);
		const inbox = await b.ctx.api.inbox();
		const blob = inbox.blobs.find((x) => x.hash === hash);
		expect(blob?.createdAt).toBeLessThanOrEqual(inbox.messages[0]?.createdAt as number);
		expect(a.state.uploaded).toEqual([hash]);
	});

	it("splits a delta larger than one message into closed parts", async () => {
		const [a, b] = await pair({ limits: { partBudget: 1000 } });
		for (const n of ["One", "Two", "Three", "Four", "Five", "Six"]) await addLogin(a, n);
		expect(await post(a)).toBe("posted");
		const parts = (await b.ctx.api.inbox()).messages.length;
		expect(parts).toBeGreaterThan(1);
		expect(a.state.nextSeq).toBe(1 + parts);
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual(await names(a));
		expect(b.state.senders[a.sigKey]).toMatchObject({ through: parts, above: [] });
	});

	it("keeps the delta while collect-only, and posts it after", async () => {
		const [a] = await pair();
		await addLogin(a, "Passport");
		await box.setCanPost(false);
		try {
			expect(await post(a)).toBe("collect_only");
			expect(a.state).toMatchObject({ posted: {}, nextSeq: 1 });
		} finally {
			await box.setCanPost(true);
		}
		expect(await post(a)).toBe("posted");
	});

	it("answers a snapshot request once per hour", async () => {
		const [a, b] = await pair();
		await addLogin(a, "Passport");
		a.state.toAnswer[b.sigKey] = null;
		await answerRequests(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(a.state.toAnswer).toEqual({});
		a.state.toAnswer[b.sigKey] = null;
		await answerRequests(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(a.state.toAnswer).toEqual({});
		expect((await b.ctx.api.inbox()).messages).toHaveLength(1);
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual(["Passport"]);
	});

	it("compacts the backlog for a member that has not checked in", async () => {
		const [a, b] = await pair({ limits: { compactCount: 3 } });
		for (const n of ["One", "Two", "Three"]) {
			await addLogin(a, n);
			await post(a);
		}
		await compact(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect((await b.ctx.api.inbox()).messages).toHaveLength(1);
		expect(a.state.log).toHaveLength(1);
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual(["One", "Three", "Two"]);
	});

	it("switching on uploads nothing historical", async () => {
		const [a, b] = await pair();
		await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([4, 4]));
		expect(await post(a)).toBe("posted");
		expect((await b.ctx.api.inbox()).blobs).toEqual([]);
		expect(a.state.uploaded).toEqual([]);
	});

	it("a failed upload does not hold back the delta", async () => {
		const [a, b] = await pair();
		const entry = await addLogin(a, "Passport");
		await post(a);
		await attachFile(a, entry, new Uint8Array([5, 5]));
		const mover = a.ctx.blobs.mover;
		a.ctx.blobs.mover = {
			download: mover.download,
			upload: async () => {
				throw new Error("transfer/interrupted");
			},
		};
		expect(await post(a)).toBe("posted");
		expect(a.state.uploaded).toEqual([]);
		expect((await b.ctx.api.inbox()).messages).toHaveLength(2);
	});

	it("compaction keeps this device's pending snapshot requests", async () => {
		const [a, b] = await pair({ limits: { compactCount: 2 } });
		await requestSnapshot(a.ctx, a.state, null, a.roster.current);
		for (const n of ["One", "Two"]) {
			await addLogin(a, n);
			await post(a);
		}
		await compact(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(await inboxKinds(b)).toEqual(["snapshot", "snapshot_request"]);
	});

	it("a large vault is not re-posted while a member is away", async () => {
		const [a, b] = await pair({ limits: { compactBytes: 1, compactCount: 1000 } });
		await addLogin(a, "Passport");
		await post(a);
		for (let i = 0; i < 3; i++) await compact(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(await inboxKinds(b)).toEqual(["snapshot"]);
	});

	it("a device revoked here is sent no answer and no compaction snapshot", async () => {
		const [a, b, d] = (await activeGroup(box, ["a", "b", "d"], {
			limits: { compactCount: 1 },
		})) as [TestDevice, TestDevice, TestDevice];
		a.roster.current = revokeDevice(a.roster.current, "d", { wall: 2, counter: 0, node: "a" });
		a.state.toAnswer[d.sigKey] = null;
		await answerRequests(a.ctx, a.state, await a.ctx.vault.readLocal());
		await addLogin(a, "Passport");
		await post(a);
		await compact(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(await inboxKinds(b)).toEqual(["snapshot"]);
		expect(await inboxKinds(d)).not.toContain("snapshot");
	});

	it("a device revoked here is sent none of this device's changes", async () => {
		const [a, b, d] = (await activeGroup(box, ["a", "b", "d"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		a.roster.current = revokeDevice(a.roster.current, "d", { wall: 2, counter: 0, node: "a" });
		await addLogin(a, "Passport");
		await post(a);
		expect(await inboxKinds(b)).toEqual(["delta"]);
		expect(await inboxKinds(d)).toEqual([]);
	});

	// Any active member may list a key, so a compromised one can list a reader of its own.
	it("a key the server lists but the roster doesn't hold is sent nothing", async () => {
		const [a, b, planted] = (await testGroup(box, ["a", "b", "planted"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		for (const d of [a, b]) {
			d.roster.current.devices = d.roster.current.devices.filter((e) => e.id !== "planted");
		}
		await a.ctx.api.create({ members: [a.sigKey, b.sigKey] });
		a.state.active = true;
		await b.ctx.api.activate(true);
		await b.ctx.api.changeMembers({ add: [planted.sigKey], remove: [] });
		await planted.ctx.api.activate(true);
		await addLogin(a, "Passport");
		await post(a);
		await requestSnapshot(a.ctx, a.state, null, a.roster.current);
		expect(await inboxKinds(b)).toEqual(["delta", "snapshot_request"]);
		expect(await inboxKinds(planted)).toEqual([]);
	});

	// Moves the shared server's clock a day on.
	it("drops what every member has checked in since, without a snapshot", async () => {
		const [a, b] = await pair({ limits: { compactCount: 3 } });
		for (const n of ["One", "Two", "Three"]) {
			await addLogin(a, n);
			await post(a);
		}
		await box.advance(86_400_000);
		await drainInbox(b.ctx, b.state);
		await compact(a.ctx, a.state, await a.ctx.vault.readLocal());
		expect(a.state.log).toEqual([]);
		expect((await b.ctx.api.inbox()).messages).toEqual([]);
	});
});
