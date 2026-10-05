# Family sharing

Per-entry sharing inside one vault, with no account and no server that can
read anything. The design decisions live in the ADRs (0001–0008); this
document is the map. Vocabulary: `CONTEXT.md` under "Sharing" — Member,
Member key, Collection, Promotion.

## The model in one paragraph

A sharing-enabled vault stays one vault. The owner grants access through
**Collections**: named sets of entries whose per-entry DEKs are additionally
wrapped under the collection's key, which is itself wrapped once under the
vault key (the owner can always open and re-share) and once per **Member**
via an X25519 seal to that member's key. Members join in person (QR + SAS),
choose their own master password, and see only the entries shared with them.
A member can add private entries to the same vault and **promote** one into a
collection they belong to. Removing a member rotates every collection key
they held; it stops future access and is not a remote wipe.

## Format and crypto

- Non-sharing vaults stay byte-identical VLT1 forever. Enabling sharing
  converts the vault to **VLT2** (ADR-0007): slots and the outer entries blob
  keep their roles, and the sharing layer is additive.
- The sharing layer has two parts: outer **sharing-key wraps** (the sharing
  key wrapped under the vault key for the owner, and sealed to each member's
  key) and the **region** — sharing-key-encrypted JSON holding the
  member-visible index (ids, stamps, tombstones only), collections with
  labels sealed under their collection key, per-entry wrapper records, and
  member records.
- Member devices store their copy under a **member master key** (what their
  slot wraps) plus the member's X25519 private key in a member-secrets field.
  The member's view of an entry is the same envelope shape with the DEK
  wrapped under their master key.

## Sync

The merge kernel is unchanged — envelopes merge by id and stamp, verbatim.
Around it, a sharing-enabled vault's merge filters and localizes
(`sync/localize.ts`):

- **Filter** (members): a member never adopts ciphertext it cannot open.
- **Localize** (both): adopted envelopes get their DEK re-wrapped under the
  device's own key via wrapper records; envelopes that stay locked pass
  verbatim (the owner holds member-private bytes as opaque, so
  member-to-member content flows through it).
- The **region** converges through the existing entries-payload exchange as
  the `sharing.region` synced setting; devices adopt a newer region and
  refresh their blob's section from it.
- Conflicts (two devices editing one entry) keep the losing **sealed**
  version (`payload.conflicts`) and surface in the vault list; resolution is
  explicit and re-stamps through the normal edit path.

## Offline delivery: the mailbox

Peers that aren't online get their payload through the **mailbox** on the
relay's Durable Object (ADR-0008): opaque per-recipient envelopes, signed by
the sender's roster device key and verified by the recipient against the
roster it holds. The relay enforces only size (256 KB), queue depth (64),
and TTL (30 days); it cannot read or authenticate anything. Every host
pushes to peers on a slow tick and pulls its own queue at session start —
best-effort, with live sync as the fallback.

## The two honesty rules

1. **Revocation is trust, not control** (ADR-0004). Removal rotates keys and
   drops the member from the roster; a former member keeps what they saved.
   The remedy is rotating the actual credentials, and the UI says so.
2. **Export contains what you can decrypt** (ADR-0004's rule applied to
   backups). A member's export states it plainly.

These are documented industry norms, not shortcuts — see
`docs/research/family-sharing-key-models.md` for the survey that established it.

## What is deliberately not here (yet)

- Mobile parity for member devices (Phase 2): biometric caches and autofill
  learn to wrap the member key instead of the vault key.
- Mailbox-based remote invites (v1 invites are in-person QR + SAS).
- Roles/read-only flags (v2 consideration, recorded in ADR-0005 with the
  caveat that they are client policy, not cryptography).
- Un-promotion (v1 uses delete + recreate).
