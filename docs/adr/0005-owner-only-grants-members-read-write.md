# Owner-only grants; members read-write

In v1, only the vault owner creates Collections, shares entries into them, and invites or
removes Members; Members get **read-write** on entries shared with them — read-write
includes delete: a member's tombstone propagates to everyone, and the sealed-loser
history (ADR-0006) keeps the content recoverable. No un-promotion in v1: a member who
wants an entry private again deletes it and re-creates it privately; a re-key-to-private
feature is deferred. One carve-out —
**promotion**: a Member may share their own private entry (DEK wrapped only under their
Member key) into a Collection they belong to, after which the owner can open, edit, and
move it. Members still cannot re-share entries that were shared *to them*, create
Collections, or invite Members. Explicit no's: re-sharing others' entries, roles,
read-only flags, per-field permissions. Read-only was rejected because it multiplies the
permission design without removing the real risk — two family members editing the same
entry — which the conflict policy (ADR-0006) addresses. Member requests to join a
collection and delegation of grant rights are deliberately out of scope until the base
works. Deferred to v2 consideration: per-entry read-only flags with an export
restriction for members — recorded with the explicit caveat that read-only and
no-export are client policy, not cryptography: a member who can decrypt can always copy
(the same trust boundary as ADR-0004).

