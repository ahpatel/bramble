import { useLingui } from "@lingui/react/macro";
import {
	BadgeCheck,
	Clock,
	Keyboard,
	KeyRound,
	Lock,
	MousePointerClick,
	Power,
	ShieldCheck,
	SlidersHorizontal,
	TextCursorInput,
	Timer,
	UserCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { useAutostart } from "../../../../hooks/useAutostart";
import { type AutofillTrigger, isAutofillTrigger, usePrefs } from "../../../../hooks/usePrefs";
import { useVaultActions } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { toAutofillIndex } from "../../../../vault/autofill-index";
import { Button } from "../../../components/ui/button";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { Toggle } from "../../../components/ui/toggle";
import { useDefaultPasswordManager } from "../../../hooks/useDefaultPasswordManager";
import { useRenameVault } from "../../../hooks/useVaultName";
import { Row, Section } from "./primitives";

// Auto-lock timeout values: -1 = Immediate, >0 = minutes, 0 = Never. "Immediate" locks the
// moment the app/UI is no longer in use (mobile: on backgrounding; extension: when the last
// popup/window closes); "Never" holds the vault open until a manual lock or restart. On
// Chromium, OS screen-lock is governed separately by the "Lock when the screen locks" toggle
// below (default on), so "Never + toggle off" stays unlocked on a trusted device. On mobile
// this one setting also drives the autofill provider's keep-unlocked window: Immediate -> 0
// (require auth every fill), N minutes -> N, Never -> -1 (never expire).
const keepUnlockedWindow = (autoLockMinutes: number) =>
	autoLockMinutes < 0 ? 0 : autoLockMinutes > 0 ? autoLockMinutes : -1;

/** General settings: auto-lock, clipboard clear, breach checks, and save-prompt prefs. */
export function GeneralSection() {
	const { prefs, loaded, update } = usePrefs();
	const { autofill, shell, target } = usePlatform();
	const hasAutofillToggle = useCan("autofillToggle");
	const hasPasskeyProviderToggle = useCan("passkeyProviderToggle");
	const hasLockOnScreenLock = useCan("lockOnScreenLock");
	const hasImmediateAutoLock = useCan("immediateAutoLock");
	const canSaveCapture = useCan("saveCapture");
	const defaultManager = useDefaultPasswordManager();
	const { readEntries } = useVaultActions();
	const { t } = useLingui();
	// Turning the passkey provider on can fail in the background (another extension already holds
	// the browser's WebAuthn proxy), so the switch reverts and says why.
	const [passkeyProviderError, setPasskeyProviderError] = useState<string | null>(null);
	// The chord the browser actually has bound to the autofill cycle command. Read rather than
	// assumed: the user can rebind or clear it in the browser's own shortcuts page, and that page
	// is the only place the binding is stored.
	const [autofillShortcut, setAutofillShortcut] = useState<string | null>(null);
	useEffect(() => {
		if (!hasAutofillToggle) return;
		let cancelled = false;
		void shell.getAutofillShortcut?.().then((shortcut) => {
			if (!cancelled) setAutofillShortcut(shortcut);
		});
		return () => {
			cancelled = true;
		};
	}, [hasAutofillToggle, shell]);

	/** What the chosen click behaviour means, in the row's own words. */
	const autofillTriggerHint = (trigger: AutofillTrigger): string => {
		if (trigger === "focus") return t`Saved logins open as soon as you click into a field.`;
		if (trigger === "shortcut") {
			return t`Nothing is drawn on the page. Use the keyboard shortcut to fill a login.`;
		}
		return t`A small Bramble mark appears in the field. Click it to see saved logins, or type a username to see it completed.`;
	};

	// The current vault's name, edited inline, and renamed on every device in its sync group.
	const { vaults, activeId } = useVaultRegistry();
	const rename = useRenameVault();
	const currentVault = vaults.find((v) => v.id === activeId);
	const [vaultName, setVaultName] = useState("");
	useEffect(() => {
		setVaultName(currentVault?.label ?? "");
	}, [currentVault?.label]);
	const saveVaultName = () => {
		const next = vaultName.trim();
		if (currentVault && next !== currentVault.label) void rename(next);
	};

	// On mobile the auto-lock timeout also governs the autofill provider's keep-unlocked
	// window; push it whenever the setting changes. No-op where there's no native provider.
	useEffect(() => {
		if (loaded) void autofill.setKeepUnlocked?.(keepUnlockedWindow(prefs.autoLockMinutes));
	}, [loaded, prefs.autoLockMinutes, autofill]);

	// Desktop only; `available` is the adapter's presence rather than a target check, since there
	// is nothing to start on a platform whose host decides when we run.
	const autostart = useAutostart();

	// Shown where the OS supports inline autofill (iOS always; Android 11+). Starts hidden until resolved.
	const [inlineAvailable, setInlineAvailable] = useState(false);
	useEffect(() => {
		let cancelled = false;
		if (!autofill.inlineSuggestionsAvailable) return;
		void autofill.inlineSuggestionsAvailable().then((v) => {
			if (!cancelled) setInlineAvailable(v);
		});
		return () => {
			cancelled = true;
		};
	}, [autofill]);

	// Prefs come from a quick local-storage read; hold the section until it
	// resolves so the selects don't flash their defaults before snapping over.
	if (!loaded) return null;

	return (
		<Section icon={<SlidersHorizontal className="w-4 h-4 text-primary" />} title={t`General`}>
			{currentVault && (
				<TextField
					label={t`Vault name`}
					type="text"
					value={vaultName}
					onChange={(e) => setVaultName(e.target.value)}
					onBlur={saveVaultName}
					autoComplete="off"
				/>
			)}

			<Row
				icon={<Clock className="w-4 h-4 text-primary" />}
				title={t`Auto-lock timeout`}
				subtitle={
					// "Never" still ends with the session: the key is only ever held in memory (#146).
					prefs.autoLockMinutes === 0
						? target === "chromium" || target === "firefox"
							? t`Stays unlocked until you lock it or quit the browser. The key is only kept in memory, so the next start asks once.`
							: target === "desktop"
								? t`Stays unlocked until you lock it or quit Bramble. The key is only kept in memory, so the next start asks once.`
								: t`Stays unlocked until you lock it or the app is closed. The key is only kept in memory, so the next start asks once.`
						: autofill.setKeepUnlocked
							? t`Lock the vault and require autofill auth after inactivity`
							: t`Lock vault after inactivity`
				}
			>
				<div className="w-44">
					<SelectField
						label={t`Timeout`}
						value={String(prefs.autoLockMinutes)}
						onChange={(e) => void update("autoLockMinutes", Number(e.target.value))}
					>
						{/* Most secure: lock the instant the UI is no longer in use. On mobile that's
						    the moment the app is backgrounded (require auth on every fill); on the
						    extension it's when the last popup/window closes. */}
						{hasImmediateAutoLock && <option value="-1">{t`Immediate`}</option>}
						<option value="5">{t`5 minutes`}</option>
						<option value="15">{t`15 minutes`}</option>
						<option value="30">{t`30 minutes`}</option>
						<option value="60">{t`1 hour`}</option>
						{/* No timeout: hold the vault open until a manual lock or the session ends
						    (#188). OS screen-lock is governed by the separate toggle below. */}
						<option value="0">
							{target === "chromium" || target === "firefox"
								? t`Until browser closes`
								: target === "desktop"
									? t`Until Bramble quits`
									: t`Until app closes`}
						</option>
					</SelectField>
				</div>
			</Row>

			{/* Chromium only: lock on OS screen-lock, independent of the timeout. On by default;
			    turning it off is what makes "Never" truly stay unlocked on a trusted device. */}
			{hasLockOnScreenLock && (
				<Row
					icon={<Lock className="w-4 h-4 text-primary" />}
					title={t`Lock when the screen locks`}
					subtitle={t`Also lock the vault whenever your computer's screen locks, whatever the timeout.`}
				>
					<Toggle
						checked={prefs.lockOnScreenLock}
						onChange={(enabled) => void update("lockOnScreenLock", enabled)}
						label={t`Toggle lock when the screen locks`}
					/>
				</Row>
			)}

			{/* Desktop only. Phrased by what it buys rather than by what it does: "start at login"
			    is a chore, "keep backups running" is the reason to accept one. */}
			{autostart.available && (
				<Row
					icon={<Power className="w-4 h-4 text-primary" />}
					title={t`Start Bramble at login`}
					subtitle={t`Runs quietly in the menu bar so scheduled backups happen without you opening the app.`}
				>
					<div className="flex flex-col items-end gap-1">
						<Toggle
							checked={autostart.enabled === true}
							onChange={(on) => void autostart.setEnabled(on)}
							disabled={autostart.enabled === null}
							label={t`Toggle start at login`}
						/>
						{autostart.error && (
							<span className="text-xs text-destructive text-right">{autostart.error}</span>
						)}
					</div>
				</Row>
			)}

			{/* Keyboard suggestions opt-in: only shown where inline suggestions can actually
			    render (always on iOS; on Android only on a keyboard that supports them). Off by
			    default; turning it on surfaces matching logins inline above the keyboard.
			    Re-index immediately so the change takes effect. */}
			{autofill.setKeepUnlocked && inlineAvailable && (
				<Row
					icon={<Keyboard className="w-4 h-4 text-primary" />}
					title={t`Keyboard suggestions`}
					subtitle={t`Show matching logins above the keyboard for one-tap autofill.`}
				>
					<Toggle
						checked={prefs.autofillQuickType}
						onChange={(enabled) =>
							void (async () => {
								// Lease first: platforms that bind the cache to a vault session reject an
								// unleased re-index rather than stamping it with whatever owner is current.
								const lease = await autofill.beginIndexUpdate?.();
								await update("autofillQuickType", enabled);
								// The full list: the screen's entries leave out the hidden unlock key.
								await autofill.setIndex(toAutofillIndex(readEntries()), lease);
							})()
						}
						label={t`Toggle keyboard suggestions`}
					/>
				</Row>
			)}

			<Row
				icon={<Timer className="w-4 h-4 text-primary" />}
				title={t`Clipboard auto-clear`}
				subtitle={t`Wipe copied passwords after`}
			>
				<div className="w-44">
					<SelectField
						label={t`Clear after`}
						value={String(prefs.clipboardClearSeconds)}
						onChange={(e) => void update("clipboardClearSeconds", Number(e.target.value))}
					>
						<option value="30">{t`30 seconds`}</option>
						<option value="60">{t`1 minute`}</option>
						<option value="120">{t`2 minutes`}</option>
						<option value="300">{t`5 minutes`}</option>
					</SelectField>
				</div>
			</Row>

			{/* Breach check is opt-in and the only network egress, so the subtitle
			    is explicit about what's sent. */}
			<Row
				icon={<ShieldCheck className="w-4 h-4 text-primary" />}
				title={t`Check passwords for breaches`}
				subtitle={t`Sends a 5-character SHA-1 prefix of each saved password to haveibeenpwned.com (k-anonymity)`}
			>
				<Toggle
					checked={prefs.breachCheckEnabled}
					onChange={(enabled) => void update("breachCheckEnabled", enabled)}
					label={t`Toggle breach checks`}
				/>
			</Row>

			{/* Passkey provider: extension only (Chromium via webAuthenticationProxy, Firefox via
			    a MAIN-world content-script override). While on, Bramble handles passkey prompts,
			    so the subtitle is explicit. Toggling applies live and persists for next startup. */}
			{hasPasskeyProviderToggle && (
				<Row
					icon={<KeyRound className="w-4 h-4 text-primary" />}
					title={t`Use Bramble for passkeys`}
					subtitle={t`Create and store passkeys for other sites. While on, Bramble handles all passkey prompts in this browser.`}
				>
					<div className="flex flex-col items-end gap-1">
						<Toggle
							checked={prefs.passkeyProviderEnabled}
							onChange={(enabled) =>
								void (async () => {
									setPasskeyProviderError(null);
									await update("passkeyProviderEnabled", enabled);
									try {
										await shell.setPasskeyProviderEnabled?.(enabled);
									} catch (e) {
										// The pref is persisted first, so put it back: leaving it on would attach
										// on the next startup without the user having asked again.
										await update("passkeyProviderEnabled", !enabled);
										setPasskeyProviderError(e instanceof Error ? e.message : String(e));
									}
								})()
							}
							label={t`Toggle Bramble passkey provider`}
						/>
						{passkeyProviderError && (
							<span className="text-xs text-destructive text-right">{passkeyProviderError}</span>
						)}
					</div>
				</Row>
			)}

			{/* Sites that check it's you otherwise get a confirm on every passkey use. The background
			    reads the pref at each ceremony, so persisting it is all it takes. */}
			{hasPasskeyProviderToggle && prefs.passkeyProviderEnabled && (
				<Row
					icon={<UserCheck className="w-4 h-4 text-primary" />}
					title={t`Confirm passkeys once per unlock`}
					subtitle={t`Unlocking counts as confirming it's you until the vault locks.`}
				>
					<Toggle
						checked={prefs.passkeyConfirmOncePerUnlock}
						onChange={(enabled) => void update("passkeyConfirmOncePerUnlock", enabled)}
						label={t`Toggle confirm passkeys once per unlock`}
					/>
				</Row>
			)}

			{/* Master switch for the in-page dropdown; extension only. The background reads the pref
			    on every query, so persisting it is what enforces it; setAutofillEnabled only pushes
			    the change to tabs that already have a dropdown open. */}
			{hasAutofillToggle && (
				<Row
					icon={<TextCursorInput className="w-4 h-4 text-primary" />}
					title={t`Autofill on web pages`}
					subtitle={t`Offer saved logins, cards, and generated passwords in a dropdown on the page. When off, copy from the vault instead.`}
				>
					<Toggle
						checked={prefs.autofillEnabled}
						onChange={(enabled) =>
							void (async () => {
								await update("autofillEnabled", enabled);
								await shell.setAutofillEnabled?.(enabled);
							})()
						}
						label={t`Toggle autofill on web pages`}
					/>
				</Row>
			)}

			{defaultManager?.state && (
				<Row
					icon={<BadgeCheck className="w-4 h-4 text-primary" />}
					title={t`Default password manager`}
					subtitle={
						defaultManager.state === "locked"
							? t`Set by a policy or another extension`
							: t`Turns off the browser's own password manager`
					}
				>
					<Toggle
						checked={defaultManager.state === "bramble"}
						disabled={defaultManager.state === "locked"}
						onChange={defaultManager.set}
						label={t`Toggle default password manager`}
					/>
				</Row>
			)}

			{/* How the dropdown is reached. "Icon" is the quiet default: a mark in the field, a
			    completion while typing, and no panel until asked. Persisting is the background's
			    contract; setAutofillTrigger only moves what is already on screen. The rows are
			    hidden with autofill off: there is nothing to reach. */}
			{hasAutofillToggle && prefs.autofillEnabled && (
				<Row
					icon={<MousePointerClick className="w-4 h-4 text-primary" />}
					title={t`When you click a login field`}
					subtitle={autofillTriggerHint(prefs.autofillTrigger)}
				>
					<div className="w-44">
						<SelectField
							label={t`Show`}
							value={prefs.autofillTrigger}
							onChange={(e) => {
								const next = e.target.value;
								if (!isAutofillTrigger(next)) return;
								void (async () => {
									await update("autofillTrigger", next);
									await shell.setAutofillTrigger?.(next);
								})();
							}}
						>
							<option value="icon">{t`Bramble icon`}</option>
							<option value="focus">{t`Open on focus`}</option>
							<option value="shortcut">{t`Shortcut only`}</option>
						</SelectField>
					</div>
				</Row>
			)}

			{/* The browser owns the binding; this row reports what it is and sends the user to the
			    page that can change it. A shortcut that says nothing here is a shortcut nobody
			    will find, which is why the cycle command ships with a default chord. */}
			{hasAutofillToggle && prefs.autofillEnabled && (
				<Row
					icon={<Keyboard className="w-4 h-4 text-primary" />}
					title={t`Cycle logins with the keyboard`}
					subtitle={
						autofillShortcut
							? t`Press ${autofillShortcut} in a login field to fill the next saved login.`
							: t`No shortcut is set. Set one in your browser's extension shortcuts.`
					}
				>
					<div className="flex items-center gap-2">
						{autofillShortcut && (
							<kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
								{autofillShortcut}
							</kbd>
						)}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => void shell.openShortcutSettings?.()}
						>
							{t`Change`}
						</Button>
					</div>
				</Row>
			)}

			{/* Corner-prompt card; only on platforms with a save-capture surface (not mobile). */}
			{canSaveCapture && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title={t`Offer to save logins`}
					subtitle={t`Show a save / update card in the corner of the page when you sign in with credentials Vault doesn't have.`}
				>
					<Toggle
						checked={prefs.offerToSave}
						onChange={(enabled) => void update("offerToSave", enabled)}
						label={t`Toggle offer to save logins`}
					/>
				</Row>
			)}

			{canSaveCapture && prefs.neverSaveSites.length > 0 && (
				<Row
					icon={<ShieldCheck className="w-4 h-4 text-primary" />}
					title={t`Sites you've muted`}
					subtitle={
						prefs.neverSaveSites.length === 1
							? t`No save card on this site. Remove to start prompting again.`
							: t`No save card on these sites. Remove to start prompting again.`
					}
				>
					<div className="flex flex-wrap gap-1.5 justify-end max-w-[12rem]">
						{prefs.neverSaveSites.map((host) => (
							<Button
								key={host}
								variant="secondary"
								size="none"
								onClick={() =>
									void update(
										"neverSaveSites",
										prefs.neverSaveSites.filter((h) => h !== host),
									)
								}
								className="gap-1 px-2 py-0.5 text-[11px] rounded-md"
								title={t`Remove ${host} from never-save list`}
							>
								{host}
								<span aria-hidden>×</span>
							</Button>
						))}
					</div>
				</Row>
			)}
		</Section>
	);
}
