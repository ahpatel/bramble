import { describe, expect, it } from "vitest";
import type { CardEntryData, LoginEntryData, NoteEntryData } from "../hooks/useVault";
import { parseAliasVault } from "./aliasvault";
import { parseGooglePasswords } from "./csv";

// The header AliasVault writes today (core/client/src/transfer/export/AliasVaultCsvExportService.ts).
const HEADER =
	"ServiceName,FolderPath,ServiceUrl,Username,CurrentPassword,AliasEmail,TwoFactorSecret,AliasGender,AliasFirstName,AliasLastName,AliasBirthDate,CardholderName,CardNumber,CardExpiryMonth,CardExpiryYear,CardCvv,CardPin,Notes,CreatedAt,UpdatedAt";
// Older exports: no card columns, and an AliasNickName column the current one dropped.
const LEGACY_HEADER =
	"ServiceName,FolderPath,ServiceUrl,Username,CurrentPassword,AliasEmail,TwoFactorSecret,AliasGender,AliasFirstName,AliasLastName,AliasNickName,AliasBirthDate,Notes,CreatedAt,UpdatedAt";

type Row = Partial<Record<string, string>>;
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: string, ...rows: Row[]) => {
	const cols = header.split(",");
	return [header, ...rows.map((r) => cols.map((c) => quote(r[c] ?? "")).join(","))].join("\n");
};

const first = <T>(raw: string): T => parseAliasVault(raw).imported[0] as T;
const fields = (e: { customFields?: { key: string; value: string; hidden?: boolean }[] }) =>
	Object.fromEntries((e.customFields ?? []).map((f) => [f.key, f.value]));

describe("logins", () => {
	it("maps the login columns", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, {
				ServiceName: "GitHub",
				ServiceUrl: "https://github.com",
				Username: "octo",
				CurrentPassword: "pw",
				TwoFactorSecret: "JBSWY3DPEHPK3PXP",
				Notes: "a note",
			}),
		);
		expect(entry).toMatchObject({
			type: "login",
			name: "GitHub",
			urls: ["https://github.com"],
			username: "octo",
			password: "pw",
			totp: "JBSWY3DPEHPK3PXP",
			notes: "a note",
		});
	});

	it("splits a ServiceUrl cell holding several URLs", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, {
				ServiceName: "Example",
				ServiceUrl: "https://example.com, https://www.example.com",
				CurrentPassword: "pw",
			}),
		);
		expect(entry.urls).toEqual(["https://example.com", "https://www.example.com"]);
	});

	it("uses the alias email as the username when there is none", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceName: "Shop", AliasEmail: "shop@alias.example", CurrentPassword: "pw" }),
		);
		expect(entry.username).toBe("shop@alias.example");
		expect(fields(entry)).toEqual({});
	});

	it("keeps the alias email as a field when there is also a username", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, {
				ServiceName: "Shop",
				Username: "shopper",
				AliasEmail: "shop@alias.example",
				CurrentPassword: "pw",
			}),
		);
		expect(entry.username).toBe("shopper");
		expect(fields(entry)).toEqual({ Email: "shop@alias.example" });
	});

	it("keeps the alias identity as fields", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, {
				ServiceName: "Forum",
				Username: "jdoe",
				CurrentPassword: "pw",
				AliasFirstName: "Jane",
				AliasLastName: "Doe",
				AliasGender: "Female",
				AliasBirthDate: "03/14/1990 00:00:00",
			}),
		);
		expect(fields(entry)).toEqual({
			"First name": "Jane",
			"Last name": "Doe",
			Gender: "Female",
			"Birth date": "1990-03-14",
		});
	});

	it("keeps a birth date it can't read verbatim", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceName: "Forum", Username: "jdoe", AliasBirthDate: "14 March 1990" }),
		);
		expect(fields(entry)).toEqual({ "Birth date": "14 March 1990" });
	});

	it("passes an otpauth:// URI through verbatim", () => {
		const uri = "otpauth://totp/AliasVault:x?secret=ABC&algorithm=SHA256&digits=8&period=30";
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceName: "X", Username: "x", TwoFactorSecret: uri }),
		);
		expect(entry.totp).toBe(uri);
	});

	it("reads both timestamp forms as UTC", () => {
		const res = parseAliasVault(
			csv(
				HEADER,
				{
					ServiceName: "A",
					Username: "a",
					CreatedAt: "09/12/2025 17:28:39",
					UpdatedAt: "09/13/2025 08:00:00",
				},
				{ ServiceName: "B", Username: "b", CreatedAt: "2024-01-01 00:00:00" },
			),
		);
		expect(res.imported[0]).toMatchObject({
			createdAt: Date.UTC(2025, 8, 12, 17, 28, 39),
			updatedAt: Date.UTC(2025, 8, 13, 8, 0, 0),
		});
		expect(res.imported[1]?.createdAt).toBe(Date.UTC(2024, 0, 1));
	});

	it("leaves an unreadable timestamp unset rather than guessing", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceName: "A", Username: "a", CreatedAt: "yesterday" }),
		);
		expect(entry.createdAt).toBeUndefined();
	});

	it("doesn't roll an impossible date over into the next month", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceName: "A", Username: "a", CreatedAt: "02/30/2025 00:00:00" }),
		);
		expect(entry.createdAt).toBeUndefined();
	});

	it("names a nameless row after its host", () => {
		const entry = first<LoginEntryData>(
			csv(HEADER, { ServiceUrl: "https://forum.example.org/login", Username: "lurker" }),
		);
		expect(entry.name).toBe("forum.example.org");
	});

	it("turns each folder level into a tag", () => {
		const res = parseAliasVault(
			csv(HEADER, { ServiceName: "A", Username: "a", FolderPath: "Work/Clients" }),
		);
		expect(res.imported[0]?.tags).toEqual(["Work", "Clients"]);
		expect(res.warnings).toEqual(["1 item(s) were in an AliasVault folder, imported as tags."]);
	});
});

describe("cards", () => {
	it("maps a row with card columns to a card", () => {
		const entry = first<CardEntryData>(
			csv(HEADER, {
				ServiceName: "Visa",
				CardholderName: "Jane Doe",
				CardNumber: "4111111111111111",
				CardExpiryMonth: "03",
				CardExpiryYear: "2027",
				CardCvv: "123",
				CardPin: "0000",
				Notes: "backup card",
			}),
		);
		expect(entry).toMatchObject({
			type: "card",
			name: "Visa",
			cardholderName: "Jane Doe",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "3",
			expYear: "2027",
			cvv: "123",
			notes: "backup card",
		});
		expect(entry.customFields).toEqual([{ key: "PIN", value: "0000", hidden: true }]);
	});
});

describe("notes", () => {
	it("maps a row with only a name and notes to a note", () => {
		const entry = first<NoteEntryData>(
			csv(HEADER, { ServiceName: "Wi-Fi", Notes: "the password is on the fridge" }),
		);
		expect(entry).toMatchObject({
			type: "note",
			name: "Wi-Fi",
			notes: "the password is on the fridge",
		});
	});
});

describe("older exports", () => {
	it("reads the header without card columns, keeping the nickname", () => {
		const entry = first<LoginEntryData>(
			csv(LEGACY_HEADER, {
				ServiceName: "Old",
				Username: "olduser",
				CurrentPassword: "oldpass",
				AliasNickName: "jd",
			}),
		);
		expect(entry).toMatchObject({ type: "login", username: "olduser", password: "oldpass" });
		expect(fields(entry)).toEqual({ Nickname: "jd" });
	});

	it("keeps a column it doesn't know as a field rather than dropping it", () => {
		const entry = first<LoginEntryData>(
			csv(`${HEADER},Pronouns`, { ServiceName: "A", Username: "a", Pronouns: "they/them" }),
		);
		expect(fields(entry)).toEqual({ Pronouns: "they/them" });
	});
});

describe("file checks", () => {
	it("skips a row carrying nothing at all", () => {
		const res = parseAliasVault(csv(HEADER, {}));
		expect(res.imported).toEqual([]);
		expect(res.skipped).toBe(1);
	});

	it("rejects a file that isn't an AliasVault export", () => {
		expect(() => parseAliasVault("name,url,username,password\nX,https://x,a,b")).toThrow(
			/Google Password Manager/,
		);
	});

	it("names AliasVault when its export is picked under another provider", () => {
		expect(() => parseGooglePasswords(csv(HEADER, { ServiceName: "A" }))).toThrow(/AliasVault/);
	});
});
