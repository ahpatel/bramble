# Issue tracker: GitHub (ahpatel/bramble-planning)

Issues and specs for this repo live as GitHub issues in the **separate private repo
`ahpatel/bramble-planning`** — not in this repo's origin. Use the `gh` CLI for all
operations.

**All `gh issue`, `gh pr`, `gh label`, and `gh api` commands MUST pass
`--repo ahpatel/bramble-planning`** (or the `repos/ahpatel/bramble-planning/...` API
path). Do **not** infer the repo from `git remote`: origin is `ahpatel/bramble`, the
public repo, and it is not the tracker. Never create issues, labels, or comments there.

## Conventions

- **Create an issue**: `gh issue create --repo ahpatel/bramble-planning --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo ahpatel/bramble-planning --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo ahpatel/bramble-planning --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo ahpatel/bramble-planning --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo ahpatel/bramble-planning --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo ahpatel/bramble-planning --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Cross-repo references

- A bare `#<number>` in an issue, spec, or ticket refers to an issue in `ahpatel/bramble-planning`.
- Reference code in this repo by path or commit SHA (e.g. `packages/core/src/vault/entry-mutations.ts`); full URLs into `ahpatel/bramble` render as permanent links.
- To reference the public repo explicitly, use the `ahpatel/bramble#<number>` syntax.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `ahpatel/bramble-planning`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo ahpatel/bramble-planning --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo ahpatel/bramble-planning --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/ahpatel/bramble-planning/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/ahpatel/bramble-planning/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --repo ahpatel/bramble-planning --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo ahpatel/bramble-planning --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --repo ahpatel/bramble-planning --body "<answer>"`, then `gh issue close <n> --repo ahpatel/bramble-planning`, then append a context pointer (gist + link) to the map's Decisions-so-far.
