# Sync conflicts: keep every edit, then merge fields (plan)

**Status:** Phase A built 2026-10-23 (all targets share the core; not yet device-tested, and the new UI strings await translation). Phase B not started.

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

### Prerequisite: a breach refresh is not an edit either

Opening a login whose breach status is over a week old re-checks it and saves the result through
`updateEntry` (`EntryDetailRoute`), which restamps the entry exactly as `touch` used to. Today that
lets viewing a login on one device overwrite an edit made on another; under Phase A it would raise
a conflict nobody caused. The refresh must write `breach` without restamping, making it per-device
like `lastUsedAt`.

### Telling a conflict from an ordinary edit

LWW replaces a version every time anything is edited, so "the loser" is usually just the
previous version. A conflict is a loser that is **concurrent** with the winner, and stamps alone
cannot tell the two apart: device B holding an old version S1 that receives A's S3 (edited S1 to
S2 to S3) must not see S1 as a conflict.

So each version carries its **causal history**, `H(V)`, in two parts:

- `vv: Record<writerId, Hlc>`: per writer, the stamp of its latest event in V's history.
- `floor?: Hlc`: every event stamped at or before it is in V's history. Only lineages that pass
  through a version written by an older build have one (see "Older builds" below).

A version's own event is `(writer, hlc)`, where `writer` is the `vv` key whose value equals the
version's `hlc`. **X is an ancestor of Y iff X's own event is in H(Y)**: `X.hlc <= Y.floor`, or
`X.hlc <= Y.vv[writer(X)]`. Two copies with the same id and `hlc` are the same version.

A write's history is the union of the histories of the versions it supersedes (its **bases**)
plus its own event: `vv` is the component-wise max of the bases' `vv`s plus `{ [writer]: hlc }`,
and `floor` is the max of the bases' floors.

**Each writer's events on one entry must form a chain**: every event a writer makes descends from
all its earlier ones on that entry. The per-writer max is only exact under that rule. The rule
breaks when a device edits the displayed version while its own earlier edit sits in an unresolved
sibling. A naive `vv` would then claim the new version descends from that sibling, and the merge
would prune it. So the writer key is the device's node id unless the bases don't contain that
key's latest event on this entry. In that case the device writes under a **fork key**,
`<nodeId>~<formatHlc(stamp)>`, reusing an existing fork key of its own whose latest event the bases
do contain. A writer's latest event on an entry is the max over every version held for that id
(displayed, sibling and tombstone) of `vv[key]`, plus the own event of any version with no `vv`.

The vector stays small: one key per device that ever edited the entry, plus a fork key for each
time a device edited around an unresolved conflict.

**A writer key must belong to one sequential writer.** Node ids are random per device and per
vault (`ensureDeviceId`), so two devices never share one. The extension is the exception: its
popup and its background service worker each build a clock from the same device id, and both
write entries. A corner-prompt update landing while the popup holds a stale copy would make two
concurrent versions under one key, and the per-writer max would call the earlier one an ancestor
and prune it. So the background clock uses its own node, `<deviceId>#bg`. The extension's UI
contexts (popup, options page, pop-out) still share the device's node. Two of them editing the
same entry at the same instant can still lose one edit, as today; that race needs two windows
open on one entry.

### Which versions a write supersedes

| Write | Bases |
|-------|-------|
| `add`, `importMany`, a new corner-prompt or passkey login | none |
| `update`, `setArchived`, `setTags`, a corner-prompt update, a passkey placement | the displayed version only; siblings stay |
| `remove`, `removeMany` | every live version and the tombstone: deleting the entry you see deletes the entry, but edits you haven't received yet still come back as a delete conflict |
| a resolution | every live version and the tombstone |
| `touch`, the breach refresh | not a new version: the displayed version keeps its stamp |

### Siblings, not a loser list

An entry id holds a set of **siblings**: the versions no other held version descends from. That
is a multi-value register (Dynamo/Riak siblings). Merging is union, then prune **top-down by
stamp**: walk the versions from the highest stamp down, and keep one unless it is dead under the
tombstone or is an ancestor of a version already kept. On histories built by the rules above,
"ancestor" is inclusion of histories, a partial order, so this equals dropping every ancestor,
and the merge is commutative, associative and idempotent. Pruning is also what makes it
associative: without it, merging (X, Y) then Z keeps X even when Z descends from X, while
merging (X, Z) then Y doesn't. Property tests over random histories and every merge order are
required, and the simulator must check `isAncestor` against the true ancestry it tracked.

Top-down matters once older builds are involved, where legacy claims make "ancestor"
non-transitive. Suppose an older build relays a stripped copy of X after X was edited into R
elsewhere, and a sibling Y stamped below X is still held. Dropping every ancestor at once lets
the stale copy's claim prune Y, a version it never saw. Top-down prunes the stale copy under R
first, so it never gets the chance.

Deletes merge into **one tombstone per id**: `hlc` is the max, `vv` the component-wise max, and
`floor` the max. By the chain rule its history is exactly the union of the deletes' histories.
Two tombstones with histories always join, even at the same stamp: a joined tombstone carries
the stamp of its newest delete, so one stamp can sit on different histories, and keeping either
copy would make the result depend on merge order (found by the property test). One exception: a
legacy tombstone at the other's stamp, or whose own event is already in the other's history, adds
nothing. It is a stripped copy of a delete already known (an older build relaying an old
tombstone after a later delete raised the stamp), and joining its claim would kill every
delete-conflicted edit stamped below it.

- A live version is **dead** iff its own event is in the tombstone's history.
- A tombstone is **superseded** iff some surviving live version's history contains all of it:
  `T.floor <= E.floor`, and every `T.vv[k] <= max(E.vv[k], E.floor)`. A superseded tombstone stays
  in the graveyard, as tombstones do today, but raises nothing.

The highest-stamp surviving live version is displayed and autofilled, exactly as today; the other
surviving live versions are **conflicts**. An entry also has a **delete conflict** when it is
visible and its tombstone is not superseded ("deleted on your laptop, edited on your phone",
decided 2026-10-23). It stays visible until someone chooses: hiding it would make the edit just
as invisible as dropping it. There's no cap: siblings only come from real concurrency, and
capping them would silently drop data.

### Wire format

- `vv` and `floor` on each `EncryptedEntry` and each tombstone, in the outer index, so choosing
  versions stays blind.
- `conflicts: EncryptedEntry[]` on the payload: the surviving live versions that aren't displayed,
  still sealed.
- No separate resolution record: a resolution is a write whose bases are all the siblings.

`vv` values are full `Hlc` objects, like every other stamp in the payload. That costs roughly 120
bytes per writer per edited entry, a 7 to 17% larger outer payload for a vault whose entries have
all been edited once. Entries nobody has touched since the upgrade carry nothing.

### Older builds

`EntriesPayloadSchema`, `EncryptedEntrySchema` and `TombstoneSchema` are plain `z.object`s, so
older builds strip `vv`, `floor` and `conflicts` on read and on write-back. The synced-settings
rule carries over ([synced-settings.md](synced-settings.md)): an absent `conflicts` means no
opinion, never "resolved".

A version with no `vv` is treated as an LWW claim: its history is **every event stamped at or
before its `hlc`** (`vv = {}`, `floor = hlc`), and its writer is `hlc.node`. That is what an older
build means by a write. Unlike "compare legacy versions by stamp", it keeps ancestry a single
consistent order. A newer build editing a legacy base inherits the claim as its `floor`.

- **Same-stamp copies.** A legacy copy with the same id and `hlc` as a version that has a `vv` is
  the same version stripped, so the merge keeps the `vv` copy and ignores the copy's claim. That
  matters for tombstones in particular: joining a stripped copy's floor in would silently turn
  every delete conflict back into "the delete wins".
- **What degrades.** An older build's genuine edit still dominates every version stamped before
  it, which is exactly today's LWW. In a mixed group the outcome can then depend on merge order,
  but every device converges once gossip settles. Nothing is worse than today.
- **Equivalence.** `payloadsEquivalent` must count a `vv` copy as different from a stripped one,
  or a device keeps its stripped copy forever and makes LWW claims it doesn't need to.

### Everything that carries the payload

`VaultEntries` must carry each version's `vv`/`floor`, each tombstone's, and the conflicts, and
`buildPayload` must thread them through, or the next local write erases them. That is the trap
the settings map hit in the extension background, so every write site needs a test that the new
fields survive it. The sites are:

- `entry-mutations.ts` and `useVault`'s load path. The load path also canonicalizes the stored
  payload by merging it with an empty one before decrypting. A quarantine that set aside an
  undecryptable displayed version can otherwise leave its siblings with nothing displayed.
- The extension's background writers (`corner-prompt.ts`, `passkey-store.ts`, through
  `vault-io.ts`), which must also witness the conflicts' stamps before writing.
- The merge-side admission check, which must also test-decrypt incoming conflicts, and the clock,
  which must witness their stamps and every `vv` component.
- The remote sanitizer, which must drop any version whose `hlc`, `floor` or any `vv` component is
  future-dated.
- `sealAll`. Conflicts are sealed under DEKs wrapped by the current vault key, so rotating the key
  must re-seal them as well.

### UI

A conflict badge on the entry in the list, and on the detail screen a banner with a compare view
that decrypts the siblings on demand (`decryptEntries` already exists). Each version renders
through its type's existing `mode.Detail` body, with a copy handler that doesn't record a use. It
offers:

- **Keep this one.** Resolves with the displayed content.
- **Use this one.** On a sibling: resolves with that sibling's content, through the same
  password-changelog rule as an edit.
- **Keep both.** The sibling becomes a new entry with a new id, and the original resolves with
  the displayed content.

A delete conflict offers **Keep it** and **Delete it**. When an entry has both sibling versions
and a delete conflict, the banner says both and the compare view also offers **Delete it**. The
UI is shared across targets; run `pnpm i18n:extract` for the new strings.

Known limits, not built in Phase A:

- **Fill only sees the displayed version.** Autofill and every passkey lookup (extension
  background, Android `VaultReader`) read the displayed version only. A passkey created inside a
  version that lost the display can't be used until the conflict is resolved, but today it's
  lost outright.
- **Some exports leave the other versions out.** A selection export (.bramble) and a KeePass
  export include only the displayed version. The export dialogs say how many conflicted entries
  that affects. A full backup is the sealed vault and keeps everything.

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

This section predates the Phase A history model. "The common ancestor" and `meet` must be
re-derived against floors and fork keys before Phase B starts.

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
