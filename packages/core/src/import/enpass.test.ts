import { describe, expect, it } from "vitest";
import type { CardEntryData, LoginEntryData, NoteEntryData } from "../hooks/useVault";
import { parseEnpass } from "./enpass";

// Shapes follow real Enpass 6 .json exports: every template field is written, filled or not,
// with `sensitive`/`deleted` as 0/1 and Unix-second timestamps.
let uid = 0;
const field = (type: string, label: string, value: string, extra: object = {}) => ({
	deleted: 0,
	label,
	order: ++uid,
	sensitive: type === "password" ? 1 : 0,
	type,
	uid,
	updated_at: 1666449561,
	value,
	value_updated_at: 1666449561,
	...extra,
});

const item = (over: object) => ({
	archived: 0,
	auto_submit: 1,
	category: "login",
	createdAt: 1666449561,
	favorite: 0,
	fields: [],
	icon: { fav: "", image: { file: "" }, type: 1, uuid: "" },
	note: "",
	subtitle: "",
	template_type: "login.default",
	title: "",
	trashed: 0,
	updated_at: 1666449561,
	uuid: "f717cb7c-6cce-4b24-b023-ec8a429cc992",
	...over,
});

const file = (items: object[], folders: object[] = []) => JSON.stringify({ folders, items });
const first = <T>(raw: string): T => parseEnpass(raw).imported[0] as T;
const fields = (e: { customFields?: { key: string; value: string; hidden?: boolean }[] }) =>
	Object.fromEntries((e.customFields ?? []).map((f) => [f.key, f.value]));

describe("logins", () => {
	it("maps the login template", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Amazon",
					note: "some notes",
					fields: [
						field("username", "Username", "emily"),
						field("password", "Password", "pw"),
						field("url", "Website", "https://www.amazon.com"),
						field("totp", "One-time code", "JBSWY3DPEHPK3PXP"),
					],
				}),
			]),
		);
		expect(entry).toMatchObject({
			type: "login",
			name: "Amazon",
			notes: "some notes",
			username: "emily",
			password: "pw",
			urls: ["https://www.amazon.com"],
			totp: "JBSWY3DPEHPK3PXP",
		});
	});

	it("keeps the other fields, masking the ones Enpass marks sensitive", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Bank",
					fields: [
						field("username", "Username", "emily"),
						field("section", "ADDITIONAL DETAILS", ""),
						field("phone", "Phone number", "12345678"),
						field("text", "Security answer", "Rex", { sensitive: 1 }),
						field("text", "Empty", ""),
					],
				}),
			]),
		);
		expect(entry.customFields).toEqual([
			{ key: "Phone number", value: "12345678" },
			{ key: "Security answer", value: "Rex", hidden: true },
		]);
	});

	it("uses the email as the username when the username is blank", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Shop",
					fields: [
						field("username", "Username", ""),
						field("email", "E-mail", "emily@enpass.io"),
						field("password", "Password", "pw"),
					],
				}),
			]),
		);
		expect(entry.username).toBe("emily@enpass.io");
		expect(fields(entry)).toEqual({});
	});

	it("keeps the email as a field when there is also a username", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Shop",
					fields: [
						field("username", "Username", "emily"),
						field("email", "E-mail", "emily@enpass.io"),
					],
				}),
			]),
		);
		expect(entry.username).toBe("emily");
		expect(fields(entry)).toEqual({ "E-mail": "emily@enpass.io" });
	});

	it("keeps every URL", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Google",
					fields: [
						field("url", "Website", "https://accounts.google.com"),
						field("url", "Website", "https://mail.google.com"),
					],
				}),
			]),
		);
		expect(entry.urls).toEqual(["https://accounts.google.com", "https://mail.google.com"]);
	});

	it("keeps a second password as a hidden field", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Router",
					fields: [
						field("password", "Password", "first"),
						field("password", "Admin password", "second"),
					],
				}),
			]),
		);
		expect(entry.password).toBe("first");
		expect(entry.customFields).toEqual([{ key: "Admin password", value: "second", hidden: true }]);
	});

	it("reads the password template as a login", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "PIN pad",
					category: "password",
					template_type: "password.default",
					fields: [field("password", "Password", "1234")],
				}),
			]),
		);
		expect(entry).toMatchObject({ type: "login", password: "1234" });
	});

	it("reads another template holding a password as a login", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Mail server",
					category: "computer",
					template_type: "computer.emailaccount",
					fields: [
						field("username", "Username", "emily"),
						field("password", "Password", "pw"),
						field("text", "IMAP server", "imap.example.com"),
					],
				}),
			]),
		);
		expect(entry).toMatchObject({ type: "login", username: "emily", password: "pw" });
		expect(fields(entry)).toEqual({ "IMAP server": "imap.example.com" });
	});

	it("names a nameless login after its host", () => {
		const entry = first<LoginEntryData>(
			file([item({ fields: [field("url", "Website", "https://forum.example.org/login")] })]),
		);
		expect(entry.name).toBe("forum.example.org");
	});

	it("ignores a field Enpass marks deleted", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Old",
					fields: [
						field("password", "Password", "current"),
						field("text", "Old hint", "gone", { deleted: 1 }),
					],
				}),
			]),
		);
		expect(entry.customFields).toBeUndefined();
	});

	it("keeps the timestamps", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "A",
					createdAt: 1666449561,
					updated_at: 1666500000,
					fields: [field("password", "Password", "pw")],
				}),
			]),
		);
		expect(entry).toMatchObject({ createdAt: 1666449561000, updatedAt: 1666500000000 });
	});
});

describe("cards", () => {
	it("maps the credit card template", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					title: "Amex",
					category: "creditcard",
					template_type: "creditcard.default",
					note: "travel card",
					fields: [
						field("ccName", "Cardholder", "Emily Sample"),
						field("ccType", "Type", "American Express"),
						field("ccNumber", "Number", "3782 822463 10005"),
						field("ccCvc", "CVC", "1234", { sensitive: 1 }),
						field("ccPin", "PIN", "9874", { sensitive: 1 }),
						field("ccExpiry", "Expiry date", "03/23"),
						field("ccBankname", "Issuing bank", "American Express"),
					],
				}),
			]),
		);
		expect(entry).toMatchObject({
			type: "card",
			name: "Amex",
			notes: "travel card",
			cardholderName: "Emily Sample",
			number: "3782 822463 10005",
			brand: "Amex",
			cvv: "1234",
			expMonth: "3",
			expYear: "23",
		});
		expect(entry.customFields).toEqual([
			{ key: "PIN", value: "9874", hidden: true },
			{ key: "Issuing bank", value: "American Express" },
		]);
	});

	it("masks a PIN even when Enpass doesn't mark it sensitive", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccPin", "PIN", "9874", { sensitive: 0 })],
				}),
			]),
		);
		expect(entry.customFields).toEqual([{ key: "PIN", value: "9874", hidden: true }]);
	});

	it("takes the brand from the card type when the number doesn't say", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccType", "Type", "Visa"), field("ccNumber", "Number", "0000")],
				}),
			]),
		);
		expect(entry.brand).toBe("Visa");
		expect(entry.customFields).toBeUndefined();
	});

	it("keeps a card type that names no brand", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccType", "Type", "JCB"), field("ccNumber", "Number", "3530111333300000")],
				}),
			]),
		);
		expect(fields(entry)).toEqual({ Type: "JCB" });
	});

	it("reads a four-digit expiry year", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccExpiry", "Expiry date", "11/2029")],
				}),
			]),
		);
		expect(entry).toMatchObject({ expMonth: "11", expYear: "2029" });
	});

	it("keeps an expiry it can't read as a field", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccExpiry", "Expiry date", "next year")],
				}),
			]),
		);
		expect(entry).toMatchObject({ expMonth: "", expYear: "" });
		expect(fields(entry)).toEqual({ "Expiry date": "next year" });
	});

	it("keeps an expiry with no such month as a field", () => {
		const entry = first<CardEntryData>(
			file([
				item({
					category: "creditcard",
					template_type: "creditcard.default",
					fields: [field("ccExpiry", "Expiry date", "13/25")],
				}),
			]),
		);
		expect(entry.expMonth).toBe("");
		expect(fields(entry)).toEqual({ "Expiry date": "13/25" });
	});
});

describe("notes", () => {
	it("maps the secure note template", () => {
		const entry = first<NoteEntryData>(
			file([
				item({
					title: "Wi-Fi",
					category: "note",
					template_type: "note.default",
					note: "on the fridge",
				}),
			]),
		);
		expect(entry).toMatchObject({ type: "note", name: "Wi-Fi", notes: "on the fridge" });
	});

	it("folds any other template into a note with its fields", () => {
		const entry = first<NoteEntryData>(
			file([
				item({
					title: "Passport",
					category: "travel",
					template_type: "travel.passport",
					fields: [field("text", "Number", "X1234567"), field("date", "Expiry", "2031-05-01")],
				}),
			]),
		);
		expect(entry).toMatchObject({ type: "note", name: "Passport" });
		expect(fields(entry)).toEqual({ Number: "X1234567", Expiry: "2031-05-01" });
	});

	it("keeps an identity with a password as a note", () => {
		const entry = first<NoteEntryData>(
			file([
				item({
					title: "Me",
					category: "identity",
					template_type: "identity.default",
					fields: [field("text", "Name", "Emily"), field("password", "Password", "pw")],
				}),
			]),
		);
		expect(entry.type).toBe("note");
		expect(entry.customFields).toEqual([
			{ key: "Name", value: "Emily" },
			{ key: "Password", value: "pw", hidden: true },
		]);
	});
});

describe("tags, archive and trash", () => {
	it("turns an item's folders into tags, one per level", () => {
		const entry = first<LoginEntryData>(
			file(
				[item({ title: "A", folders: ["child"], fields: [field("password", "Password", "pw")] })],
				[
					{ uuid: "root", parent_uuid: "", title: "Work", icon: "", updated_at: 0 },
					{ uuid: "child", parent_uuid: "root", title: "Clients", icon: "", updated_at: 0 },
				],
			),
		);
		expect(entry.tags).toEqual(["Work", "Clients"]);
	});

	it("survives a folder loop", () => {
		const entry = first<LoginEntryData>(
			file(
				[item({ title: "A", folders: ["a"], fields: [field("password", "Password", "pw")] })],
				[
					{ uuid: "a", parent_uuid: "b", title: "A" },
					{ uuid: "b", parent_uuid: "a", title: "B" },
				],
			),
		);
		expect(entry.tags).toEqual(["B", "A"]);
	});

	it("imports an archived item as archived", () => {
		const entry = first<LoginEntryData>(
			file([
				item({
					title: "Old",
					archived: 1,
					updated_at: 1666500000,
					fields: [field("password", "Password", "pw")],
				}),
			]),
		);
		expect(entry.archivedAt).toBe(1666500000000);
	});

	it("leaves trashed items out, and says so", () => {
		const res = parseEnpass(
			file([
				item({ title: "Live", fields: [field("password", "Password", "pw")] }),
				item({ title: "Binned", trashed: 1, fields: [field("password", "Password", "pw")] }),
			]),
		);
		expect(res.imported.map((e) => e.name)).toEqual(["Live"]);
		expect(res.skipped).toBe(1);
		expect(res.warnings).toEqual(["1 item(s) in Enpass's trash were left out."]);
	});
});

describe("attachments", () => {
	it("counts attachments it can't bring over", () => {
		const res = parseEnpass(
			file([
				item({
					title: "Scan",
					fields: [field("password", "Password", "pw")],
					attachments: [
						{ name: "a.pdf", kind: "application/pdf", data: "JVBERi0=" },
						{ name: "b.png", kind: "image/png", data: "iVBORw==" },
					],
				}),
			]),
		);
		expect(res.imported).toHaveLength(1);
		expect(res.warnings).toEqual([
			"2 attachment(s) weren't imported, as attachments aren't supported yet. Save them from Enpass before you delete it.",
		]);
	});
});

describe("file checks", () => {
	it("rejects JSON that isn't an Enpass export", () => {
		expect(() => parseEnpass(JSON.stringify({ encrypted: false, items: "nope" }))).toThrow(
			"This doesn't look like an Enpass .json export.",
		);
	});

	it("rejects a file that isn't JSON", () => {
		expect(() => parseEnpass("url,username,password")).toThrow(
			"This doesn't look like an Enpass .json export.",
		);
	});
});
