/** @vitest-environment happy-dom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { type EntriesPayload, type Hlc, nextCausal } from "../sync";
import { mountVault } from "../test/vault-harness";
import { withPartStamps } from "../vault/parts";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import type { EncryptedEntry } from "../vault-format";
import type { Entry } from "./useVault";

afterEach(cleanup);

// Loading with combining on (release B2): siblings that changed different parts open as one
// entry, and the combined version is written back so every device converges on it.

vi.mock("../sync/combine", async (importOriginal) => ({
	...(await importOriginal<typeof import("../sync/combine")>()),
	COMBINE_CONCURRENT_EDITS: true,
}));

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01, // SLOT_KIND_PASSWORD
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(32),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

const at = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });

/** A sealed version whose ciphertext is its plaintext, stamped the way EntryMutations stamps. */
function version(
	data: Record<string, unknown>,
	stamp: Hlc,
	prev?: { data: Record<string, unknown>; envelope: EncryptedEntry },
) {
	const held = prev ? [prev.envelope] : [];
	const causal = nextCausal({ hlc: stamp, bases: held, held });
	const { id: _id, ...stamped } = withPartStamps(
		{ id: "a", ...data } as Entry,
		prev && { data: prev.data as never, version: prev.envelope },
		stamp,
	);
	const envelope: EncryptedEntry = {
		id: "a",
		wrappedDek: "w",
		dekIv: "d",
		ciphertext: `ct:${JSON.stringify(stamped)}`,
		iv: "i",
		hlc: stamp,
		...causal,
	};
	return { data: stamped as Record<string, unknown>, envelope };
}

const base = version(
	{ type: "login", name: "A", urls: [], username: "u", password: "p", notes: "n0" },
	at(10, "laptop"),
);
const PASSWORD = version({ ...base.data, password: "px" }, at(20, "laptop"), base);
const NOTES = version({ ...base.data, notes: "ny" }, at(30, "phone"), base);

function makePlatform(initial: EntriesPayload, { failSeal = false } = {}) {
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: "vault-1", label: "", createdAt: 1 }] }],
	]);
	let disk = JSON.stringify(initial);
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		},
		crypto: {
			isLocked: async () => false,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => disk,
			encryptWithVek: async (plaintext: string) => {
				disk = plaintext;
				return { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" };
			},
			encryptEntry: async (json: string) => {
				if (failSeal) throw new Error("seal failed");
				return { ciphertext: `ct:${json}`, iv: "i", wrappedDek: "w", dekIv: "d" };
			},
			decryptEntries: async (ps: { ciphertext: string }[]) =>
				ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null)),
			lock: async () => {},
		},
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, disk: () => JSON.parse(disk) as EntriesPayload };
}

async function opened(platform: Platform) {
	const mounted = mountVault(platform);
	await waitFor(() => expect(mounted.actions().unlock).toBeTypeOf("function"));
	await mounted.actions().unlock("pw");
	await waitFor(() => expect(mounted.state().isLocked).toBe(false));
	return mounted;
}

it("loading a payload with combinable siblings shows one entry and writes it", async () => {
	const { platform, disk } = makePlatform({
		entries: [NOTES.envelope],
		tombstones: [],
		conflicts: [PASSWORD.envelope],
	});
	const { state } = await opened(platform);
	await waitFor(() => expect(state().entries).toHaveLength(1));
	expect(state().entries[0]).toMatchObject({ password: "px", notes: "ny" });
	expect(state().conflicts.size).toBe(0);
	const written = disk();
	expect(written.conflicts).toBeUndefined();
	expect(written.entries[0]!.hlc.node.startsWith("~merge:")).toBe(true);
});

it("a load whose combine fails still opens, with the conflict kept", async () => {
	const { platform, disk } = makePlatform(
		{ entries: [NOTES.envelope], tombstones: [], conflicts: [PASSWORD.envelope] },
		{ failSeal: true },
	);
	const { state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.get("a")).toEqual({ versions: 1, deleted: false }));
	expect(state().entries[0]).toMatchObject({ notes: "ny", password: "p" });
	expect(disk().conflicts).toHaveLength(1);
});
