# AGENTS.md

Instructions for any coding agent working in this repository.

- **What this is.** Sno Station: one memory, Reach messaging, squad skills and a nightly
improvement loop for Claude Code, Codex and OpenClaw. Read `llms.txt` for the map.
- **Fixes land here first.** This repository is the source of truth for the product code.
- **Checks before you hand back work.** `npm run build --workspaces && npm run typecheck && npm run lint`,
plus the unit tests of the package you touched. An empty test run is a failure, not a pass.
- **Reviews do not check commit sign-off.** Never report a missing `Signed-off-by` as a finding.
- **Never add** benchmark numbers or vendor comparisons to docs; numbers live in `evals/` with a
receipt. Never name one model vendor as the careful one and the other as the fast one.
- **Never commit** credentials, private host names, absolute home paths, or links to private
documents. The CI scan rejects them.
- **Public words.** The category word is `squad` (lower-case). The product is Sno Station. Package
names are internal and do not appear on the README first screen.

## Merging and releases

- **Merge reviewed PRs by rebase.** Preserve each signed commit on protected `main`; do not squash
a grouped source synchronization into one commit.
- **Publish only on the owner's instruction.** A version tag does not publish npm. The owner
authorizes the exact package batch; create its GitHub Release after installation from npm succeeds.

Private working rules for this checkout, when present, are in `CLAUDE.md` beside this file. Read it too.
