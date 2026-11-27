import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AckBodySchema,
	accountFromFragment,
	accountPageUrl,
	BLOB_HASH_RE,
	canonicalRequest,
	EMPTY_SHA256,
	INBOX_PAGE,
	InboxResponseSchema,
	MAILBOX_ID_RE,
	MAX_LIST,
	MESSAGE_ID_RE,
	PostMessageQuerySchema,
	parseAccountNumber,
	ReplacesBodySchema,
	SIG_KEY_RE,
	sha256Hex,
} from "./protocol";

describe("SIG_KEY_RE", () => {
	it("accepts only the canonical spelling of a key", () => {
		const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
		expect(SIG_KEY_RE.test(key)).toBe(true);
		expect(SIG_KEY_RE.test(`${key.slice(0, 42)}B=`)).toBe(false);
	});
});

describe("canonicalRequest", () => {
	it("joins domain, upper-cased method, path with query, time and body hash with newlines", () => {
		expect(
			canonicalRequest({
				method: "post",
				pathAndQuery: "/v1/mailboxes/abc/acks?x=1",
				time: 1730000000000,
				contentSha256: EMPTY_SHA256,
			}),
		).toBe(`bramble-mailbox/v1\nPOST\n/v1/mailboxes/abc/acks?x=1\n1730000000000\n${EMPTY_SHA256}`);
	});
});

describe("sha256Hex", () => {
	it("hashes the empty input to EMPTY_SHA256 and 'abc' to the known digest", async () => {
		expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("id patterns", () => {
	it("accept well-formed ids and refuse path-shaped ones", () => {
		expect(MAILBOX_ID_RE.test("A".repeat(43))).toBe(true);
		expect(MAILBOX_ID_RE.test(`${"A".repeat(41)}/.`)).toBe(false);
		expect(MESSAGE_ID_RE.test("../../../../etc/passwd")).toBe(false);
		expect(BLOB_HASH_RE.test("A".repeat(64))).toBe(false);
		expect(SIG_KEY_RE.test(`${"A".repeat(43)}=`)).toBe(true);
	});
});

describe("schemas", () => {
	it("default AckBody lists to empty and cap them at MAX_LIST", () => {
		expect(AckBodySchema.parse({})).toEqual({ messages: [], blobs: [], markers: [] });
		expect(
			AckBodySchema.safeParse({ messages: Array(MAX_LIST + 1).fill("A".repeat(22)) }).success,
		).toBe(false);
	});

	it("read a post's query: `to` is a comma-separated key list and may not be empty", () => {
		const key = `${"A".repeat(43)}=`;
		const id = "A".repeat(22);
		expect(PostMessageQuerySchema.parse({ id, to: `${key},${key}` })).toEqual({
			id,
			to: [key, key],
		});
		expect(PostMessageQuerySchema.parse({ id })).toEqual({ id });
		expect(PostMessageQuerySchema.safeParse({ id, to: "" }).success).toBe(false);
		expect(PostMessageQuerySchema.safeParse({ id, to: "not-a-key" }).success).toBe(false);
	});

	it("need at least one id to replace", () => {
		expect(ReplacesBodySchema.safeParse({ replaces: [] }).success).toBe(false);
	});
});

describe("account numbers", () => {
	it("reads 25 digits however they are spaced or dashed", () => {
		expect(parseAccountNumber(" 12345-67890 12345\n67890\t12345 ")).toBe(
			"12345 67890 12345 67890 12345",
		);
	});
	it("refuses anything but 25 digits", () => {
		for (const bad of [
			"",
			"123456789012345678901234",
			"12345678901234567890123456",
			"12345 67890 12345 67890 1234x",
		])
			expect(parseAccountNumber(bad)).toBeNull();
	});
	it("carries the number to the account page in the fragment only", () => {
		const url = new URL(accountPageUrl("12345 67890 12345 67890 12345"));
		expect(`${url.origin}${url.pathname}`).toBe("https://bramble.sh/account");
		expect(url.search).toBe("");
		expect(url.hash).toBe("#n=1234567890123456789012345");
		expect(accountFromFragment(url.hash)).toBe("12345 67890 12345 67890 12345");
		expect(accountPageUrl()).toBe("https://bramble.sh/account");
	});
	it("finds no account in any other fragment", () => {
		for (const hash of ["", "#", "#top", "#n=123", "#x=1234567890123456789012345"])
			expect(accountFromFragment(hash)).toBeNull();
	});
});

describe("InboxResponseSchema", () => {
	const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
	const page = (n: number) => ({
		messages: Array.from({ length: n }, (_, i) => ({
			id: `${i}`.padStart(22, "a"),
			sender: key,
			size: 1,
			createdAt: 0,
		})),
		blobs: Array.from({ length: n }, (_, i) => ({
			hash: i.toString(16).padStart(64, "0"),
			size: 1,
			uploader: key,
			createdAt: 0,
		})),
		wanted: Array.from({ length: n }, (_, i) => ({
			hash: i.toString(16).padStart(64, "0"),
			by: [key],
		})),
		wantedMore: false,
		markers: Array.from({ length: n }, (_, i) => ({
			id: i + 1,
			sender: key,
			count: 1,
			expiredAt: 0,
		})),
		more: false,
		retentionDays: 365,
		usedBytes: 0,
		quotaBytes: null,
		serverTime: 0,
	});

	it("an honest server's full page still parses", () => {
		expect(InboxResponseSchema.safeParse(page(INBOX_PAGE)).success).toBe(true);
	});

	it("an inbox list longer than INBOX_PAGE is refused", () => {
		expect(InboxResponseSchema.safeParse(page(INBOX_PAGE + 1)).success).toBe(false);
	});
});

describe("the hosted addresses", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("are Bramble's own in every build but a sandbox one", async () => {
		const p = await import("./protocol");
		expect(p.HOSTED_MAILBOX_URL).toBe("https://mailbox.bramble.sh");
		expect(p.ACCOUNT_PAGE_URL).toBe("https://bramble.sh/account");
	});

	it("are the sandbox mailbox and the local website in a --mode sandbox build", async () => {
		vi.stubEnv("MODE", "sandbox");
		vi.resetModules();
		const p = await import("./protocol");
		expect(p.HOSTED_MAILBOX_URL).toBe("https://mailbox-sandbox.bramble.sh");
		expect(p.ACCOUNT_PAGE_URL).toBe("https://sandbox.bramble-website-chc.pages.dev/account");
	});
});
