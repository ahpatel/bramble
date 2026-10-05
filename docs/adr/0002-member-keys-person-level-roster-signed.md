# Member keys are person-level and roster-signed

Collection keys wrap to a **Member key** — one X25519 keypair per person per vault,
minted at invite time — not to per-device keys. Devices keep their Noise/Ed25519 roles
(transport and roster authentication). The Member key is attested by the member's device
keys through the existing roster, and key wrappings carry verifiable fingerprints; this
closes the public-key-binding gap 1Password's own whitepaper concedes (their server can
MITM key wrapping). Per-device wrapping targets were rejected: "remove dad" would mean
enumerating and revoking each of his devices, and every new device would need every
collection re-shared to it.
