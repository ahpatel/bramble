# Bramble design docs

High-level architecture and security design notes for the Bramble password
manager. These docs hold the reasoning that used to live in long code comments:
the "why" behind the crypto, the unlock flows, and the autofill behaviour. Code
comments point here instead of repeating it.

## Index

| Doc | Topic |
|-----|-------|
| [cryptography.md](cryptography.md) | The VEK / slot / KEK wrapping model, key derivation, verifier-based unlock, the password-change vs rotation tradeoff |
| [vek-residency-hardening.md](vek-residency-hardening.md) | Plan: shrink where the in-memory VEK exists outside the Rust core (drop unused returns, MTE, mlock, native-only biometric gate, enrollment last) and why allocator hardening is declined |
| [auth-and-unlock.md](auth-and-unlock.md) | Unlock flows, the slot-policy invariant (always one primary method), verify-without-unlock, error sanitization |
| [security-keys.md](security-keys.md) | WebAuthn PRF / hmac-secret unlock, two-ceremony registration, one-prompt unlock across keys |
| [totp.md](totp.md) | Stored authenticator keys: accepted input shapes and the "only digits reach the page" model |
| [totp-uri-handler.md](totp-uri-handler.md) | Appearing in iOS's and macOS's "Set Up Codes In" and Android's chooser by handling inbound `otpauth://` URIs (macOS planned), and why an arriving URI is both untrusted and a secret |
| [recovery-codes.md](recovery-codes.md) | High-entropy offline recovery codes: format, entropy, normalization |
| [vault-format.md](vault-format.md) | The VLT1 v2 on-disk binary layout and TLV slots |
| [password-changelog.md](password-changelog.md) | Superseded passwords kept on a login for propagation lag: the cap, who may write the field, and where it must not leak |
| [autofill.md](autofill.md) | Index, matching, the fetch-on-pick fill model, corner prompt, password generation |
| [launch-and-fill.md](launch-and-fill.md) | Plan: opening a login's website from the extension fills that login once, in that tab, on a matching host (#141, #156) |
| [default-password-manager.md](default-password-manager.md) | Extension: switching the browser's own password saving and card autofill off (#135); the optional `privacy` permission as the stored choice |
| [field-detection.md](field-detection.md) | Page field detection heuristics and fixtures |
| [field-inventory.md](field-inventory.md) | Plan: collapse the repeated whole-page detector walks into one composed-preorder inventory per parse, without moving any detector result |
| [storage.md](storage.md) | The chrome.storage.local vault backend, crash recovery, legacy FSA migration, durability |
| [encrypted-import.md](encrypted-import.md) | Encrypted imports: the `.bramble` portable vault, KDBX4 internals, Bitwarden encrypted-JSON handling, and the dedup every import shares |
| [firefox-import.md](firefox-import.md) | The Firefox CSV export: every value quoted, epoch-ms dates, the HTTP realm, and Firefox's own account row (its Sync key) left out |
| [credential-exchange.md](credential-exchange.md) | FIDO credential exchange (CXF/CXP) on iOS: the wire format, the OS handoff, and why Android is out |
| [passkey-import.md](passkey-import.md) | Importing passkeys from a file or an OS transfer: what is stored vs what arrives, and every reason one is skipped |
| [passkey-security-review.md](passkey-security-review.md) | Record: the 2026-11-01 adversarial review of the passkey provider and PRF, each finding's fix, and the decisions taken (including why iOS passkey identities skip the QuickType opt-in) |
| [passkey-prf.md](passkey-prf.md) | Plan: answer the WebAuthn PRF extension from Bramble's passkeys on every surface, and keep their PRF secrets through every import, export and credential exchange |
| [dashlane-import.md](dashlane-import.md) | The Dashlane CSV export: a zip of five CSVs known by header, a lone CSV from a Safari unzip, the columns that changed, identities and banks as notes |
| [lastpass-import.md](lastpass-import.md) | The LastPass CSV export format: two header variants, typed secure notes and their traps, note templates, and the Google signature collision |
| [onepassword-1pif-import.md](onepassword-1pif-import.md) | The 1Password 7 .1pif export: a folder read as data.1pif or zipped with its attachments, the Mac and Windows shapes, and items still in the 1Password 3 shape |
| [protonpass-import.md](protonpass-import.md) | The Proton Pass zip export: each website's autofill rule, Never websites kept out of autofill, and files named by a hash of their vault and file ids |
| [roboform-import.md](roboform-import.md) | The RoboForm CSV export format: what it leaves out (identities, cards), the spilled fields column, the escaped leading quote |
| [routing.md](routing.md) | Router guards, back navigation, pop-out handoff |
| [multiple-vaults.md](multiple-vaults.md) | Plan: parallel vaults on one device (local-id registry, one active vault at a time, active-vault-only sync, a primary vault for autofill/biometric) |
| [p2p-sync.md](p2p-sync.md) | Cross-device P2P sync: WebRTC transport, Nostr-subset relay, enrollment + roster-auth, the entry-level merge engine (HLC + tombstones) |
| [sync-rebroadcast.md](sync-rebroadcast.md) | Entry sync sends the vault when it changes plus a heartbeat, instead of every 4 s, because over TURN the resend is what would use up the free tier; resend on a failed merge, a 10-minute backstop, and counting the ICE guard's answers |
| [turn-credentials.md](turn-credentials.md) | Rationing the hosted TURN relay: why open-source clients can't be authenticated, the per-requester rate limit, short credentials, the free-tier ceiling and per-credential cap; signed requests and the self-hosted Node relay to come |
| [mailbox-service.md](mailbox-service.md) | Plan: store-and-forward sync for devices that are never online together; a server that holds sealed changes and files only until every device has them, self-hosted or paid for with a Mullvad-style account number, and the payment wall that keeps a card or crypto payment unlinkable to a mailbox |
| [sync-conflicts.md](sync-conflicts.md) | Plan: stop losing concurrent edits to one entry. Phase A keeps every concurrent version as version-vector siblings and shows the conflict; Phase B merges field groups inside the crypto core, falling back to a Phase A conflict when both sides changed the same group |
| [p2p-sync-testing.md](p2p-sync-testing.md) | Exercising device sync locally with two browser profiles + the relay |
| [sync-vault-pinning-and-quarantine.md](sync-vault-pinning-and-quarantine.md) | Plan: pin extension sync to one vault, silently quarantine entries a vault can't decrypt, refuse foreign entries at merge, calm unlock errors |
| [attachment-metadata-scrubbing.md](attachment-metadata-scrubbing.md) | Plan: Security → Attachments → "Scrub metadata" (synced, on by default): one Rust scrubber run beside the sealer on every target, per-format keep lists (EXIF, XMP, document properties, movie location), verify-or-keep-original, and a throwaway Worker for hostile-file parsing in the extension |
| [file-attachments.md](file-attachments.md) | Plan: files in a vault (entry attachments + standalone Files items); why the bytes cannot ride the entries payload, the immutable content-addressed blob store, per-file FEK + STREAM chunked AEAD, and the WebRTC-only transfer (direct or TURN, never forwarded by the signalling relay) |
| [cloud-storage-backups.md](cloud-storage-backups.md) | Planned scheduled encrypted backups: why the provider need not be zero-knowledge, and targeting S3 + WebDAV to cover Nextcloud/self-host and the privacy providers; desktop folder target and iOS iCloud folder; Google Drive on Bramble's Desktop-type OAuth client, or the user's own |
| [synced-settings.md](synced-settings.md) | Plan: a third `PrefScope` (`"synced"`) so a setting crosses devices by one word in the scope table; the stamped map it rides in, why absent must mean "no opinion", and why a locked-readable pref can never be synced |
| [email-aliases.md](email-aliases.md) | Plan: per-site email aliases from Addy.io, SimpleLogin and Fastmail (Forward Email deferred, paid-only), why plain `fetch` reaches them from every platform while Firefox Relay and DuckDuckGo cannot be, and why an alias suggestion cannot be pre-generated the way a password is , and a catch-all-domain provider that needs no account and makes the address locally |
| [firefox-port.md](firefox-port.md) | Firefox MV3 port feasibility and the filesystem-sync gap P2P sync fills |
| [mobile-port.md](mobile-port.md) | Capacitor mobile port feasibility; native autofill + biometric-unlock constraints |
| [screen-capture-blocking.md](screen-capture-blocking.md) | Keeping Bramble out of screenshots, recording and screen-reading assistants: on by default, a 10-minute pause, and what each OS can and can't do (FLAG_SECURE, the iOS layer redaction, WDA_EXCLUDEFROMCAPTURE, macOS's ScreenCaptureKit gap) |
| [mobile-update-notice.md](mobile-update-notice.md) | The mobile apps' once-a-day version check: the vault-list card, App Store vs GitHub APK, and the Settings switch |
| [whats-new.md](whats-new.md) | The card after an update: the per-target notes file that is also the GitHub release summary, when it shows, and the vault list's one-card-per-open rule |
| [support-ask.md](support-ask.md) | The every-two-weeks donation card: its schedule, its place among the vault list's cards, and why iOS doesn't ask |
| [desktop-port.md](desktop-port.md) | Plan: Tauri 2 desktop app; the spotlight mini app, browser IPC over native messaging, auto-type, SSH agent |
| [ssh-agent.md](ssh-agent.md) | Plan: the desktop app as an SSH agent for the vault's SSH keys; a Hosts list on each key turned into an ssh config so each server sees only its key, no prompt while unlocked, the unlock screen when locked, one allow per server for `ssh -A`, and edits that keep fields an older app doesn't know |
| [desktop-link-onboarding.md](desktop-link-onboarding.md) | Plan: link the desktop app from the setup screen and end with one vault (combine or keep separate); one emoji check and no code, all over the local link; each browser vault pairs with one desktop vault; security review |
| [windows-release-checklist.md](windows-release-checklist.md) | What CI and a scripted install already cover on Windows, and the human checklist for a release: SmartScreen, tray, autostart, browser pairing, updater, both uninstall answers |
| [desktop-biometric-unlock.md](desktop-biometric-unlock.md) | Plan: Touch ID and Windows Hello unlock in the desktop app; the key stays in Rust, the macOS keychain gate and its signing requirement, Windows Hello key derivation, no Linux |
| [macos-credential-provider.md](macos-credential-provider.md) | Plan: an AutoFill credential provider extension in the macOS app, for Safari and native-app fill of passwords, codes and passkeys; iterations by user capability, the verified Tauri packaging seam, and the blocker: Chrome and Firefox route passkeys through the system sheet, so Bramble must never hold or answer the extension's own `bramble.sh` unlock key; one copy per vault for several vaults (designed) |
| [windows-passkey-provider.md](windows-passkey-provider.md) | Plan: the Windows desktop app as a Windows 11 passkey manager (plugin API, passkeys only); identity from a sparse package signed through Azure, so NSIS and the updater stay (unsigned as a tested fallback), a sidecar COM server that brokers to the app, which signs; observed on Windows 11 ARM64 in Edge and Chrome |
| [release-signing.md](release-signing.md) | Chrome Web Store packaging + signing |
| [ci-releases.md](ci-releases.md) | Plan: move every build and signature to GitHub Actions, what it costs in trust, and the phases to get there |
| [reproducible-builds.md](reproducible-builds.md) | Rebuilding a release from its tag and getting the published bytes: which targets do, why the build runs as x86_64 Linux, and the daily check against the stores |
| [update-transparency.md](update-transparency.md) | Desktop updates install only if logged in public Sigsum logs: the targeted-update threat, the proof check, the monitor, and the keys |
| [apt-releases.md](apt-releases.md) | The Debian/Ubuntu channel end to end: R2 behind apt.bramble.sh, the container build, signing the index with a YubiKey-held key, and every failure hit getting there |
| [i18n.md](i18n.md) | Localization across core/iOS/Android/fastlane: Lingui macros, the LLM translation pipeline, commands, and CI/release gates |
| [store-reviews.md](store-reviews.md) | The review ask: the one object holding every threshold, why iOS gets the OS prompt and no card while the browser gets a card and no API, and what to check before shipping a change |

## Vocabulary

- **VEK** (Vault Encryption Key): the single random 32-byte key that everything
  in the vault ultimately encrypts under. Generated once at vault creation,
  never derived from a password.
- **KEK** (Key Encryption Key): a per-slot key that wraps a copy of the VEK.
  Derived differently per unlock method (Argon2id from a password, HKDF from a
  security key's secret).
- **DEK** (Data Encryption Key): a per-entry random key that encrypts one
  entry's plaintext. Wrapped under the VEK.
- **Slot**: one unlock method stored in the vault header (password, security
  key, or recovery code). Each slot wraps its own copy of the VEK.
- **Primary unlock method**: a master password or a security key. A recovery
  code is a backup, never a primary.
