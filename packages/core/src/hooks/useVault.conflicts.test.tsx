/** @vitest-environment happy-dom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import type { EntriesPayload } from "../sync";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { ConflictChangedError } from "./useVault";

afterEach(cleanup);

// The vault's in-memory state carries sibling versions and causal history alongside the entries
// (docs/sync-conflicts.md). It has to load them, expose the conflicts, and drop them whenever the
// vault closes, or one session's siblings get written into the next one's blob.

const VAULT_ID = "vault-1";

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

const at = (wall: number, node: string) => ({ wall, counter: 0, node });
const sealed = (ciphertext: string, wall: number, node: string) => ({
	id: "a",
	wrappedDek: "w",
	dekIv: "d",
	ciphertext,
	iv: "i",
	hlc: at(wall, node),
	vv: { [node]: at(wall, node) },
});
const SHOWN = sealed("shown", 20, "laptop");
const SIBLING = sealed("sibling", 10, "phone");
const PLAINTEXT: Record<string, string> = {
	shown: JSON.stringify({
		type: "login",
		name: "A",
		urls: [],
		username: "u",
		password: "shown-pw",
	}),
	sibling: JSON.stringify({
		type: "login",
		name: "A",
		urls: [],
		username: "u",
		password: "sib-pw",
	}),
	probe: "{}",
};

function makePlatform(initial: EntriesPayload) {
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] }],
	]);
	const indexed: unknown[] = [];
	let externalLock: (() => void) | undefined;
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
			onExternalLock: (cb: () => void) => {
				externalLock = cb;
				return () => {};
			},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => disk,
			encryptWithVek: async (plaintext: string) => {
				disk = plaintext;
				return { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" };
			},
			encryptEntry: async () => ({ ciphertext: "probe", iv: "i", wrappedDek: "w", dekIv: "d" }),
			decryptEntries: async (ps: { ciphertext: string }[]) =>
				ps.map((p) => PLAINTEXT[p.ciphertext] ?? null),
			lock: async () => {},
		},
		autofill: {
			clearIndex: async () => {},
			setIndex: async (entries: unknown) => void indexed.push(entries),
		},
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return {
		platform,
		indexed,
		disk: () => JSON.parse(disk) as EntriesPayload,
		setDisk: (p: EntriesPayload) => {
			disk = JSON.stringify(p);
		},
		externalLock: () => externalLock?.(),
	};
}

async function opened(platform: Platform) {
	const mounted = mountVault(platform);
	await waitFor(() => expect(mounted.actions().unlock).toBeTypeOf("function"));
	await mounted.actions().unlock("pw");
	await waitFor(() => expect(mounted.state().isLocked).toBe(false));
	return mounted;
}

it("loading a payload with a conflict exposes it", async () => {
	const { platform } = makePlatform({ entries: [SHOWN], tombstones: [], conflicts: [SIBLING] });
	const { state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.get("a")).toEqual({ versions: 1, deleted: false }));
});

it("a stored payload with siblings but no displayed version is canonicalized on load", async () => {
	const { platform } = makePlatform({ entries: [], tombstones: [], conflicts: [SHOWN, SIBLING] });
	const { state } = await opened(platform);
	await waitFor(() => expect(state().entries.map((e) => e.id)).toEqual(["a"]));
	expect(state().conflicts.get("a")).toEqual({ versions: 1, deleted: false });
});

it("locking clears conflicts", async () => {
	const { platform } = makePlatform({ entries: [SHOWN], tombstones: [], conflicts: [SIBLING] });
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	await actions().lock();
	await waitFor(() => expect(state().conflicts.size).toBe(0));
});

it("an auto-lock clears conflicts too", async () => {
	const { platform, externalLock } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING],
	});
	const { state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	externalLock();
	await waitFor(() => expect(state().conflicts.size).toBe(0));
});

it("reopening clears conflicts and causal state from before", async () => {
	const { platform, disk, setDisk } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING],
	});
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	await actions().lock();
	setDisk({ entries: [], tombstones: [] });
	await actions().unlock("pw");
	await waitFor(() => expect(state().isLocked).toBe(false));
	await actions().addEntry({ type: "note", name: "fresh" });
	expect(disk().conflicts).toBeUndefined();
	expect(disk().entries.map((e) => e.id)).not.toContain("a");
});

it("the autofill index holds only displayed versions", async () => {
	const { platform, indexed } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING],
	});
	await opened(platform);
	await waitFor(() => expect(indexed.length).toBeGreaterThan(0));
	expect(JSON.stringify(indexed)).toContain("shown-pw");
	expect(JSON.stringify(indexed)).not.toContain("sib-pw");
});

it("readConflictVersions decrypts every sibling, newest first", async () => {
	const newer = { ...sealed("sibling", 15, "tablet") };
	const { platform } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING, newer],
	});
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	const versions = await actions().readConflictVersions("a");
	expect(versions.map((v) => v.hlc.wall)).toEqual([15, 10]);
	expect(versions[0]!.data).toMatchObject({ type: "login", password: "sib-pw" });
});

it("resolveConflict writes the chosen sibling and clears the conflict", async () => {
	const { platform, disk } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING],
	});
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	await actions().resolveConflict("a", { kind: "use", hlc: SIBLING.hlc, seen: [SIBLING.hlc] });
	await waitFor(() => expect(state().conflicts.size).toBe(0));
	expect(state().entries[0]).toMatchObject({ id: "a", password: "sib-pw" });
	expect(disk().conflicts).toBeUndefined();
});

// A sync can land while the user compares; a resolution must not supersede versions they never
// saw (final review, finding B4).
it("resolveConflict refuses when the versions changed since the user looked", async () => {
	const { platform, disk } = makePlatform({
		entries: [SHOWN],
		tombstones: [],
		conflicts: [SIBLING],
	});
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	await expect(actions().resolveConflict("a", { kind: "keep", seen: [] })).rejects.toBeInstanceOf(
		ConflictChangedError,
	);
	expect(state().conflicts.size).toBe(1);
	expect(disk().conflicts).toHaveLength(1);
});

it("keeping the shown version keeps the other version's password in the changelog", async () => {
	const { platform } = makePlatform({ entries: [SHOWN], tombstones: [], conflicts: [SIBLING] });
	const { actions, state } = await opened(platform);
	await waitFor(() => expect(state().conflicts.size).toBe(1));
	await actions().resolveConflict("a", { kind: "keep", seen: [SIBLING.hlc] });
	await waitFor(() => expect(state().conflicts.size).toBe(0));
	expect(state().entries[0]).toMatchObject({
		password: "shown-pw",
		passwordChangelog: [expect.objectContaining({ value: "sib-pw" })],
	});
});
