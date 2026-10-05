# The signaling relay gains a persistent mailbox

Liveness for family members cannot depend on the owner's devices being awake: a member's
evening edit must reach the owner without the owner's desktop online. The existing relay
DO (Worker + Durable Object) gains per-recipient queues: ciphertext-only, addressed by
member key, roster-authenticated push/pull, TTL'd with deletion. Desktop-as-hub remains
the fallback when no mailbox is configured. This changes the relay's posture from "stores
nothing" to "stores ciphertext until picked up" — the same privacy stance as cloud
backups, and the industry-standard shape: all four surveyed systems already store
per-recipient wrapped-key blobs server-side (docs/research/family-sharing-key-models.md).
The relay README's "stores nothing" sentence is updated accordingly.
