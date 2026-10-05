# Conflicts keep the sealed loser, surfaced

The sync engine's whole-entry last-writer-wins silently discards the losing version.
That was tolerable across one person's devices; with family members editing the same
login it becomes a real data-loss event (a stale Tuesday copy overwrites Monday's rotated
password). We adopt the already-planned "entry versions" approach from
docs/p2p-sync.md ("Conflict loser"): keep the losing **sealed** version (never decrypted
during merge) and surface "this entry changed on two devices" in the UI. Planned in
docs/p2p-sync.md; promoted from deferred to in-scope because sharing
makes two-human conflicts routine rather than rare.
