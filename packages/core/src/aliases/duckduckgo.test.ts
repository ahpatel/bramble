import { afterEach, describe, expect, it, vi } from "vitest";
import { createDuckDuckGoClient } from "./duckduckgo";

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

function only(calls: { url: string; init: RequestInit }[]): { url: string; init: RequestInit } {
	if (calls.length !== 1) throw new Error(`expected exactly 1 request, saw ${calls.length}`);
	return calls[0] as { url: string; init: RequestInit };
}

const client = (key = "key") => createDuckDuckGoClient({}, key);

describe("createDuckDuckGoClient", () => {
	// The API returns the local part only; the domain is fixed and not in the response.
	it("joins the returned local part onto duck.com", async () => {
		route(() => json({ address: "amaze-gem-spider" }));
		await expect(client().create({})).resolves.toEqual({
			address: "amaze-gem-spider@duck.com",
		});
	});

	it("authenticates with a Bearer token", async () => {
		const calls = route(() => json({ address: "x" }));
		await client("secret").create({});
		expect((only(calls).init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret",
		);
	});

	it("omits ambient cookies and never follows a redirect", async () => {
		const calls = route(() => json({ address: "x" }));
		await client().create({});
		expect(only(calls).init.credentials).toBe("omit");
		expect(only(calls).init.redirect).toBe("manual");
	});

	// The API accepts neither a site nor a description, so a DuckDuckGo alias is not identifiable
	// in their UI by what it was made for. Sending one anyway would be inventing a contract.
	it("sends no body at all, even when the caller supplies a site and description", async () => {
		const calls = route(() => json({ address: "x" }));
		await client().create({ site: "example.com", description: "Bramble (example.com)" });
		expect(only(calls).init.method).toBe("POST");
		expect(only(calls).init.body).toBeUndefined();
	});

	// #123: the token users copy (the access token on the address request) is refused by the
	// dashboard with 401 invalid_token, since the dashboard takes the login token, and listing
	// addresses is a 404. Only creating an address proves the token, so a check sends nothing.
	it("checks nothing over the network, and says so", async () => {
		const calls = route(() => json({}));
		await expect(client().verify()).resolves.toEqual({ unchecked: true });
		expect(calls).toHaveLength(0);
	});

	it("strips a trailing slash from a configured base URL", async () => {
		const calls = route(() => json({ address: "x" }));
		await createDuckDuckGoClient({ baseUrl: "https://quack.example.com/" }, "k").create({});
		expect(only(calls).url).toBe("https://quack.example.com/api/email/addresses");
	});
});
