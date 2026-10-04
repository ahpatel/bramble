# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**This repo is single-context.** One glossary and one ADR directory serve every
package: `packages/core`, `packages/core-rust`, and the `platform-*` targets are
platform implementations over one shared core, not separate contexts.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary — module-level domain concepts
  (VaultEntries, EntryMutations, Archived, EntriesBlobStore, …).
- **`docs/README.md`**: crypto/storage terms (VEK, KEK, DEK, Slot, primary unlock
  method). Read both for anything touching the vault.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Naming override: CONTEXT.md is the glossary

This repo is a fork that tracks an upstream repo, so filenames are kept aligned with
upstream to minimize drift. The glossary lives in **`CONTEXT.md`**, and this
deliberately overrides the skills' `GLOSSARY.md` convention:

- Wherever a skill says "`GLOSSARY.md`", read/write **`CONTEXT.md`** instead.
- **Never create `GLOSSARY.md`.** The `/domain-modeling` skill creates `GLOSSARY.md`
  lazily when missing — treat `CONTEXT.md` as already existing (it does) and update it
  in place, following the same glossary discipline (no implementation details, no
  specs, no scratch notes).
- If a stray `GLOSSARY.md` ever appears in the repo root, it is a mistake: merge any
  new terms into `CONTEXT.md` and delete it.

## File structure

```
/
├── CONTEXT.md               ← the glossary (upstream naming)
├── docs/
│   ├── README.md            ← crypto/storage vocabulary
│   ├── adr/                 ← architecture decisions (created lazily)
│   └── <topic>.md           ← deep dives per subsystem
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
