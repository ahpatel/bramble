# Sharing is an additive layer; sharing-enabled vaults are VLT2

The owner keeps the VEK and their existing unlock path untouched; owner-only entries stay
DEK-under-VEK exactly as today. Sharing adds: per-collection keys, entry DEKs
additionally wrapped under their collection's key, and collection keys wrapped once under
the VEK (owner can open and re-share) and once per member key. A vault that never uses
sharing stays byte-identical VLT1 forever; a sharing-enabled vault becomes VLT2, a new
version marker. Sharing-capable clients accept both, which eliminates the two-release
staged accept/write rollout — no bake period. Rejected: making the owner "just a member"
(cleaner conceptually, but rewrites every existing vault — the entire installed base pays
for users who never share).
