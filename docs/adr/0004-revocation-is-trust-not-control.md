# Revocation is trust, not control

Removing a Member rotates the collection keys they held and drops them from the roster —
it stops future access but is **not** a remote wipe: a member who saved keys or kept an
offline copy can still decrypt what they already had. The remedy is rotating the actual
shared credentials, and the UI says this plainly. This is the documented industry norm,
not a bramble weakness: Bitwarden officially instructs changing the credentials, and
1Password's whitepaper admits removal is policy plus client erasure, with "create a new
vault" as the only full re-key (docs/research/family-sharing-key-models.md). Do not
build UI that implies cryptographic enforcement, and do not accept design work that
assumes revocation can reach a member's device.
