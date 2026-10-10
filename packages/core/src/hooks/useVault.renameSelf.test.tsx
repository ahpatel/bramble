/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import type { RosterEntry, RosterPayload } from "../sync";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// Renaming your own device. The whole point is the constraint that shapes it: only the owning
// device can rename itself, because winning the last-writer-wins merge takes a fresh stamp, the
// stamp is inside the signed canonical, and only the owner holds the signing key. So the test
// watches for exactly that: a re-stamped, re-signed entry, written without trampling a
// concurrent writer, and never touching a peer's entry.

const DEVICE_ID = "device-1";
const OWN_PUB = "b3duLXB1g==";
const GROUP_KEY = "sync.group:v1";
const NEW_NAME = "MacBook Pro office";

/** A roster holding this device plus a peer, signed like the backfill left it. */
function roster(ownWall = 1000): RosterPayload {
	const own: RosterEntry = {
		id: DEVICE_ID,
		publicKey: OWN_PUB,
		label: "This device",
		addedAt: 1,
		hlc: { wall: ownWall, counter: 0, node: DEVICE_ID },
		sigKey: "b2xkLWtleQ==",
		sig: "b2xkLXNpZw==",
	};
	const peer: RosterEntry = {
		id: "device-2",
		publicKey: "cGVlci1wdWI=",
		label: "Phone",
		addedAt: 2,
		hlc: { wall: 1001, counter: 0, node: "device-2" },
	};
	return { devices: [own, peer], revoked: [] };
}

function makePlatform(
	over: {
		group?: { groupKey: string; roster: RosterPayload } | null;
		/** Mutate the stored entry while the first signature is in flight. */
		raceOnFirstSign?: boolean;
		/** Drop this device's entry from the stored roster entirely. */
		missingSelf?: boolean;
	} = {},
) {
	let group = over.group === undefined ? { groupKey: "Z2s=", roster: roster() } : over.group;
	const writes: Array<{ key: string; value: unknown }> = [];
	// Reads hand out copies, so a snapshot taken before the signing round trip does not silently
	// track a write that lands during it. That is the shape of the race under test.
	const copy = <T,>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T));
	const storage = {
		hasVaultHandle: vi.fn(async () => true),
		getMeta: vi.fn(async (k: string) => {
			if (k === VAULT_REGISTRY_KEY) return { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
			if (k === GROUP_KEY) return copy(group) ?? undefined;
			if (k === "sync.deviceId:v1") return DEVICE_ID;
			return undefined;
		}),
		setMeta: vi.fn(async (key: string, value: unknown) => {
			writes.push({ key, value: copy(value) });
			if (key === GROUP_KEY) group = value as typeof group;
		}),
		readVaultBlob: vi.fn(async () => new Uint8Array([1])),
		writeVaultBlob: vi.fn(async () => {}),
		restoreVaultFromBackup: vi.fn(async () => false),
	};
	const crypto = {
		isLocked: vi.fn(async () => false),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
		decryptEntries: vi.fn(async () => []),
		decryptWithVek: vi.fn(async () => JSON.stringify({ entries: [], tombstones: [] })),
	};
	const signRoster = vi.fn(async () => {
		// A concurrent writer landing inside the host round trip: the signature backfill (or an
		// admission-key publish) re-stamping this same entry while the rename waits for its sig.
		if (over.raceOnFirstSign && signRoster.mock.calls.length === 1 && group) {
			const own = group.roster.devices.find((d) => d.publicKey === OWN_PUB);
			if (own) {
				own.admissionKey = "YWRtaXNzaW9u";
				own.hlc = { ...own.hlc, wall: own.hlc.wall + 1 };
			}
		}
		return "bmV3LXNpZw==";
	});
	const syncDevicePublicKey = vi.fn(async () => OWN_PUB);
	const shell = {
		setActiveVault: vi.fn(async () => {}),
		getActiveVault: vi.fn(async () => "v1"),
		flushPendingCornerCapture: vi.fn(async () => {}),
		stopSyncSpike: vi.fn(async () => {}),
		syncDevicePublicKey,
		syncSigningPublicKey: vi.fn(async () => "bmV3LWtleQ=="),
		signRoster,
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
		shell,
		clipboard: {},
	} as unknown as Platform;
	return { platform, writes, signRoster, syncDevicePublicKey };
}

/** The roster this run wrote back, or null when it never wrote one. */
function writtenRoster(writes: Array<{ key: string; value: unknown }>): RosterPayload | null {
	const last = writes.filter((w) => w.key === GROUP_KEY).at(-1);
	return last ? (last.value as { roster: RosterPayload }).roster : null;
}

/** Mount unlocked and let the post-unlock effects settle. */
async function mount(platform: Platform) {
	const actions = mountVaultActions(platform);
	await act(async () => {});
	await act(async () => {});
	return actions;
}

describe("renameSelf", () => {
	it("re-stamps and re-signs the own entry, keeping the rest of the roster", async () => {
		const { platform, writes } = makePlatform();
		const actions = await mount(platform);

		await act(async () => {
			await actions().renameSelf(NEW_NAME);
		});

		const written = writtenRoster(writes);
		const own = written?.devices.find((d) => d.publicKey === OWN_PUB);
		expect(own?.label).toBe(NEW_NAME);
		// A fresh stamp is what lets the rename win the merge against the stale copy every peer
		// still holds; and the sig over the NEW canonical comes from this device's key.
		expect(own?.hlc.wall).toBeGreaterThan(1000);
		expect(own?.sig).toBe("bmV3LXNpZw==");
		expect(own?.sigKey).toBe("bmV3LWtleQ==");
		// The merge cannot lose the peer in the process.
		expect(written?.devices.some((d) => d.id === "device-2")).toBe(true);
	});

	it("does nothing when this device is in no group, and does not ask the host for a key", async () => {
		const { platform, writes, signRoster, syncDevicePublicKey } = makePlatform({ group: null });
		const actions = await mount(platform);

		await act(async () => {
			await actions().renameSelf(NEW_NAME);
		});

		expect(writtenRoster(writes)).toBeNull();
		expect(signRoster).not.toHaveBeenCalled();
		// Asking the host for the device key GENERATES AND PERSISTS a Noise keypair when there is
		// none, so a vault that never syncs must not be asked at all (same rule as the backfill).
		expect(syncDevicePublicKey).not.toHaveBeenCalled();
	});

	it("does nothing when this device has no entry in the roster", async () => {
		// The panel can be open while a revocation lands from a peer.
		const { platform, writes, signRoster } = makePlatform({
			group: { groupKey: "Z2s=", roster: { devices: roster().devices.slice(1), revoked: [] } },
			missingSelf: true,
		});
		const actions = await mount(platform);

		await act(async () => {
			await actions().renameSelf(NEW_NAME);
		});

		expect(writtenRoster(writes)).toBeNull();
		expect(signRoster).not.toHaveBeenCalled();
	});

	it("refuses an empty name without touching the roster", async () => {
		const { platform, writes, signRoster } = makePlatform();
		const actions = await mount(platform);

		await act(async () => {
			await expect(actions().renameSelf("   ")).rejects.toThrow();
		});

		expect(writtenRoster(writes)).toBeNull();
		expect(signRoster).not.toHaveBeenCalled();
	});

	it("preserves a concurrent change to the same entry instead of overwriting it", async () => {
		// The signing round trip is a window in which the backfill or an admission-key publish can
		// re-stamp this same entry. The rename must not write its stale body back (it would win the
		// merge and drop the field the other writer added): it detects the change via the canonical
		// and retries on the newer version, so BOTH changes survive.
		const { platform, writes, signRoster } = makePlatform({ raceOnFirstSign: true });
		const actions = await mount(platform);

		await act(async () => {
			await actions().renameSelf(NEW_NAME);
		});

		expect(signRoster).toHaveBeenCalledTimes(2);
		const own = writtenRoster(writes)?.devices.find((d) => d.publicKey === OWN_PUB);
		expect(own?.label).toBe(NEW_NAME);
		expect(own?.admissionKey, "the concurrent write survived").toBe("YWRtaXNzaW9u");
	});

	it("is a no-op when the device is already named that, so retries do not churn stamps", async () => {
		const { platform, writes, signRoster } = makePlatform({
			group: {
				groupKey: "Z2s=",
				roster: {
					...roster(),
					devices: [{ ...roster().devices[0]!, label: NEW_NAME }, ...roster().devices.slice(1)],
				},
			},
		});
		const actions = await mount(platform);

		await act(async () => {
			await actions().renameSelf(NEW_NAME);
		});

		expect(signRoster).not.toHaveBeenCalled();
		expect(writtenRoster(writes)).toBeNull();
	});
});
