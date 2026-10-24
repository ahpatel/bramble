# Sync conflicts: keep every edit, then merge fields (plan)

**Status:** not started. The prerequisite (a use no longer restamps an entry) landed 2026-10-23.

Today two devices that edit the same entry before they sync lose one edit whole and say nothing
(see "Conflict loser" in [p2p-sync.md](p2p-sync.md)). This plan fixes that in two phases:

- **Phase A** keeps every concurrent version and shows the conflict. No edit is ever silently lost,
  and the merge still compares only stamps.
- **Phase B** merges concurrent edits field group by field group inside the crypto core, so edits
  that touched different parts of an entry combine on their own. Anything it can't combine
  safely falls back to a Phase A conflict.

## Already done: a use is not an edit

`EntryMutations.touch` used to restamp the entry on every copy or fill (coalesced to once a
minute), so using a login on one device beat an edit made to it on another. It now writes
`lastUsedAt` without restamping, which makes `lastUsedAt` per-device: it reaches other devices
only with the entry's next real edit, and is the one field that two envelopes with the same id
and stamp may disagree on (`sync/vault-merge.ts`).

## Phase A: keep the losing version, show the conflict

### Telling a conflict from an ordinary edit

LWW replaces a version every time anything is edited, so "the loser" is usually just the
previous version. A conflict is a loser that is **concurrent** with the winner, and stamps alone
cannot tell the two apart: device B holding an old version S1 that receives A's S3 (edited S1 to
S2 to S3) must not see S1 as a conflict.

So each envelope gains a **version vector**: `vv: Record<nodeId, Hlc>`, the stamp of the last edit
each device made in this entry's lineage. An edit sets `vv = { ...base.vv, [self]: newStamp }`.
Version X is an ancestor of Y iff `Y.vv >= X.vv` component-wise; otherwise they are concurrent. The
vector is bounded by the number of devices that ever edited the entry.

### Siblings, not a loser list

An entry id holds a set of **siblings**: the versions no other held version descends from (the
maximal elements under the vv order). The highest stamp is the one displayed and autofilled, as
today; the rest are conflicts to show. Merging is union, then drop any sibling another one
descends from. That is a multi-value register (Dynamo/Riak siblings), so it is commutative,
associative and idempotent by construction, and devices that detect the same conflict converge on
the same set.

The pruning step is what makes it associative. Without it, merging (X, Y) then Z keeps X as a
conflict even when Z descends from X, while merging (X, Z) then Y does not. Property tests for
every merge order are required, not optional.

### Wire format

- `vv` on each envelope (outer index, so the merge stays blind).
- `conflicts: EncryptedEntry[]` on the payload: the non-displayed siblings, still sealed.
- Resolution writes a new edit whose `vv` joins every sibling it resolves, so they all become
  ancestors and prune away. No separate resolution tombstone is needed.

Both are new outer fields, and `EntriesPayloadSchema`/`EncryptedEntrySchema` are plain
`z.object`s, so older builds strip them on read and on write-back. The synced-settings rule
carries over ([synced-settings.md](synced-settings.md)): **absent means no opinion**. A version
with no `vv` (written by an older build) is ordered by stamp alone and never flagged, which is
exactly today's behaviour, so a mixed mesh degrades to LWW rather than corrupting anything.

`VaultEntries` must carry `vv` and the siblings, and `buildPayload` must thread them through, or
the next local write erases them. This is the same trap the settings map hit in the extension's
background writes; every write site needs a test that the new fields survive it.

### UI

A conflict badge on the entry, and a compare view that decrypts the siblings on demand
(`decryptEntries` already exists). The view offers three actions:

- **Keep this one.** Dismisses the siblings.
- **Use the other.** Writes it as a new edit.
- **Keep both.** The sibling becomes a new entry with a new id.

The UI is shared across targets; run `pnpm i18n:extract` for the new strings.

### Edit vs delete (decided 2026-10-23: a conflict)

Tombstones are plain stamps today, so an edit concurrent with a delete loses silently whenever
the delete is later. In Phase A a tombstone gets a `vv` too and takes part as a sibling: a delete
that descends from an edit wins outright, as now, but a delete concurrent with an edit leaves both
("deleted on your laptop, edited on your phone"). The entry stays visible with the edit and a
conflict badge until someone chooses to delete it or keep it, because hiding it would make the
edit just as invisible as dropping it.

### No cap

Siblings only come from real concurrency, so they stay small, and capping them would silently
drop data. They stay uncapped.

### Effort

About 1.5 to 2 weeks:

- **Core (3 to 4 days).** `vv` on writes, the sibling merge with property tests, `payloadsEquivalent`
  and the remote sanitizer covering the new fields, and mixed-version tests.
- **UI (2 to 3 days).** The badge, the compare view and i18n.
- **Wiring and device testing (2 to 3 days).** The extension, desktop, iOS and Android.

Risk is low to medium: the change is additive, the merge stays blind, and older builds behave as
they do today.

## Phase B: merge field groups

### Where it runs

Combining fields needs plaintext, so the merge decrypts both versions **inside the crypto core**,
the same host that already decrypts entries to show them and already test-decrypts every incoming
winner (`apply-remote.ts`, `admit`). The vault must be unlocked to merge either way. Nothing
leaves the core but the re-sealed result. Once this ships, the README and site copy that says the
winner is picked "from the stamps alone" must change.

### Groups, not fields

A naive per-field merge can produce entries nobody wrote. For example, A switches a login to a new
account (new username and password) while B rotates the old account's password; field-by-field,
the result is A's username with B's password, which works for neither account. So the unit is a
**group** of fields that change together:

| Type | Groups merged independently |
|------|------------------------------|
| all | `name`; `notes`; `archivedAt`; `tags` (set); `customFields` (list) |
| login | credential `{username, password, totp}`, with `breach` following the credential; `urls` (set); fill settings `{autofillEnabled, autoSubmit, subdomainMatch}`; `passkeys` (keyed by `credentialId`) |
| card | `{cardholderName, number, brand, expMonth, expYear, cvv}` as one group |
| ssh-key | `{publicKey, privateKey, passphrase, keyType}` as one group |

The remaining fields merge as follows:

- **Timestamps.** Take the lowest `createdAt` and the highest `updatedAt` and `lastUsedAt`.
- **`passwordChangelog`.** Combine both sides' rows, then apply the existing cap
  (`MAX_PASSWORD_CHANGELOG = 5`, newest first). That cap is the one documented loss
  ([password-changelog.md](password-changelog.md)).
- **Attachment manifests** (feat/file-attachments, not on main yet). They'll need the same
  per-item treatment as `passkeys`.

### Group stamps

Each group carries the stamp of its last change, stored **inside the encrypted entry JSON** as
`groupStamps`. Older builds keep unknown keys ([vault-format.md](vault-format.md), "Forward
compatibility"), which is how `archivedAt` and `tags` shipped, so this needs no format bump. A
group changed on side X since the common ancestor iff its stamp was made by node `n` and is newer
than `meet(X.vv, other.vv)[n]`. Then:

- **Only one side changed a group:** take that side's version.
- **Neither side changed it:** keep the shared value.
- **Both sides changed it:** don't guess. The pair stays a Phase A conflict.

Sets and lists need per-item add and remove stamps, or a removal comes back. `customFields` have
no ids today, so they need an identity first.

An older build that edits an entry keeps `groupStamps` but doesn't update them. A stored
`groupStampsAt` that doesn't match the envelope's `hlc` detects this, and the whole entry is
treated as changed at that stamp.

### Convergence

Two devices that merge the same pair must produce the same version, or they generate two
"merged" versions that are concurrent with each other and merge forever. So a merge result is a
pure function of its inputs:

- **Plaintext.** Deterministic given the two versions.
- **`vv`.** The exact join of the inputs, with no increment for the merging device.
- **Stamp.** Derived from the inputs alone, for example the max input stamp with
  `counter + 1` and a reserved node id, so it can never equal a real device's stamp.

Ciphertext differs per device (fresh DEK and IV), but the content is identical, so the
same-stamp-same-content invariant holds.

`applyRemotePayload` changes too. Today it only does work when the remote version wins; it would
have to merge every concurrent pair, decrypting both sides.

### Rollout

Ship in two releases so a bug can't spread before enough devices understand the format:

1. **B1.** Write `groupStamps` on every edit. They do nothing yet, and older builds keep them.
2. **B2.** Turn on the group merge once most devices are on B1 or later.

### Effort

About 3 to 5 weeks on top of Phase A:

- **Group stamps on the single write path (3 to 4 days).** That path is `entry-mutations.ts`; the
  iOS and Android autofill extensions queue their saves for the main app rather than writing.
- **The merge in the crypto host (about a week).** Including deterministic results and changing
  `applyRemotePayload`.
- **Set and list semantics (about a week).** Including an identity for custom fields.
- **Convergence tests (about a week).** Property tests across merge orders, a mesh mixing old and
  new builds, and device testing on all four targets.

Risk is high. This changes how persisted data on users' devices is merged; a convergence bug
corrupts or ping-pongs vaults, and group stamps can't be taken back out of people's vaults once
written.

## Order

Phase A first. It delivers "no edit is silently lost" on its own, and the conflicts it surfaces
show how often real concurrent edits happen. If users rarely see them, the compare view may be
enough and Phase B can wait.
