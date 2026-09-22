import { z } from "zod";
import type { HttpTransport } from "../adapters/http";
import { requestVia } from "./http";
import {
	type AliasAccount,
	type AliasClient,
	AliasError,
	type AliasRequest,
	type AliasResult,
} from "./types";

// Firefox Relay. Not self-hostable and sends no CORS headers at all, so unlike Addy and
// SimpleLogin it is only reachable through the platform's native transport (see
// @core/adapters/http). See docs/email-aliases.md.

export const RELAY_DEFAULT_BASE_URL = "https://relay.firefox.com";

export interface RelayConfig {
	/** Not offered in the UI: Relay is hosted only. Here so a test can point somewhere else. */
	baseUrl?: string;
}

/** The address is `full_address`; the rest of the record is not ours to care about. */
const CreateSchema = z.object({ full_address: z.string() });

/**
 * The account, for the settings screen to show something recognisable.
 *
 * Every field is optional because this response has never been seen: no account existed to prove
 * it against, and a `verify` that rejects an unrecognised-but-successful body would report a
 * working key as broken. The endpoint itself is measured (an unauthenticated GET answers 401, and
 * a nonexistent path answers 404), so the call is known to reach something real.
 */
const ProfileSchema = z.array(
	z.object({
		// Free accounts cap masks; premium does not. Both halves or neither, as Addy's quota does.
		has_premium: z.boolean().optional(),
		email: z.string().optional(),
	}),
);

/** A free account's mask allowance. Relay's own limit, not ours, and not reported by the API. */
const FREE_MASK_LIMIT = 5;

const AddressesSchema = z.array(z.object({}).loose());

/**
 * `Token`, not `Bearer`. Getting this wrong fails as a 401 that looks exactly like a bad key.
 */
function headers(key: string): Record<string, string> {
	return {
		Authorization: `Token ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

export function createRelayClient(
	cfg: RelayConfig,
	apiKey: string,
	transport?: HttpTransport,
): AliasClient {
	const base = trimBase(cfg.baseUrl || RELAY_DEFAULT_BASE_URL);
	const h = headers(apiKey);
	const call = requestVia(transport);

	return {
		async verify(): Promise<AliasAccount> {
			const profiles = await call(`${base}/api/v1/profiles/`, { headers: h }, ProfileSchema);
			const me = profiles[0];
			if (!me) {
				throw new AliasError("auth", "This key does not belong to a Relay account.");
			}
			// A premium account has no cap, so reporting "used of 5" would be wrong rather than
			// merely incomplete. Counting costs a second request and only means something on free.
			let quota: AliasAccount["quota"];
			if (me.has_premium === false) {
				const used = await call(
					`${base}/api/v1/relayaddresses/`,
					{ headers: h },
					AddressesSchema,
				).catch(() => null);
				if (used) quota = { used: used.length, limit: FREE_MASK_LIMIT };
			}
			return { label: me.email, quota };
		},

		async create(req: AliasRequest): Promise<AliasResult> {
			const res = await call(
				`${base}/api/v1/relayaddresses/`,
				{
					method: "POST",
					headers: h,
					// `generated_for` is the site, which is what makes a mask identifiable in Relay's
					// own UI later. `enabled` is stated rather than left to default so a new mask
					// forwards mail immediately.
					body: {
						enabled: true,
						...(req.site ? { generated_for: req.site } : {}),
						...(req.description ? { description: req.description } : {}),
					},
				},
				CreateSchema,
			);
			return { address: res.full_address };
		},
	};
}
