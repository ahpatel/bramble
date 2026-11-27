/// <reference types="chrome" />

import { parseRegistry, VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { lastNormalWindow } from "../normal-window";
import { api } from "../platform-api";
import { isExtensionSender } from "../sender";
import {
	ACTIVE_VAULT_SESSION_KEY,
	CORNER_HANDOFF_KEY,
	LAST_OPENED_VAULT_KEY,
	POPOUT_ANCHOR_KEY,
} from "../session-keys";
import { extensionStorage } from "../storage";
import { getAutoLockMinutes } from "./prefs";
import { type MessageEnvelope, on } from "./router";
import { resolveActiveVaultId } from "./vek-store";
import { armViewGrace } from "./view-lock";

// In-memory only: a draft can hold a plaintext password, never persist to local.
export const POPOUT_HANDOFF_KEY = "popout.handoff";
// Id of the detached window we opened, so a later request focuses it instead of duplicating.
// storage.session (not local) survives a service-worker restart but clears on browser restart,
// which matches the lifetime of a chrome window id.
const POPOUT_WINDOW_KEY = "popout.windowId";
// Id of a pop-out opened solely to unlock (the picker's "Vault locked" row). It is a step in the
// page's fill flow, not a place the user asked to be, so it closes itself once the vault unlocks.
const POPOUT_UNLOCK_WINDOW_KEY = "popout.unlockWindowId";

/** Make the last opened vault the active one, so a view opened to unlock boots on its unlock
 * screen instead of the picker. Leaves an existing selection alone and skips a deleted vault. */
async function targetLastOpenedVault(): Promise<void> {
	try {
		if ((await resolveActiveVaultId()) !== null) return;
		const id = await extensionStorage.getMeta(LAST_OPENED_VAULT_KEY);
		if (typeof id !== "string") return;
		const reg = parseRegistry(await extensionStorage.getMeta(VAULT_REGISTRY_KEY));
		if (reg.vaults.some((v) => v.id === id)) {
			await api.storage.session.set({ [ACTIVE_VAULT_SESSION_KEY]: id });
		}
	} catch {}
}

/** The tracked pop-out window, if it is still open. Undefined when there is none: the id was
 * never stored, or the window was closed while the worker slept (windows.get rejects). */
async function trackedPopout(): Promise<chrome.windows.Window | undefined> {
	const stored = await api.storage.session.get(POPOUT_WINDOW_KEY);
	const id = stored[POPOUT_WINDOW_KEY];
	if (typeof id !== "number") return undefined;
	const win = await api.windows.get(id).catch(() => undefined);
	return win?.id === undefined ? undefined : win;
}

/** Ask the open pop-out to show the handed-over route. False when it declines (it holds a form,
 * or is on another vault) or doesn't answer. */
async function reusePopout(windowId: number, handoff: { path?: string }): Promise<boolean> {
	if (handoff.path === undefined) return false;
	const res = (await api.runtime
		.sendMessage({ type: "POPOUT_REUSE", payload: { windowId, handoff } })
		.catch(() => undefined)) as { data?: unknown } | undefined;
	return res?.data === true;
}

const WIDTH = 500;
const HEIGHT = 600;
const CHROME_INSET = 80;

/** Create the pop-out window, anchored beside `anchor` when the position is usable. Chrome rejects
 *  bounds that fall (mostly) off-screen, which used to take the whole pop-out down with them - so a
 *  rejected position (or no anchor) falls back to letting the browser place the window. */
async function createPopoutWindow(
	anchor?: chrome.windows.Window,
): Promise<chrome.windows.Window | undefined> {
	const url = api.runtime.getURL("popup.html?detached=1");
	const base = { url, type: "popup" as const, focused: true, width: WIDTH, height: HEIGHT };
	if (!anchor) return api.windows.create(base).catch(() => undefined);
	const top = (anchor.top ?? 0) + CHROME_INSET;
	const left = (anchor.left ?? 0) + (anchor.width ?? WIDTH) - WIDTH;
	const created = await api.windows.create({ ...base, top, left }).catch(() => undefined);
	if (!created) return api.windows.create(base).catch(() => undefined);
	if (created.id !== undefined) {
		// Re-assert the bounds: some platforms ignore them on create.
		await api.windows
			.update(created.id, { state: "normal", width: WIDTH, height: HEIGHT, top, left })
			.catch(() => undefined);
	}
	return created;
}

/** Open a view to unlock in, on the last opened vault: the toolbar popup (Chrome 127+), else a
 *  detached window. Returns the detached window's id, or undefined for the toolbar popup, which
 *  dismisses itself. */
export async function openUnlockView(): Promise<number | undefined> {
	await targetLastOpenedVault();
	try {
		const openPopup = (api.action as { openPopup?: () => Promise<void> }).openPopup;
		if (typeof openPopup === "function") {
			await openPopup.call(api.action);
			return undefined;
		}
	} catch {}
	return (await createPopoutWindow())?.id;
}

/** Open a detached window on app route `path` (via the boot handoff); returns its window id. */
export async function openPopoutAt(path: string): Promise<number | undefined> {
	await api.storage.session.set({ [POPOUT_HANDOFF_KEY]: { path } });
	return (await createPopoutWindow())?.id;
}

async function popoutOpen(
	message: any,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	// The popup closes as the detached window takes focus; hold "Immediate" auto-lock across
	// that gap so popping out doesn't lock the vault out from under the new window.
	armViewGrace();

	const payload = message.payload as
		| { handoff?: { draft?: unknown; path?: string; vaultId?: string }; reason?: string }
		| undefined;
	// The page dropdown's "new login" row names a reason, never a path: a page must not steer the
	// window to a route of its choosing. The form reads the site from the tab behind it (#213).
	const newLogin = payload?.reason === "new-login";
	const handoff: { draft?: unknown; path?: string; vaultId?: string } | undefined = newLogin
		? { path: "/vault/new/login" }
		: payload?.handoff;
	// The picker's "open in Bramble" row is a content-script handoff: it names only the route.
	// The open pop-out's reuse guard compares the vault it was opened for, so fill the active one
	// in here; a pop-up handoff already carries it. Other page handoffs keep their old shape.
	if (payload?.reason === "entry" && handoff && handoff.vaultId === undefined) {
		const activeVaultId = await resolveActiveVaultId().catch(() => null);
		if (activeVaultId) handoff.vaultId = activeVaultId;
	}
	// Single instance: reuse an already-open pop-out instead of spawning a duplicate. A request
	// carrying an in-flight draft is the exception - the open window consumed its boot handoff
	// once, so reusing it would silently drop the new draft (which can hold a plaintext
	// password). A route moves the open window there, if it agrees; else a new window opens.
	if (!newLogin && handoff?.draft === undefined) {
		const open = await trackedPopout();
		if (open?.id !== undefined && (!handoff || (await reusePopout(open.id, handoff)))) {
			const update: chrome.windows.UpdateInfo = { focused: true };
			if (open.state === "minimized") update.state = "normal"; // un-minimize; leave other states
			await api.windows.update(open.id, update).catch(() => undefined);
			return { ok: true };
		}
	}
	if (payload?.reason === "unlock") await targetLastOpenedVault();

	// Stash the handoff before creating the window so the new window's boot read sees it.
	if (handoff) {
		await api.storage.session.set({ [POPOUT_HANDOFF_KEY]: handoff });
	} else {
		await api.storage.session.remove([POPOUT_HANDOFF_KEY]);
	}
	// Prefer the sender's window so the pop-out lands next to the active tab.
	let anchor: chrome.windows.Window | undefined;
	if (sender.tab?.windowId !== undefined) {
		anchor = await api.windows.get(sender.tab.windowId).catch(() => undefined);
	}
	if (!anchor) {
		anchor = await api.windows.getCurrent().catch(() => undefined);
	}
	const created = await createPopoutWindow(anchor);
	if (created?.id !== undefined) {
		// Track this window so the next pop-out request focuses it rather than duplicating.
		await api.storage.session.set({ [POPOUT_WINDOW_KEY]: created.id });
		if (anchor?.id !== undefined) await api.storage.session.set({ [POPOUT_ANCHOR_KEY]: anchor.id });
		// An unlock-only pop-out closes itself once the vault opens (see closeUnlockPopout).
		if (payload?.reason === "unlock") {
			await api.storage.session.set({ [POPOUT_UNLOCK_WINDOW_KEY]: created.id });
		}
	}
	return { ok: true };
}

/**
 * Close the pop-out that was opened just to unlock, now that the vault is open: the user asked to
 * fill a form, so the window has done its job and would otherwise sit over the page. No-op for a
 * pop-out the user opened themselves. Two cases keep it open: "Immediate" auto-lock, where closing
 * the last view would re-lock the vault we just unlocked (see view-lock.ts), and a parked corner
 * capture, which the unlocking view still has to flush (and confirm) before it goes away.
 */
// `sessionCurrent` is required, not defaulted: a default of "always current" would silently
// disarm the staleness check for any future caller that forgot to pass one.
export async function closeUnlockPopout(sessionCurrent: () => boolean): Promise<void> {
	try {
		if (!sessionCurrent()) return;
		const stored = await api.storage.session.get(POPOUT_UNLOCK_WINDOW_KEY);
		if (!sessionCurrent()) return;
		const id = stored[POPOUT_UNLOCK_WINDOW_KEY];
		if (typeof id !== "number") return;
		await api.storage.session.remove([POPOUT_UNLOCK_WINDOW_KEY]);
		if ((await getAutoLockMinutes()) < 0) return;
		if (!sessionCurrent()) return;
		const parked = await api.storage.session.get(CORNER_HANDOFF_KEY);
		if (!sessionCurrent()) return;
		if (parked[CORNER_HANDOFF_KEY]) return;
		await api.windows.remove(id).catch(() => undefined);
		// It was the tracked pop-out too; drop that so the next request opens a fresh window.
		const win = await api.storage.session.get(POPOUT_WINDOW_KEY);
		if (win[POPOUT_WINDOW_KEY] === id) await api.storage.session.remove([POPOUT_WINDOW_KEY]);
	} catch {}
}

async function popoutConsumeHandoff(): Promise<MessageEnvelope> {
	// Read-and-delete one-shot: reloading the window must not re-seed a stale draft.
	let handoff: unknown = null;
	try {
		const r = await api.storage.session.get(POPOUT_HANDOFF_KEY);
		handoff = r[POPOUT_HANDOFF_KEY] ?? null;
		await api.storage.session.remove([POPOUT_HANDOFF_KEY]);
	} catch {}
	return { ok: true, data: handoff };
}

/**
 * Firefox keeps one saved size and position for all of its windows, and the pop-out overwrites
 * them each time it moves or resizes (#225). Setting a normal window to the bounds it already has
 * makes Firefox save that window's again, and nothing moves on screen. The pop-out asks for this
 * once its own bounds settle (popout-bounds.ts).
 */
async function popoutBoundsSettled(
	_message: unknown,
	sender: chrome.runtime.MessageSender,
): Promise<MessageEnvelope> {
	if (!isExtensionSender(sender)) return { ok: false, error: "forbidden" };
	const win = await lastNormalWindow();
	if (win?.id === undefined || win.state !== "normal") return { ok: true };
	const { left, top, width, height } = win;
	await api.windows.update(win.id, { left, top, width, height }).catch(() => undefined);
	return { ok: true };
}

on("POPOUT_OPEN", popoutOpen);
on("POPOUT_BOUNDS_SETTLED", popoutBoundsSettled);
on("POPOUT_CONSUME_HANDOFF", popoutConsumeHandoff);
