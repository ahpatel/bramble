import { z } from "zod";
import type { HttpTransport } from "../adapters/http";
import { requestVia } from "./http";
import type { AliasAccount, AliasClient, AliasResult } from "./types";

// DuckDuckGo Email Protection. Sends no CORS headers at all, so like Firefox Relay it is only
// reachable through the platform's native transport (see @core/adapters/http).
//
// The one provider here with no public API and no user-facing credential. DuckDuckGo documents
// neither endpoint, and the token is an internal one their own clients hold: the supported way to
// obtain it, per Bitwarden's help pages, is to open developer tools and read `authorization:
// Bearer ...` out of a network request. That has two consequences worth stating where the code
// is. The contract can change without notice, because nothing promises it; and a token acquired
// that way may be tied to a browser session rather than to the account, so "the provider rejected
// this API key" may mean "it expired" with no remedy the settings screen can name.
// See docs/email-aliases.md.

export const DUCKDUCKGO_DEFAULT_BASE_URL = "https://quack.duckduckgo.com";

export interface DuckDuckGoConfig {
	/** Not offered in the UI: hosted only. Here so a test can point somewhere else. */
	baseUrl?: string;
}

/** The domain every generated address lands on. Not configurable and not returned by the API. */
const DUCK_DOMAIN = "duck.com";

/** The local part only, hence the join below. Measured; nothing documents it. */
const CreateSchema = z.object({ address: z.string() });

/**
 * The dashboard, for the settings screen to show something recognisable.
 *
 * Every field is optional and the object is permissive because this response has never been seen:
 * no account existed to prove it against, and a `verify` that rejects an unrecognised-but-
 * successful body would report a working token as broken. The endpoint is measured to exist (an
 * unauthenticated GET answers 401 where a nonexistent path answers 404).
 */
const DashboardSchema = z
	.object({
		user: z.object({ username: z.string().optional() }).loose().optional(),
	})
	.loose();

function headers(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

export function createDuckDuckGoClient(
	cfg: DuckDuckGoConfig,
	apiKey: string,
	transport?: HttpTransport,
): AliasClient {
	const base = trimBase(cfg.baseUrl || DUCKDUCKGO_DEFAULT_BASE_URL);
	const h = headers(apiKey);
	const call = requestVia(transport);

	return {
		async verify(): Promise<AliasAccount> {
			const res = await call(`${base}/api/email/dashboard`, { headers: h }, DashboardSchema);
			// The username is the personal Duck Address's local part, so naming the whole address is
			// more recognisable than the bare handle. No quota: the service is unmetered and reports
			// no allowance, so inventing one would be worse than showing none.
			const username = res.user?.username;
			return { label: username ? `${username}@${DUCK_DOMAIN}` : undefined };
		},

		async create(): Promise<AliasResult> {
			// No body and nothing to configure. Unlike every other provider here, the request
			// carries no site and no description: the API accepts neither, so a DuckDuckGo alias is
			// not identifiable in their UI by what it was made for. That is the provider's design.
			const res = await call(
				`${base}/api/email/addresses`,
				{ method: "POST", headers: h },
				CreateSchema,
			);
			return { address: `${res.address}@${DUCK_DOMAIN}` };
		},
	};
}
