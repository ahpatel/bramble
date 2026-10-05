# Collections, not per-entry wrapping

Family sharing needs entries whose DEKs are unwrap-able by some members and not others.
We grant with **collection keys**: each sharing set has one random key, entries' existing
DEKs are re-wrapped under it, and the collection key is wrapped once per Member's Member
key. Sharing one more entry is one DEK re-wrap; revocation rotates the collection key.
Per-entry wrapping (a wrapping record per recipient per entry) was rejected as N×M
records for no extra property. Collections of one are allowed, so an ad-hoc share needs
no named set. Note this makes bramble's collections real crypto boundaries, which
Bitwarden's are not (its collections carry no key; one org key encrypts everything — see
docs/research/family-sharing-key-models.md).
