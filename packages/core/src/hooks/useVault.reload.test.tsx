/** @vitest-environment happy-dom */
// A sync reload swaps in new stamps and new entries. Anything that reads both while the reload is
// still finishing (a write, the edit form opening a version) must see them change together, or
// it seals one version's content under another's stamp.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import type { EntriesPayload } from "../sync";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);
const VAULT_ID = "vault-1";

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01,
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
const login = (password: string, notes?: string) =>
	JSON.stringify({ type: "login", name: "A", urls: [], username: "u", password, notes });

function makePlatform(initial: EntriesPayload) {
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: VAULT_ID, label: "", createdAt: 1 }] }],
	]);
	let onChange: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	let reached: (() => void) | undefined;
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
			onExternalChange: (cb: () => void) => {
				onChange = cb;
				return () => {};
			},
			unwrapVekPassword: async () => true,
			decryptWithVek: async () => disk,
			encryptWithVek: async (plaintext: string) => {
				disk = plaintext;
				return { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" };
			},
			encryptEntry: async (json: string) => ({
				ciphertext: `ct:${json}`,
				iv: "i",
				wrappedDek: "w",
				dekIv: "d",
			}),
			decryptEntries: async (ps: { ciphertext: string }[]) =>
				ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null)),
			lock: async () => {},
		},
		autofill: {
			clearIndex: async () => {},
			setIndex: async () => {
				const g = gate;
				gate = undefined;
				if (g) {
					reached?.();
					await g;
				}
			},
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
		disk: () => JSON.parse(disk) as EntriesPayload,
		setDisk: (p: EntriesPayload) => {
			disk = JSON.stringify(p);
		},
		/** Fire an external change and resolve once loadEntries is parked in publishIndex. */
		externalChangeParked: async () => {
			let release!: () => void;
			gate = new Promise<void>((r) => {
				release = r;
			});
			const parked = new Promise<void>((r) => {
				reached = r;
			});
			onChange?.();
			await parked;
			return release;
		},
	};
}

const LAPTOP = {
	id: "a",
	wrappedDek: "w",
	dekIv: "d",
	iv: "i",
	ciphertext: `ct:${login("laptop-pw")}`,
	hlc: at(20, "laptop"),
	vv: { laptop: at(20, "laptop") },
};
const PHONE = {
	id: "a",
	wrappedDek: "w",
	dekIv: "d",
	iv: "i",
	ciphertext: `ct:${login("phone-pw", "phone note")}`,
	hlc: at(30, "phone"),
	vv: { laptop: at(20, "laptop"), phone: at(30, "phone") },
};

async function open(platform: Platform) {
	const m = mountVault(platform);
	await waitFor(() => expect(m.actions().unlock).toBeTypeOf("function"));
	await m.actions().unlock("pw");
	await waitFor(() => expect(m.state().isLocked).toBe(false));
	await waitFor(() => expect(m.state().entries.length).toBe(1));
	return m;
}

it("a version opened during a reload pairs its stamp with its own content", async () => {
	const p = makePlatform({ entries: [LAPTOP], tombstones: [] });
	const m = await open(p.platform);
	p.setDisk({ entries: [PHONE], tombstones: [] });
	const release = await p.externalChangeParked();
	const opened = m.actions().openVersion("a")!;
	release();
	expect(opened.hlc.node).toBe("phone");
	expect((opened.data as { password: string }).password).toBe("phone-pw");
});

it("a write during a reload doesn't seal the old content under the new stamp", async () => {
	const p = makePlatform({ entries: [LAPTOP], tombstones: [] });
	const m = await open(p.platform);
	p.setDisk({ entries: [PHONE], tombstones: [] });
	const release = await p.externalChangeParked();
	await m.actions().touchEntry("a");
	release();
	await waitFor(() =>
		expect((m.state().entries[0] as { password: string }).password).toBe("phone-pw"),
	);
	const [e] = p.disk().entries;
	expect(JSON.parse(e!.ciphertext.slice(3)).password).toBe("phone-pw");
});
