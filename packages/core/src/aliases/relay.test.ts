import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayClient } from "./relay";
import { AliasError } from "./types";

afterEach(() => vi.unstubAllGlobals());

/** Install a fetch stub; returns the recorded calls. */
function route(handler: (url: string, init: RequestInit) => Response): {
	url: string;
	init: RequestInit;
}[] {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const i = init ?? {};
			calls.push({ url: String(url), init: i });
			return handler(String(url), i);
		}),
	);
	return calls;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What the client actually sent, decoded. Bodies cross the transport as UTF-8 bytes. */
function sentBody(init: RequestInit | undefined): Record<string, unknown> {
	if (!init?.body) throw new Error("no request body was sent");
	return JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
}

function only(calls: { url: string; init: RequestInit }[]): { url: string; init: RequestInit } {
	if (calls.length !== 1) throw new Error(`expected exactly 1 request, saw ${calls.length}`);
	return calls[0] as { url: string; init: RequestInit };
}

const client = (key = "key") => createRelayClient({}, key);

describe("createRelayClient", () => {
	it("returns the address the provider created", async () => {
		route(() => json({ full_address: "abc123@mozmail.com" }));
		await expect(client().create({})).resolves.toEqual({ address: "abc123@mozmail.com" });
	});

	// `Token`, not `Bearer`. Getting this wrong fails as a 401 that looks exactly like a bad key.
	it("authenticates with a Token header, not Bearer", async () => {
		const calls = route(() => json({ full_address: "a@mozmail.com" }));
		await client("secret").create({});
		expect((only(calls).init.headers as Record<string, string>).Authorization).toBe("Token secret");
	});

	it("omits ambient cookies and never follows a redirect", async () => {
		const calls = route(() => json({ full_address: "a@mozmail.com" }));
		await client().create({});
		expect(only(calls).init.credentials).toBe("omit");
		expect(only(calls).init.redirect).toBe("manual");
	});

	// `generated_for` is what makes a mask identifiable in Relay's own UI later.
	it("sends the site and description when it has them, and omits them when it does not", async () => {
		const withSite = route(() => json({ full_address: "a@mozmail.com" }));
		await client().create({ site: "example.com", description: "Bramble (example.com)" });
		expect(sentBody(only(withSite).init)).toEqual({
			enabled: true,
			generated_for: "example.com",
			description: "Bramble (example.com)",
		});

		const bare = route(() => json({ full_address: "a@mozmail.com" }));
		await client().create({});
		expect(sentBody(only(bare).init)).toEqual({ enabled: true });
	});

	it("reports the account email from the profile", async () => {
		route(() => json([{ email: "me@example.com", has_premium: true }]));
		await expect(client().verify()).resolves.toEqual({ label: "me@example.com" });
	});

	// A premium account has no cap, so reporting "used of 5" would be wrong rather than merely
	// incomplete, and counting costs a request that means nothing.
	it("does not count masks, or report a quota, for a premium account", async () => {
		const calls = route(() => json([{ email: "me@example.com", has_premium: true }]));
		const account = await client().verify();
		expect(account.quota).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("counts masks against the free allowance for a free account", async () => {
		const calls = route((url) =>
			url.includes("/profiles/")
				? json([{ email: "me@example.com", has_premium: false }])
				: json([{}, {}, {}]),
		);
		await expect(client().verify()).resolves.toEqual({
			label: "me@example.com",
			quota: { used: 3, limit: 5 },
		});
		expect(calls).toHaveLength(2);
	});

	// The profile list is the account; an empty one means the token authenticated as nobody.
	it("treats an empty profile list as an auth failure", async () => {
		route(() => json([]));
		const err = await client()
			.verify()
			.catch((e) => e);
		expect(err).toBeInstanceOf(AliasError);
		expect(err.kind).toBe("auth");
	});

	// The response has never been seen against a live account, so verify must not reject a
	// successful body it does not recognise: that would report a working key as broken.
	it("accepts a profile whose fields it does not recognise", async () => {
		route(() => json([{ something_new: 1 }]));
		await expect(client().verify()).resolves.toEqual({ label: undefined, quota: undefined });
	});

	it("strips a trailing slash from a configured base URL", async () => {
		const calls = route(() => json({ full_address: "a@mozmail.com" }));
		await createRelayClient({ baseUrl: "https://relay.example.com/" }, "k").create({});
		expect(only(calls).url).toBe("https://relay.example.com/api/v1/relayaddresses/");
	});
});
