# Members see a minimal shared index

Members never hold the vault VEK, so the VEK-encrypted index cannot serve them. We make
the index member-visible in minimal form: `{random id, HLC, tombstone}` for every entry,
with sealed blobs present only for entries shared with that member. Members learn that an
entry exists and when it changed — nothing else (titles, usernames, URLs are all inside
ciphertext). Per-member indexes were rejected: without a shared index no member can
resolve conflicts over entries it cannot see, and every conflict funnels through one
always-online party, breaking the distributed merge engine. Precedent: Proton encrypts
all fields; Passbolt historically leaked names in plaintext; this sits deliberately
between (docs/research/family-sharing-key-models.md). Collection labels follow the same
rule one level down: sealed under the collection key, so a member sees labels only of
collections they belong to and everyone else sees an opaque id.
