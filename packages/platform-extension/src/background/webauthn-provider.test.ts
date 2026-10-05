import { describe, expect, it, vi } from "vitest";

// The passkey-provider enabled flag: one in-memory boolean that gates both deliveries (Chrome's
// attach, Firefox's content transport). Both ways it used to end up disagreeing with reality (a
// stale startup read overwriting a newer toggle, and a failed apply leaving it claiming enabled)
// are covered here.
//
// See webauthn-proxy-init.test.ts for the attach state machine itself, and
// docs/passkey-provider.md for the spike these came out of.

const h = vi.hoisted(() => ({
	/** Router handlers the module registers, by message type. */
	handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
	/** Resolver for the pref read, so a test can hold startup mid-flight. */
	settlePref: undefined as ((enabled: boolean) => void) | undefined,
	/** Enabled values the apply hook was called with, in order. */
	applied: [] as boolean[],
	/** Whether the apply hook throws, as a failing attach() does. */
	hookThrows: false,
	/** Pref writes, as storage would see them. */
	prefWrites: [] as boolean[],
	/** Scripted active-vault id for the unlock-conflict read (null = none). */
	activeVaultId: null as string | null,
	/** Scripted slot blob: null password slot means unlock needs a WebAuthn tap. */
	vaultHasPasswordSlot: true,
	/** Optional gate: runGetCeremony/runCreateCeremony wait on it before resolving. */
	ceremonyGate: undefined as Promise<void> | undefined,
}));

vi.mock("./prefs", () => ({
	getPasskeyProviderEnabled: () =>
		new Promise<boolean>((resolve) => {
			h.settlePref = resolve;
		}),
	setPasskeyProviderEnabled: async (enabled: boolean) => {
		h.prefWrites.push(enabled);
	},
}));

vi.mock("./router", () => ({
	on: (type: string, handler: (m: unknown) => Promise<unknown>) => h.handlers.set(type, handler),
}));

vi.mock("../platform-api", () => ({
	api: {
		runtime: { sendMessage: async () => {} },
		tabs: { query: async () => [], sendMessage: async () => {} },
		action: {},
		windows: { create: async () => ({ id: 1 }), remove: async () => {} },
	},
}));

vi.mock("./passkey-store", () => ({
	loadDecryptedEntries: async () => [],
	passkeyGetAssertion: async () => ({ authenticatorData: "", signature: "" }),
	passkeyMakeCredential: async () => ({}),
	savePlacement: async () => {},
}));

vi.mock("./session", () => ({
	vaultLocked: () => false,
	getActiveVaultId: () => h.activeVaultId,
}));

vi.mock("./vault-io", () => ({
	readAndDecodeVault: async () => ({
		slots: h.vaultHasPasswordSlot ? [{ kind: "password" }] : [{ kind: "webauthn" }],
		entriesIv: new Uint8Array(),
		entriesCiphertext: new Uint8Array(),
	}),
}));

vi.mock("@core/vault-format", () => ({
	findUnlockPasswordSlot: (blob: { slots: { kind: string }[] }) =>
		blob.slots.find((s) => s.kind === "password") ?? null,
}));

vi.mock("./webauthn-proxy", () => ({
	runCreateCeremony: vi.fn(async () => {
		if (h.ceremonyGate) await h.ceremonyGate;
		return { approved: false };
	}),
	runGetCeremony: vi.fn(async () => {
		if (h.ceremonyGate) await h.ceremonyGate;
		return { approved: false };
	}),
}));

async function load() {
	vi.resetModules();
	h.handlers.clear();
	h.settlePref = undefined;
	h.applied = [];
	h.hookThrows = false;
	h.prefWrites = [];
	h.activeVaultId = null;
	h.vaultHasPasswordSlot = true;
	h.ceremonyGate = undefined;
	const mod = await import("./webauthn-provider");
	mod.setProviderApplyHook(async (enabled) => {
		h.applied.push(enabled);
		if (h.hookThrows) throw new Error("attach failed: another extension is attached");
	});
	return mod;
}

/** Drive the settings toggle, as GeneralSection does through the shell. */
const setEnabled = (enabled: boolean) =>
	h.handlers.get("PASSKEY_PROVIDER_SET_ENABLED")?.({ payload: { enabled } });

describe("the provider enabled flag", () => {
	it("defaults to off, because attaching intercepts all browser WebAuthn", async () => {
		const m = await load();
		expect(m.isProviderEnabled()).toBe(false);
	});

	it("enables, runs the apply hook, and disables again", async () => {
		const m = await load();
		await setEnabled(true);
		expect(m.isProviderEnabled()).toBe(true);
		await setEnabled(false);
		expect(m.isProviderEnabled()).toBe(false);
		expect(h.applied).toEqual([true, false]);
	});

	it("keeps an explicit toggle when a slower startup read lands afterwards", async () => {
		// The load is now part of the hydration barrier the router gates dispatch on, so this
		// ordering should not arise; the module refuses it anyway, in case a future caller reads
		// the pref off that path.
		const m = await load();
		const startup = m.loadProviderEnabled(); // read pending

		await setEnabled(true); // user turns it on
		expect(m.isProviderEnabled()).toBe(true);

		h.settlePref?.(false); // the stale read finally lands
		await startup;

		expect(m.isProviderEnabled()).toBe(true); // the user's choice survives
		expect(h.applied).toEqual([true]);
	});

	it("still takes the stored value when the user has not toggled", async () => {
		const m = await load();
		const startup = m.loadProviderEnabled();
		h.settlePref?.(true);
		await startup;
		expect(m.isProviderEnabled()).toBe(true);
	});

	it("rolls the flag back when the apply hook fails", async () => {
		// Chrome's attach() fails outright if another extension holds the proxy. Leaving the flag
		// on would claim we are the provider with nothing attached, and on Firefox that flag alone
		// gates the transport.
		const m = await load();
		h.hookThrows = true;
		await expect(setEnabled(true)).rejects.toThrow(/another extension is attached/);
		expect(m.isProviderEnabled()).toBe(false);
	});

	it("rolls back to the previous value, not to off", async () => {
		const m = await load();
		await setEnabled(true);
		h.hookThrows = true;
		await expect(setEnabled(false)).rejects.toThrow();
		expect(m.isProviderEnabled()).toBe(true);
	});
});

describe("the native-fallback disable (a card's 'use another authenticator' click)", () => {
	it("turns the flag off, persists the pref off, and applies the hook off", async () => {
		const m = await load();
		await setEnabled(true);
		await m.disableProviderForNativeFallback();
		expect(m.isProviderEnabled()).toBe(false);
		expect(h.prefWrites).toEqual([false]); // the Settings toggle's exact write
		expect(h.applied).toEqual([true, false]); // detach, after the request completed
	});

	it("keeps the pref off even when the detach hook fails", async () => {
		// The pref is the durable state; a failed detach self-heals on the next toggle and
		// the off flag already passes requests through.
		const m = await load();
		await setEnabled(true);
		h.hookThrows = true;
		await m.disableProviderForNativeFallback();
		expect(m.isProviderEnabled()).toBe(false);
		expect(h.prefWrites).toEqual([false]);
	});
});

describe("the ceremony state the unlock screen asks about", () => {
	it("reports inactive while no page ceremony runs", async () => {
		await load();
		const res = (await h.handlers.get("PASSKEY_CEREMONY_QUERY")?.({})) as {
			ok: boolean;
			data: { active: boolean };
		};
		expect(res).toEqual({ ok: true, data: { active: false } });
	});

	it("reports active for the WHOLE ceremony, including while it awaits the user", async () => {
		// Regression: the ceremony return used to skip `await`, so the finally block
		// decremented the depth at the same tick it incremented it, and this query
		// answered `false` for the entire ceremony. The unlock screen's steer-away
		// (security key / biometric hidden while a page request waits) keyed off it.
		const m = await load();
		let release!: () => void;
		h.ceremonyGate = new Promise<void>((r) => {
			release = r;
		});
		const deps = m.depsForTab(3); // explicit tab: no activeTabId round-trip needed
		const done = deps.ceremony({
			kind: "get",
			rpId: "example.com",
			origin: "https://example.com",
		});
		const query = async (): Promise<boolean> => {
			const res = (await h.handlers.get("PASSKEY_CEREMONY_QUERY")?.({})) as
				| { data?: { active?: boolean } }
				| undefined;
			return res?.data?.active === true;
		};
		await expect.poll(query, { timeout: 2_000 }).toBe(true); // live mid-ceremony
		release();
		expect(await done).toEqual({ approved: false });
		await expect.poll(query).toBe(false); // and closed out afterwards
	});
});
