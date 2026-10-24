import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import type { Hlc } from "../sync";
import { effectivePartStamps, itemsOf, partsEqual, partsOf, withPartStamps } from "./parts";

const at = (wall: number, node = "n"): Hlc => ({ wall, counter: 0, node });
const login = (over: Partial<Extract<EntryData, { type: "login" }>> = {}): Entry =>
	({
		id: "e",
		type: "login",
		name: "GitHub",
		urls: ["https://github.com"],
		username: "u",
		password: "p",
		...over,
	}) as Entry;

describe("parts", () => {
	it("credential, card and key fields move as one part", () => {
		const parts = partsOf(login({ totp: "JBSW" }));
		expect(parts.get("credential")).toEqual({ username: "u", password: "p", totp: "JBSW" });
		expect(parts.has("username")).toBe(false);
		const card = partsOf({
			type: "card",
			name: "Visa",
			cardholderName: "A",
			number: "4111",
			expMonth: "01",
			expYear: "30",
			cvv: "123",
		});
		expect(card.get("card")).toEqual({
			cardholderName: "A",
			number: "4111",
			expMonth: "01",
			expYear: "30",
			cvv: "123",
		});
		const key = partsOf({ type: "ssh-key", name: "k", publicKey: "pub", privateKey: "priv" });
		expect(key.get("key")).toEqual({ publicKey: "pub", privateKey: "priv" });
	});

	it("every other field is its own part, unknown ones included, and lists and metadata aren't", () => {
		const parts = partsOf({ ...login({ notes: "n" }), futureField: 1 } as unknown as Entry);
		expect(parts.get("name")).toBe("GitHub");
		expect(parts.get("notes")).toBe("n");
		expect(parts.get("futureField")).toBe(1);
		for (const notAPart of ["id", "type", "urls", "tags", "passkeys", "updatedAt", "partStamps"]) {
			expect(parts.has(notAPart)).toBe(false);
		}
	});

	it("empty, absent and [] compare equal", () => {
		expect(partsEqual("", undefined)).toBe(true);
		expect(partsEqual([], undefined)).toBe(true);
		expect(partsEqual({ a: 1, b: "" }, { a: 1 })).toBe(true);
		expect(partsEqual({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
		expect(partsEqual("x", "y")).toBe(false);
	});

	it("tags are keyed case-insensitively and passkeys by credentialId", () => {
		const e = login({ tags: ["Work"], passkeys: [{ credentialId: "c1" } as never] });
		expect([...itemsOf(e, "tags").keys()]).toEqual(["work"]);
		expect([...itemsOf(e, "passkeys").keys()]).toEqual(["c1"]);
		expect([...itemsOf(e, "urls").keys()]).toEqual(["https://github.com"]);
	});

	it("a stale version counts every part and item as changed at its own stamp", () => {
		const e = login({ tags: ["work"] });
		for (const data of [e, { ...e, partStamps: { name: at(1) }, partStampsAt: at(1) }]) {
			const eff = effectivePartStamps(data, { hlc: at(9) });
			expect(eff.stale).toBe(true);
			expect(eff.parts.name).toEqual(at(9));
			expect(eff.parts.credential).toEqual(at(9));
			expect(eff.items.tags.work).toEqual(at(9));
		}
	});

	it("a current version reports its own stamps", () => {
		const e = { ...login(), partStamps: { name: at(3) }, partStampsAt: at(9) } as Entry;
		const eff = effectivePartStamps(e, { hlc: at(9) });
		expect(eff.stale).toBe(false);
		expect(eff.parts.name).toEqual(at(3));
	});
});

describe("withPartStamps", () => {
	const s1 = at(1);
	const base = {
		...login({ notes: "a", tags: ["work", "home"] }),
		partStamps: { name: s1, notes: s1, credential: s1 },
		itemStamps: {
			urls: { "https://github.com": s1 },
			tags: { work: s1, home: s1 },
		},
		partStampsAt: s1,
	} as Entry;

	it("restamps only what changed", () => {
		const next = withPartStamps(
			{ ...base, notes: "b" } as Entry,
			{ data: base, version: { hlc: s1 } },
			at(5),
		);
		expect(next.partStamps).toEqual({ name: s1, notes: at(5), credential: s1 });
		expect(next.partStampsAt).toEqual(at(5));
	});

	it("stamps added items, keeps existing ones, drops removed ones", () => {
		const next = withPartStamps(
			{ ...base, tags: ["work", "travel"] } as Entry,
			{ data: base, version: { hlc: s1 } },
			at(5),
		);
		expect(next.itemStamps?.tags).toEqual({ work: s1, travel: at(5) });
		expect(next.partStamps).toEqual(base.partStamps);
	});

	it("discards stamps the caller supplied", () => {
		const next = withPartStamps(
			{ ...base, partStamps: { name: at(99) }, partStampsAt: at(99) } as Entry,
			{ data: base, version: { hlc: s1 } },
			at(5),
		);
		expect(next.partStamps?.name).toEqual(s1);
		expect(next.partStampsAt).toEqual(at(5));
	});

	it("a new entry stamps every part and item at its own stamp", () => {
		const next = withPartStamps(login({ tags: ["work"] }), undefined, at(7));
		expect(next.partStamps).toEqual({ name: at(7), credential: at(7) });
		expect(next.itemStamps).toEqual({
			urls: { "https://github.com": at(7) },
			tags: { work: at(7) },
		});
		expect(next.partStampsAt).toEqual(at(7));
	});

	it("an edit of a stale version carries the stale stamp for what it didn't change", () => {
		const stale = login({ notes: "a" });
		const next = withPartStamps(
			{ ...stale, notes: "b" } as Entry,
			{ data: stale, version: { hlc: at(4) } },
			at(8),
		);
		expect(next.partStamps).toEqual({ name: at(4), notes: at(8), credential: at(4) });
	});

	it("a part or item a superseded version disagrees with is restamped, as a resolution's choice", () => {
		const sibling = { ...base, notes: "other", tags: ["work"] } as Entry;
		const next = withPartStamps(base, { data: base, version: { hlc: s1 } }, at(7), [sibling]);
		expect(next.partStamps).toEqual({ name: s1, notes: at(7), credential: s1 });
		expect(next.itemStamps?.tags).toEqual({ work: s1, home: at(7) });
	});

	it("a part only a superseded version has is recorded as cleared", () => {
		const { notes: _n, ...plain } = base as Entry & { notes?: string };
		const kept = { ...plain, partStamps: { name: s1, credential: s1 } } as Entry;
		const next = withPartStamps(kept, { data: kept, version: { hlc: s1 } }, at(7), [base]);
		expect(next.partStamps?.notes).toEqual(at(7));
	});

	it("clearing a field restamps it, so the clear can win a combine", () => {
		const next = withPartStamps(
			{ ...base, notes: undefined } as Entry,
			{ data: base, version: { hlc: s1 } },
			at(6),
		);
		expect(next.partStamps?.notes).toEqual(at(6));
	});
});
