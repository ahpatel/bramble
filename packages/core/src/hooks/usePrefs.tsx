import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { type AliasConfig, isAliasConfig } from "../aliases";
import { type AppUpdateState, normalizeAppUpdateState } from "../app/app-update";
import {
	freshReviewNudgeState,
	normalizeReviewNudgeState,
	type ReviewNudgeState,
} from "../app/review-nudge";
import { DEFAULT_SEARCH, isSortKey, type SortKey } from "../app/screens/VaultHome/vault-search";
import { normalizeSupportAskState, type SupportAskState } from "../app/support-ask";
import { normalizeWhatsNewState, PREF_WHATS_NEW, type WhatsNewState } from "../app/whats-new";
import { usePlatform } from "../context/PlatformContext";
import {
	MAILBOX_ACCOUNT_PREF_KEY,
	MAILBOX_OFF_PREF_KEY,
	MAILBOX_PREF_KEY,
	type MailboxConfig,
	MailboxConfigSchema,
} from "../sync/mailbox/config";
import { parseAccountNumber } from "../sync/mailbox/protocol";
import { syncKeyFor } from "../sync/sync-keys";
import {
	type AutofillDensity,
	DEFAULT_AUTOFILL_DENSITY,
	normalizeAutofillDensity,
} from "../util/autofill-density";
import {
	type AutofillTrigger,
	DEFAULT_AUTOFILL_TRIGGER,
	normalizeAutofillTrigger,
} from "../util/autofill-trigger";
import {
	DEFAULT_GENERATOR_SETTINGS,
	type GeneratorSettings,
	normalizeGeneratorSettings,
} from "../util/password-gen";
import { useSyncedSettings } from "./synced-settings";
import { useVaultRegistry } from "./useVaultRegistry";

// Preference keys persisted via StorageAdapter.getMeta/setMeta. Mirrored in
// background.ts for the auto-lock + clipboard TTL values the SW reads itself.
export const PREF_AUTOLOCK_MINUTES = "pref.autoLockMinutes";
const PREF_BREACH_CHECK = "pref.breachCheckEnabled";
export const PREF_CLIPBOARD_SECONDS = "pref.clipboardClearSeconds";
export const PREF_OFFER_TO_SAVE = "pref.offerToSave";
// Extension only: the master switch for page autofill. Off hides the in-page dropdown entirely
// (matches, the "Vault locked" row, and the generated-password suggestion) and refuses fills.
export const PREF_AUTOFILL_ENABLED = "pref.autofillEnabled";
// Extension only: what clicking into a login field does. "icon" (the default) shows a small
// Bramble mark inside the field and leaves the list closed until it is clicked; "focus" opens the
// list on focus as older builds did; "shortcut" draws nothing and leaves filling to the browser
// command. Device-scoped: the background reads it while the vault is locked.
export const PREF_AUTOFILL_TRIGGER = "pref.autofillTrigger";
// Extension only: one-line rows or a two-row comfortable layout. Device-scoped, like the trigger:
// the background reads it while the vault is locked, and it describes this install's screen.
export const PREF_AUTOFILL_DENSITY = "pref.autofillDensity";
// Extension only: the one-time "what is this mark?" hint has been shown. Device-scoped: one
// install, not one vault.
export const PREF_AUTOFILL_ICON_HINT = "pref.autofillIconHintSeen";
// The mode type, its default and its validator live in one shared module so the background and
// the content script read the same definition rather than declaring their own copies.
export {
	type AutofillDensity,
	DEFAULT_AUTOFILL_DENSITY,
	isAutofillDensity,
	normalizeAutofillDensity,
} from "../util/autofill-density";
export {
	type AutofillTrigger,
	DEFAULT_AUTOFILL_TRIGGER,
	isAutofillTrigger,
	normalizeAutofillTrigger,
} from "../util/autofill-trigger";
export const PREF_NEVER_SAVE_SITES = "pref.neverSaveSites";
// Mobile only: present the biometric gate as soon as the unlock screen is up, rather than
// waiting for a tap. Off by default; see docs/auth-and-unlock.md (issue #43).
export const PREF_BIOMETRIC_AUTO_PROMPT = "pref.biometricAutoPrompt";
// iOS only: let the device passcode open the biometric gate as well as Face ID / Touch ID.
// Off by default, so "Face ID" means Face ID. Changing it re-arms the cached VEK with a
// different Keychain access control; see docs/auth-and-unlock.md.
export const PREF_BIOMETRIC_PASSCODE_FALLBACK = "pref.biometricPasscodeFallback";
// Mobile (iOS) only: populate the OS QuickType bar with usernames+domains so logins
// surface inline in the keyboard. Off by default since it exposes usernames before auth.
export const PREF_AUTOFILL_QUICKTYPE = "pref.autofillQuickType";
// Android: filling a login that has an authenticator key copies its code too (#99). Off by
// default, since it puts a secret on the clipboard. Read natively by TotpCopy.kt.
export const PREF_COPY_TOTP_ON_FILL = "pref.copyTotpOnFill";
// Extension only: act as a WebAuthn passkey provider for other sites. Off by default
// (attaching the proxy intercepts all browser WebAuthn). See docs/passkey-provider.md.
export const PREF_PASSKEY_PROVIDER = "pref.passkeyProviderEnabled";
// Extension only: an unlocked vault counts as confirming it's you for passkey sign-ins, so a site
// that checks doesn't ask again until the vault locks. Off by default. Read by the background
// (webauthn-provider.ts); see docs/passkey-provider.md.
export const PREF_PASSKEY_CONFIRM_ONCE = "pref.passkeyConfirmOncePerUnlock";
// Chromium only: also lock the vault when the OS screen locks, independent of the timeout.
// On by default (a screen-lock is a reasonable security floor); turned off to stay unlocked
// on a trusted device even under "Never". See issue #6.
export const PREF_LOCK_ON_SCREEN_LOCK = "pref.lockOnScreenLock";
// Home screen: whether the Total / At Risk / Strong stats row is collapsed.
// Persisted so the user's choice sticks across opens.
const PREF_STATS_COLLAPSED = "pref.statsCollapsed";
// Desktop only: the user waved away the suggestion to start Bramble at login after setting up
// a backup. Someone who leaves the machine on has a perfectly good reason to decline, and a
// suggestion that cannot be silenced is a nag. See BackupSection.
const PREF_AUTOSTART_PROMPT_DISMISSED = "pref.autostartPromptDismissed";
// Extension only: the vault list's "make Bramble your default password manager" card was
// waved away (#135). Settings still offers the switch.
const PREF_DEFAULT_MANAGER_PROMPT_DISMISSED = "pref.defaultManagerPromptDismissed";
// The password generator's last-used settings, so the field's one-tap regenerate produces what
// the user picked in the panel rather than a fixed house style.
const PREF_GENERATOR = "pref.generator";
// The vault list's last-picked sort order, for when its address names none (a fresh open, or
// the home button).
const PREF_VAULT_SORT = "pref.vaultSort";
// The email alias provider: which service, its settings, and the API key. Synced, so configuring
// it on one device reaches the others; see docs/synced-settings.md and docs/email-aliases.md.
export const PREF_ALIAS_PROVIDER = "pref.aliasProvider";
// Counters behind the "would you leave a review" ask, and the record of having asked. Device-scoped
// and deliberately not synced: it describes this install's relationship with its store listing, and
// a phone and a browser are listed in different stores. See app/review-nudge.ts.
export const PREF_REVIEW_NUDGE = "pref.reviewNudge";
// Mobile only: look for a newer version once a day, and what the last look found. See
// app/app-update.ts. The desktop keeps its own switch in its updater (shell.updates).
const PREF_UPDATE_CHECK = "pref.updateCheck";
const PREF_APP_UPDATE = "pref.appUpdate";
// The every-two-weeks donation card: its clock, and the Settings switch that stops it. See
// app/support-ask.ts.
const PREF_SUPPORT_ASK = "pref.supportAsk";
const PREF_SUPPORT_ASK_ENABLED = "pref.supportAskEnabled";
// Android, iOS and desktop: keep Bramble out of screenshots, recording and screen-reading
// assistants. Read natively at launch; see docs/screen-capture-blocking.md.
export const PREF_SCREEN_CAPTURE_BLOCKED = "pref.screenCaptureBlocked";

export const DEFAULT_AUTOLOCK_MINUTES = 15;
// Off by default: the breach check is the app's only network egress (k-anonymous
// SHA-1 prefix to HIBP), so we don't opt users in silently.
const DEFAULT_BREACH_CHECK = false;
export const DEFAULT_CLIPBOARD_SECONDS = 30;

/** How long a copied secret stays, from the stored "Clipboard auto-clear" seconds. For the
 * mobile and desktop clipboards, which read it at each copy. */
export function clipboardClearMs(stored: unknown): number {
	return (typeof stored === "number" && stored > 0 ? stored : DEFAULT_CLIPBOARD_SECONDS) * 1000;
}
export const DEFAULT_OFFER_TO_SAVE = true;
export const DEFAULT_AUTOFILL_ENABLED = true;
const DEFAULT_NEVER_SAVE_SITES: string[] = [];
const DEFAULT_BIOMETRIC_AUTO_PROMPT = false;
const DEFAULT_BIOMETRIC_PASSCODE_FALLBACK = false;
const DEFAULT_AUTOFILL_QUICKTYPE = false;
const DEFAULT_COPY_TOTP_ON_FILL = false;
export const DEFAULT_PASSKEY_PROVIDER = false;
export const DEFAULT_PASSKEY_CONFIRM_ONCE = false;
export const DEFAULT_LOCK_ON_SCREEN_LOCK = true;
const DEFAULT_STATS_COLLAPSED = false;
const DEFAULT_AUTOSTART_PROMPT_DISMISSED = false;
const DEFAULT_DEFAULT_MANAGER_PROMPT_DISMISSED = false;
// On, like the desktop's: a fix that reaches nobody fixes nothing.
const DEFAULT_UPDATE_CHECK = true;
// On: a password manager is rarely the app anyone needs a screenshot of.
const DEFAULT_SCREEN_CAPTURE_BLOCKED = true;

/** Resolved user preferences with their defaults. */
export interface Prefs {
	autoLockMinutes: number;
	breachCheckEnabled: boolean;
	clipboardClearSeconds: number;
	offerToSave: boolean;
	// Extension: show the in-page autofill dropdown at all.
	autofillEnabled: boolean;
	// Extension: what opens the in-page list (focus, inline icon, or the keyboard shortcut).
	autofillTrigger: AutofillTrigger;
	// Extension: the in-page list's row layout (one line, or the comfortable two-row rows).
	autofillDensity: AutofillDensity;
	// Extension: the one-time "what is this mark?" hint has been shown.
	autofillIconHintSeen: boolean;
	// eTLD+1 hostnames muted via "Never for this site".
	neverSaveSites: string[];
	// Mobile: fire the biometric prompt when the unlock screen appears, with no tap.
	biometricAutoPrompt: boolean;
	biometricPasscodeFallback: boolean;
	// iOS QuickType: surface usernames inline in the keyboard (exposes them before auth).
	autofillQuickType: boolean;
	// Android: copy a login's 2FA code to the clipboard when filling it.
	copyTotpOnFill: boolean;
	// Extension: act as a WebAuthn passkey provider for other sites.
	passkeyProviderEnabled: boolean;
	// Extension: an unlock counts as confirming it's you for passkeys until the vault locks.
	passkeyConfirmOncePerUnlock: boolean;
	// Extension: also lock when the OS screen locks, regardless of the timeout.
	lockOnScreenLock: boolean;
	// Home: collapse the Total / At Risk / Strong stats row.
	statsCollapsed: boolean;
	// Home: the vault list's sort order.
	vaultSort: SortKey;
	// Desktop: the backup section's "start at login" suggestion has been declined.
	autostartPromptDismissed: boolean;
	// Extension: the vault list's default-password-manager card has been declined.
	defaultManagerPromptDismissed: boolean;
	// Password generator: the settings last used in the generator panel.
	generator: GeneratorSettings;
	// The email alias provider for this vault, or null when none is set up.
	aliasProvider: AliasConfig | null;
	// Usage counters and ask history behind the store-review nudge.
	reviewNudge: ReviewNudgeState;
	// The group's mailbox, or null when it syncs without one.
	mailbox: MailboxConfig | null;
	// This device opted out of the group's mailbox for this vault.
	mailboxOff: boolean;
	// The hosted mailbox's account number, formatted, or null.
	mailboxAccount: string | null;
	// Mobile: check bramble.sh for a newer version.
	updateCheck: boolean;
	// Mobile: the last check's result and the version the notice was closed for.
	appUpdate: AppUpdateState;
	// The version the "What's new" card was last closed for.
	whatsNew: WhatsNewState;
	// When the donation card was last shown, and whether it may be.
	supportAsk: SupportAskState;
	supportAskEnabled: boolean;
	// Keep this app out of screenshots and screen-reading assistants.
	screenCaptureBlocked: boolean;
}

/** Each pref's storage key. A map rather than a ternary chain: the type makes it exhaustive, so
 * a new pref cannot quietly share another's key the way a fall-through else did. */
const META_KEYS: Record<keyof Prefs, string> = {
	autoLockMinutes: PREF_AUTOLOCK_MINUTES,
	breachCheckEnabled: PREF_BREACH_CHECK,
	clipboardClearSeconds: PREF_CLIPBOARD_SECONDS,
	offerToSave: PREF_OFFER_TO_SAVE,
	autofillEnabled: PREF_AUTOFILL_ENABLED,
	autofillTrigger: PREF_AUTOFILL_TRIGGER,
	autofillDensity: PREF_AUTOFILL_DENSITY,
	autofillIconHintSeen: PREF_AUTOFILL_ICON_HINT,
	neverSaveSites: PREF_NEVER_SAVE_SITES,
	biometricAutoPrompt: PREF_BIOMETRIC_AUTO_PROMPT,
	biometricPasscodeFallback: PREF_BIOMETRIC_PASSCODE_FALLBACK,
	autofillQuickType: PREF_AUTOFILL_QUICKTYPE,
	copyTotpOnFill: PREF_COPY_TOTP_ON_FILL,
	passkeyProviderEnabled: PREF_PASSKEY_PROVIDER,
	passkeyConfirmOncePerUnlock: PREF_PASSKEY_CONFIRM_ONCE,
	lockOnScreenLock: PREF_LOCK_ON_SCREEN_LOCK,
	statsCollapsed: PREF_STATS_COLLAPSED,
	vaultSort: PREF_VAULT_SORT,
	autostartPromptDismissed: PREF_AUTOSTART_PROMPT_DISMISSED,
	defaultManagerPromptDismissed: PREF_DEFAULT_MANAGER_PROMPT_DISMISSED,
	generator: PREF_GENERATOR,
	aliasProvider: PREF_ALIAS_PROVIDER,
	reviewNudge: PREF_REVIEW_NUDGE,
	mailbox: MAILBOX_PREF_KEY,
	mailboxOff: MAILBOX_OFF_PREF_KEY,
	mailboxAccount: MAILBOX_ACCOUNT_PREF_KEY,
	updateCheck: PREF_UPDATE_CHECK,
	appUpdate: PREF_APP_UPDATE,
	whatsNew: PREF_WHATS_NEW,
	supportAsk: PREF_SUPPORT_ASK,
	supportAskEnabled: PREF_SUPPORT_ASK_ENABLED,
	screenCaptureBlocked: PREF_SCREEN_CAPTURE_BLOCKED,
};

/**
 * MUST: no setting may affect a vault other than the one it was set in. See CONTEXT.md.
 *
 * "device" describes the app or the machine and is the same everywhere by intent. "vault"
 * describes ONE vault and is stored at `<key>:<vaultId>`, the convention the sync keys already
 * use (sync-keys.ts, docs/multiple-vaults.md). Anything granting a capability against a vault's
 * data is "vault": the two biometric prefs shipped flat, and a second vault then opened with
 * passcode fallback already on, having never been given it.
 *
 * "synced" describes the vault itself, wherever it is opened, and rides in the vault's encrypted
 * payload so it reaches the user's other devices (docs/synced-settings.md). One rule decides
 * eligibility, and it is a constraint rather than a preference:
 *
 *   If anything needs the value while the vault is LOCKED, it cannot be synced.
 *
 * A synced value lives behind the vault key, so it cannot be read before unlock. The extension
 * background reads autoLockMinutes, lockOnScreenLock and autofillEnabled from storage precisely
 * because it must answer while locked, which is why those are device-scoped and must stay so.
 *
 * Exhaustive over `Prefs`, so a new pref cannot be added without deciding - a compile error
 * rather than a silent device-wide default, which is the direction that leaks a permission.
 */
type PrefScope = "device" | "vault" | "synced";
const PREF_SCOPE: Record<keyof Prefs, PrefScope> = {
	autoLockMinutes: "device",
	breachCheckEnabled: "device",
	clipboardClearSeconds: "device",
	offerToSave: "device",
	autofillEnabled: "device",
	autofillTrigger: "device",
	autofillDensity: "device",
	autofillIconHintSeen: "device",
	neverSaveSites: "device",
	biometricAutoPrompt: "vault",
	autofillQuickType: "device",
	copyTotpOnFill: "device",
	passkeyProviderEnabled: "device",
	passkeyConfirmOncePerUnlock: "device",
	lockOnScreenLock: "device",
	statsCollapsed: "device",
	vaultSort: "device",
	autostartPromptDismissed: "device",
	defaultManagerPromptDismissed: "device",
	biometricPasscodeFallback: "vault",
	generator: "device",
	// Not device-local: an alias provider is an account-level fact about the person, not about
	// this browser, and only ever used behind an unlock. See docs/synced-settings.md.
	aliasProvider: "synced",
	// Device: which store this install came from is a fact about the app on this machine, and the
	// counters are of sessions on it. Syncing it would have a phone's usage spend a browser's asks.
	reviewNudge: "device",
	// Synced: one device switching the mailbox on switches on every device it reaches.
	mailbox: "synced",
	// Synced too: every device in the group pays from the same account.
	mailboxAccount: "synced",
	// Vault: switching it off on one device is that device's choice for that vault alone.
	mailboxOff: "vault",
	// Device: they describe this install's version, not the vault.
	updateCheck: "device",
	appUpdate: "device",
	whatsNew: "device",
	// Device: like the review ask, it is about this install, and a phone's answer should not quiet
	// a browser.
	supportAsk: "device",
	supportAskEnabled: "device",
	// Device: native code reads it at launch, before any vault is open.
	screenCaptureBlocked: "device",
};

const VAULT_SCOPED = (Object.keys(PREF_SCOPE) as (keyof Prefs)[]).filter(
	(k) => PREF_SCOPE[k] === "vault",
);

const SYNCED = (Object.keys(PREF_SCOPE) as (keyof Prefs)[]).filter(
	(k) => PREF_SCOPE[k] === "synced",
);

/**
 * How a synced pref's stored value is made safe to use.
 *
 * Every pref read already distrusts what it finds (`generator` is normalized field by field for
 * exactly this reason), and a synced one is worse off: the writer may be another device on a
 * different build. A pref without an entry here falls back to a type check against its default,
 * which is enough for the scalars and arrays but not for an object with a shape.
 */
const SYNCED_NORMALIZE: Partial<Record<keyof Prefs, (raw: unknown) => unknown>> = {
	// A shaped object with a secret in it, written by a peer that may be on another build: only
	// something that still parses as a config is taken, and anything else reads as "none".
	aliasProvider: (raw) => (isAliasConfig(raw) ? raw : null),
	mailboxAccount: (raw) => (typeof raw === "string" ? parseAccountNumber(raw) : null),
	mailbox: (raw) => {
		const parsed = MailboxConfigSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	},
};

/** Coerce a synced value, falling back to the default when it is unusable. */
function normalizeSynced<K extends keyof Prefs>(key: K, raw: unknown): Prefs[K] {
	const fallback = DEFAULT_PREFS[key];
	if (raw === null || raw === undefined) return fallback;
	const custom = SYNCED_NORMALIZE[key];
	if (custom) return custom(raw) as Prefs[K];
	// No declared shape: accept only a value of the same primitive kind as the default, so a
	// peer cannot turn a boolean into an object and surprise a consumer.
	if (Array.isArray(fallback)) return (Array.isArray(raw) ? raw : fallback) as Prefs[K];
	return (typeof raw === typeof fallback ? raw : fallback) as Prefs[K];
}

/** Their storage keys, for whoever has to clean up after a vault. Pairs with PER_VAULT_SYNC_KEYS. */
export const PER_VAULT_PREF_KEYS = VAULT_SCOPED.map((k) => META_KEYS[k]);

const DEFAULT_PREFS: Prefs = {
	autoLockMinutes: DEFAULT_AUTOLOCK_MINUTES,
	breachCheckEnabled: DEFAULT_BREACH_CHECK,
	clipboardClearSeconds: DEFAULT_CLIPBOARD_SECONDS,
	offerToSave: DEFAULT_OFFER_TO_SAVE,
	autofillEnabled: DEFAULT_AUTOFILL_ENABLED,
	autofillTrigger: DEFAULT_AUTOFILL_TRIGGER,
	autofillDensity: DEFAULT_AUTOFILL_DENSITY,
	autofillIconHintSeen: false,
	neverSaveSites: DEFAULT_NEVER_SAVE_SITES,
	biometricAutoPrompt: DEFAULT_BIOMETRIC_AUTO_PROMPT,
	biometricPasscodeFallback: DEFAULT_BIOMETRIC_PASSCODE_FALLBACK,
	autofillQuickType: DEFAULT_AUTOFILL_QUICKTYPE,
	copyTotpOnFill: DEFAULT_COPY_TOTP_ON_FILL,
	passkeyProviderEnabled: DEFAULT_PASSKEY_PROVIDER,
	passkeyConfirmOncePerUnlock: DEFAULT_PASSKEY_CONFIRM_ONCE,
	lockOnScreenLock: DEFAULT_LOCK_ON_SCREEN_LOCK,
	statsCollapsed: DEFAULT_STATS_COLLAPSED,
	vaultSort: DEFAULT_SEARCH.sort,
	autostartPromptDismissed: DEFAULT_AUTOSTART_PROMPT_DISMISSED,
	defaultManagerPromptDismissed: DEFAULT_DEFAULT_MANAGER_PROMPT_DISMISSED,
	generator: DEFAULT_GENERATOR_SETTINGS,
	aliasProvider: null,
	mailbox: null,
	mailboxOff: false,
	mailboxAccount: null,
	// Evaluated at module load, so the placeholder shown for the few ms before the read lands
	// describes an install with no history rather than one dating from the epoch, which would
	// read as old enough to ask immediately.
	reviewNudge: freshReviewNudgeState(Date.now()),
	updateCheck: DEFAULT_UPDATE_CHECK,
	appUpdate: {},
	whatsNew: {},
	supportAsk: {},
	supportAskEnabled: true,
	screenCaptureBlocked: DEFAULT_SCREEN_CAPTURE_BLOCKED,
};

export interface UsePrefs {
	prefs: Prefs;
	loaded: boolean;
	update<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
}

const PrefsContext = createContext<UsePrefs | null>(null);

/**
 * Load user preferences once and share them across the tree. Previously usePrefs was a
 * plain hook, so every caller kept its own copy: N loads on mount and a Settings update()
 * never reached the routes holding a stale snapshot. A single provider fixes both.
 */
/**
 * Read a vault-scoped pref, adopting the value an older build wrote to the flat key.
 *
 * `adopt` is the caller's proof that the flat value belongs to THIS vault - true only when the
 * install has exactly one. With several vaults we cannot know which one set it, and taking it
 * anyway would hand a setting to vaults that never had it, which is the bug the scoping fixed.
 * Multi-vault installs therefore fall back to the default, which is the closed position.
 *
 * The flat key is removed once adopted, so this happens once and a later second vault starts
 * from the default rather than inheriting the first one's answer.
 */
interface PrefStorage {
	getMeta<V>(k: string): Promise<V | undefined>;
	setMeta<V>(k: string, v: V): Promise<void>;
	removeMeta(k: string): Promise<void>;
}

/**
 * Delete the pre-scoping flat values once it is certain they cannot be attributed to a vault.
 *
 * Declining to adopt them is not the same as being rid of them. A flat value left in place is
 * adopted by whichever vault the install is eventually reduced to - delete the others, or delete
 * every vault and create a new one, and that vault silently inherits a gate setting nobody gave
 * it. Since with several vaults the value can never become attributable, retiring it here is what
 * makes non-adoption permanent rather than deferred.
 */
async function retireLegacyFlatPrefs(storage: PrefStorage): Promise<void> {
	await Promise.all(VAULT_SCOPED.map((k) => storage.removeMeta(META_KEYS[k]).catch(() => {})));
}

async function readVaultPref<T>(
	storage: PrefStorage,
	base: string,
	scoped: string,
	adopt: boolean,
): Promise<T | undefined> {
	const current = await storage.getMeta<T>(scoped);
	if (current !== undefined || !adopt || scoped === base) return current;
	const legacy = await storage.getMeta<T>(base);
	if (legacy === undefined) return undefined;
	await storage.setMeta(scoped, legacy);
	await storage.removeMeta(base).catch(() => {});
	return legacy;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
	const { storage } = usePlatform();
	const syncedSettings = useSyncedSettings();
	const { activeId, vaults, ready } = useVaultRegistry();
	const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
	const [loaded, setLoaded] = useState(false);
	// Same resolution syncKey uses: the active vault, falling back to the first before one is
	// selected, and unscoped only when there is no vault at all.
	const vaultId = activeId ?? vaults[0]?.id;
	const keyFor = useCallback(
		(pref: keyof Prefs) => {
			const base = META_KEYS[pref];
			return PREF_SCOPE[pref] === "vault" && vaultId ? syncKeyFor(base, vaultId) : base;
		},
		[vaultId],
	);

	useEffect(() => {
		let cancelled = false;
		// Only a single-vault install can prove the old flat value belongs to the vault in hand.
		// Waiting for `ready` matters twice over: an empty registry mid-load would otherwise read
		// as one vault and adopt on behalf of a vault that has not resolved, or read as none and
		// retire a value that was still attributable.
		const adoptLegacy = ready && vaults.length === 1;
		// Several vaults: the value belongs to one of them and we cannot tell which, so it is
		// deleted now rather than left for the last vault standing to inherit. See
		// retireLegacyFlatPrefs.
		const retireLegacy = ready && vaults.length > 1;
		// Drop the previous vault's per-vault values before reading the new one's. Until the read
		// lands the gate settings would otherwise still describe the vault we just left, and
		// Auth turns them straight into the access control it arms. Defaults are the closed
		// position, so the worst a stale window can do now is ask for one tap too many.
		setPrefs((prev) => ({
			...prev,
			...Object.fromEntries(VAULT_SCOPED.map((k) => [k, DEFAULT_PREFS[k]])),
		}));
		void (async () => {
			if (retireLegacy) await retireLegacyFlatPrefs(storage);
			const [
				a,
				b,
				c,
				d,
				e,
				f,
				g,
				h,
				i,
				j,
				k,
				l,
				m,
				n,
				o,
				p,
				q,
				r,
				s,
				u,
				v,
				w,
				x,
				y,
				z,
				sc,
				aa,
				ab,
			] = await Promise.all([
				storage.getMeta<number>(PREF_AUTOLOCK_MINUTES),
				storage.getMeta<boolean>(PREF_BREACH_CHECK),
				storage.getMeta<number>(PREF_CLIPBOARD_SECONDS),
				storage.getMeta<boolean>(PREF_OFFER_TO_SAVE),
				storage.getMeta<boolean>(PREF_AUTOFILL_ENABLED),
				storage.getMeta<string[]>(PREF_NEVER_SAVE_SITES),
				readVaultPref<boolean>(
					storage,
					PREF_BIOMETRIC_AUTO_PROMPT,
					keyFor("biometricAutoPrompt"),
					adoptLegacy,
				),
				storage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE),
				storage.getMeta<boolean>(PREF_PASSKEY_PROVIDER),
				storage.getMeta<boolean>(PREF_LOCK_ON_SCREEN_LOCK),
				storage.getMeta<boolean>(PREF_STATS_COLLAPSED),
				storage.getMeta<boolean>(PREF_AUTOSTART_PROMPT_DISMISSED),
				readVaultPref<boolean>(
					storage,
					PREF_BIOMETRIC_PASSCODE_FALLBACK,
					keyFor("biometricPasscodeFallback"),
					adoptLegacy,
				),
				storage.getMeta<unknown>(PREF_GENERATOR),
				storage.getMeta<unknown>(PREF_REVIEW_NUDGE),
				// New with the mailbox, so there is no flat legacy key to adopt.
				readVaultPref<boolean>(storage, MAILBOX_OFF_PREF_KEY, keyFor("mailboxOff"), false),
				storage.getMeta<boolean>(PREF_DEFAULT_MANAGER_PROMPT_DISMISSED),
				storage.getMeta<boolean>(PREF_PASSKEY_CONFIRM_ONCE),
				storage.getMeta<boolean>(PREF_UPDATE_CHECK),
				storage.getMeta<unknown>(PREF_APP_UPDATE),
				storage.getMeta<unknown>(PREF_VAULT_SORT),
				storage.getMeta<boolean>(PREF_COPY_TOTP_ON_FILL),
				storage.getMeta<unknown>(PREF_WHATS_NEW),
				storage.getMeta<unknown>(PREF_SUPPORT_ASK),
				storage.getMeta<boolean>(PREF_SUPPORT_ASK_ENABLED),
				storage.getMeta<boolean>(PREF_SCREEN_CAPTURE_BLOCKED),
				storage.getMeta<unknown>(PREF_AUTOFILL_TRIGGER),
				storage.getMeta<unknown>(PREF_AUTOFILL_DENSITY),
			]);
			if (cancelled) return;
			// One `now` for the read: a fresh install's clock starts here rather than at whichever
			// millisecond each consumer happens to ask.
			const now = Date.now();
			// Preserved, not rebuilt: this read covers the storage-backed scopes only, and a synced
			// pref comes from the vault on its own schedule. Replacing the whole object would drop
			// whatever the synced overlay had already resolved.
			setPrefs((prev) => ({
				...prev,
				autoLockMinutes: typeof a === "number" ? a : DEFAULT_AUTOLOCK_MINUTES,
				breachCheckEnabled: typeof b === "boolean" ? b : DEFAULT_BREACH_CHECK,
				clipboardClearSeconds: typeof c === "number" ? c : DEFAULT_CLIPBOARD_SECONDS,
				offerToSave: typeof d === "boolean" ? d : DEFAULT_OFFER_TO_SAVE,
				autofillEnabled: typeof e === "boolean" ? e : DEFAULT_AUTOFILL_ENABLED,
				autofillTrigger: normalizeAutofillTrigger(aa),
				autofillDensity: normalizeAutofillDensity(ab),
				neverSaveSites: Array.isArray(f) ? f : DEFAULT_NEVER_SAVE_SITES,
				biometricAutoPrompt: typeof g === "boolean" ? g : DEFAULT_BIOMETRIC_AUTO_PROMPT,
				autofillQuickType: typeof h === "boolean" ? h : DEFAULT_AUTOFILL_QUICKTYPE,
				copyTotpOnFill: typeof w === "boolean" ? w : DEFAULT_COPY_TOTP_ON_FILL,
				passkeyProviderEnabled: typeof i === "boolean" ? i : DEFAULT_PASSKEY_PROVIDER,
				passkeyConfirmOncePerUnlock: typeof r === "boolean" ? r : DEFAULT_PASSKEY_CONFIRM_ONCE,
				lockOnScreenLock: typeof j === "boolean" ? j : DEFAULT_LOCK_ON_SCREEN_LOCK,
				statsCollapsed: typeof k === "boolean" ? k : DEFAULT_STATS_COLLAPSED,
				vaultSort: isSortKey(v) ? v : DEFAULT_SEARCH.sort,
				autostartPromptDismissed: typeof l === "boolean" ? l : DEFAULT_AUTOSTART_PROMPT_DISMISSED,
				biometricPasscodeFallback: typeof m === "boolean" ? m : DEFAULT_BIOMETRIC_PASSCODE_FALLBACK,
				// Field by field: a stored object written by an older or hand-edited build is not
				// trusted to still match GeneratorSettings.
				generator: normalizeGeneratorSettings(n),
				// Same treatment, and for a sharper reason: a junk `installedAt` here is the
				// difference between asking after a fortnight and asking on day one.
				reviewNudge: normalizeReviewNudgeState(o, now),
				mailboxOff: typeof p === "boolean" ? p : false,
				defaultManagerPromptDismissed:
					typeof q === "boolean" ? q : DEFAULT_DEFAULT_MANAGER_PROMPT_DISMISSED,
				updateCheck: typeof s === "boolean" ? s : DEFAULT_UPDATE_CHECK,
				appUpdate: normalizeAppUpdateState(u),
				// Re-read when the first vault arrives, which is when a fresh install records its version
				// (markFreshInstall): `vaults.length` is in this effect's dependencies.
				whatsNew: normalizeWhatsNewState(x),
				supportAsk: normalizeSupportAskState(y, now),
				supportAskEnabled: typeof z === "boolean" ? z : true,
				screenCaptureBlocked: typeof sc === "boolean" ? sc : DEFAULT_SCREEN_CAPTURE_BLOCKED,
			}));
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
		// keyFor changes with the active vault, which is what re-reads the per-vault prefs on a
		// switch. Without it the second vault kept showing the first one's gate settings.
	}, [storage, keyFor, ready, vaults.length]);

	// Synced prefs are not read with the others: they come from the vault's payload, arrive only
	// once it is unlocked, and change again when a peer's merge lands one. Overlaid on top of
	// whatever the storage read produced, and reset to defaults while there is nothing to read,
	// so a locked vault shows the default rather than the last vault's answer.
	useEffect(() => {
		if (SYNCED.length === 0) return;
		setPrefs((p) => {
			const overlay: Partial<Prefs> = {};
			for (const key of SYNCED) {
				const rec = syncedSettings.settings?.[META_KEYS[key]];
				// Written through a Partial rather than assigned per key: `key` is a union here, and
				// an indexed write with a union key narrows the target to `never`.
				Object.assign(overlay, { [key]: normalizeSynced(key, rec?.value) });
			}
			return { ...p, ...overlay };
		});
	}, [syncedSettings.settings]);

	const update = useCallback(
		async <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
			setPrefs((p) => ({ ...p, [key]: value }));
			if (PREF_SCOPE[key] === "synced") {
				// Straight to the vault, which stamps it and persists through the same write every
				// entry change uses. Not also to storage: two homes for one value is how they drift.
				await syncedSettings.set(META_KEYS[key], value);
				return;
			}
			await storage.setMeta(keyFor(key), value);
		},
		[storage, keyFor, syncedSettings],
	);

	const value = useMemo<UsePrefs>(() => ({ prefs, loaded, update }), [prefs, loaded, update]);

	return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

/** Read shared user preferences. Must be called inside a PrefsProvider. */
export function usePrefs(): UsePrefs {
	const ctx = useContext(PrefsContext);
	if (!ctx) throw new Error("usePrefs called outside PrefsProvider");
	return ctx;
}
