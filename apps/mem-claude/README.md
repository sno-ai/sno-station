# Sno Memory for Claude Code

Long-term memory for [Claude Code](https://github.com/anthropics/claude-code) sessions.

Sno Memory captures useful facts, preferences, decisions, and lessons so Claude Code can carry
context across sessions in a repository. You choose how memory-writing decisions are made:
entirely locally, with your own Claude Code, or with Sno's memory-specialized models plus your
Claude Code.

`sno-mem-claude` is a thin client of the local Sno Station Mem sidecar, adapted from
`apps/mem-codex`. The sidecar owns storage, extraction, and retrieval. This client owns the Claude
Code hooks, the capture spool and worker, the four memory commands, and installation into a Claude
configuration directory.

## Quickstart

Requirements:

- Claude Code on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH

The one-command `Sno onboarding` install in the repository README is not shipped yet. Until then:

```bash
npm install -g @snoai/mem-claude@next
npx --package @snoai/sno-station-mem@next sno-station-mem bind ~/.sno/sno-station-mem/$USER/memory.sqlite
sno-mem-claude install --config-dir ~/.claude
```

The bind command runs once per machine user and records the memory mode. The install command
writes three hook groups and one permission rule into `settings.json` and the skill into the
configuration directory. It never prompts; `--dry-run` prints every planned write. An unparsable
`settings.json` is left untouched while the skill is still installed.

Open a new Claude Code session inside a git repository, then verify the installation:

```bash
sno-mem-claude doctor
```

Then store a useful preference from the repository root:

```bash
sno-mem-claude remember "Prefer tabs for indentation in this repository."
```

Check that memory was created:

```bash
sno-mem-claude recall "indentation"
```

The package published to npm is the supported public install source. A source checkout, private
deployment host, or manual file copy is not required.

## Choose a memory mode

The mode controls memory writes. It is recorded once, in the JSON piped into the bind command;
with nothing piped in, the default applies.

| Mode | Default behavior | Credentials | Best for |
| --- | --- | --- | --- |
| **Local First** | Deterministic verbatim capture; deterministic profile and task handling | None | Fully local operation and predictable zero-LLM behavior |
| **Agent Native** | Uses your own Claude Code for memory extraction and all other model-assisted write decisions | Your existing Claude Code subscription | Users who want Claude to handle memory in the background |
| **REM Enhanced** | Uses the Sno GPU for the LoRA-covered extraction and conflict occasions, and your Claude Code for the remaining model-assisted write decisions | Sno access plus your Claude Code subscription | Highest memory-specific assistance |

Agent Native is the default.

### Local First

Local First makes no LLM calls. It captures useful content from your turns with rules and verbatim
slices and uses deterministic behavior for profile updates and task matching. When two memories
conflict, both remain available instead of asking a model to replace one. It does not generate a
model-written reflection summary, and it resolves relative dates without a model.

Memory processing remains local. The default local embedder may be downloaded on first use; after
it is cached, Local First does not need a network service.

```bash
echo '{"mode":"local-first"}' | npx --package @snoai/sno-station-mem@next sno-station-mem bind ~/.sno/sno-station-mem/$USER/memory.sqlite
```

### Agent Native

Agent Native uses the Claude Code you already have. The capture worker starts `claude -p` for each
model call: one turn, hooks disabled, no tools, no settings sources, no session persisted, working
in the client's own state directory rather than your repository. No API key is collected, and
there is no bring-your-own-key transport in this client.

```bash
echo '{"mode":"agent-native"}' | npx --package @snoai/sno-station-mem@next sno-station-mem bind ~/.sno/sno-station-mem/$USER/memory.sqlite
```

### REM Enhanced

REM Enhanced uses the Sno GPU for the two occasions covered by memory-specialized models:

- memory extraction uses the Sno extraction model;
- conflict adjudication uses the memory conflict model.

Your Claude Code handles active-task classification, profile merging, completed-task matching, and
relative-date resolution. If a model call fails, that request falls back to the corresponding
Local First behavior; it does not silently switch to another model tier. REM Enhanced needs Sno
access in the sidecar's environment; the bind JSON records only the key's name.

```bash
echo '{"mode":"rem-enhanced"}' | npx --package @snoai/sno-station-mem@next sno-station-mem bind ~/.sno/sno-station-mem/$USER/memory.sqlite
```

## Per-mode defaults

| Memory-writing occasion | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | Deterministic, verbatim | Your Claude Code | Sno extraction model |
| Classify active tasks | Keyword rules | Your Claude Code | Your Claude Code |
| Merge profile sections | Deterministic merge | Your Claude Code | Your Claude Code |
| Match completed tasks | Token overlap | Your Claude Code | Your Claude Code |
| Resolve conflicts | Keep both memories | Your Claude Code | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Same | Same |
| Resolve relative dates | No model call | Your Claude Code | Your Claude Code |

No occasion is disabled in Agent Native or REM Enhanced. Each model-assisted request either runs
in the background capture worker or falls back to the matching Local First behavior for that
request. In REM Enhanced, each occasion's tier is a switch under `remEnhanced.occasions` in the
bind JSON; the table shows the defaults.

Two REM operations run over the store on a periodic trigger and use the Sno models in every mode:
`rem-update` rewrites transition narratives into current-state memories and keeps the history;
`rem-replace` adjudicates contradictions across the store and soft-closes the loser reversibly.
Both are requested by default; `remOperations` in the bind JSON requests one, and
`remEnhanced.trigger.tick: false` turns the trigger off.

Retrieval and reranking are not mode-selection promises and are intentionally not described as
final behavior here.

## Onboarding defaults

The installation uses these defaults unless you change them in the bind JSON:

- memory mode: Agent Native;
- scope: the current repository, plus a `global` scope readable everywhere;
- embedder: local;
- ambient capture: on;
- auto-recall: on;
- session handling: local system session memory;
- management tools: off;
- cloud observability: off.

To change the mode, remove the two binding files for your user under `~/.sno/station/` and bind
again with the same store path; the memory library is untouched.

See the full [onboarding walkthrough](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claude/onboarding.md) and
[usage guide](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claude/usage-guide.md).

## Day-to-day commands

Hooks run on `SessionStart`, `UserPromptSubmit`, and `Stop`, scoped to the git repository that
contains the session. Session start injects up to 5 memories about standing decisions, open
tasks, conventions, and pitfalls; each prompt injects up to 3 relevant memories; `Stop` spools the
turn for a detached capture worker. Outside a repository, and in subagents, hooks inject and
capture nothing.

The skill teaches Claude these commands, run from inside a git repository:

| Command | Purpose |
| --- | --- |
| `sno-mem-claude recall <query>` | Search repository and global memory |
| `sno-mem-claude get <id>` | Read a complete memory and any superseding entry id |
| `sno-mem-claude remember <text>` | Store a repository memory |
| `sno-mem-claude correct <id> <text>` | Store a correction and mark the old entry superseded |

There is no model-facing deletion command.

Operator commands:

| Command | Purpose |
| --- | --- |
| `sno-mem-claude doctor [--config-dir <dir>]` | Sidecar health, hook state per event, permission rule state, import receipts |
| `sno-mem-claude import --repo <absolute-root>` | Import a repository's Claude Code memory notes into its memory |
| `sno-mem-claude install --config-dir <dir> [--dry-run]` | Install or refresh hook groups, permission rule, and skill |

Repository notes (the `.md` files in Claude Code's memory directory for the project) are also
imported on the first session start in that repository. There is no user-level import, and
instruction files and transcripts are never imported.

`CLAUDE_CONFIG_DIR` selects the Claude configuration directory (default `~/.claude`).
`SNO_PROFILE_DIR` selects the Sno profile (default `~/.sno`). Use the same profile and repository
root as the Codex client to share its memories. There is no client configuration file.

## Host boundaries

Model subprocesses run with hooks disabled and no tools in the client state directory. Sessions
with `sandbox.enabled: true` are unsupported: memory commands cannot reach the local sidecar.

Linux CLI installation and hook failure paths have real receipts. macOS CLI and Desktop
local-session support remain unverified until their surface receipts exist. Cloud, web, SSH-hosted
sessions, and the VS Code extension are not claimed.

## Read a memory store

`sno-memdump` ships with the OpenClaw plugin package and reads the same store format. Running it
through `npx` fetches that package into the npx cache and installs nothing into OpenClaw. It prints
memory rows as JSON Lines without changing the encrypted source store:

```bash
npx --package @snoai/mem-claw@next sno-memdump --db ~/.sno/sno-station-mem/$USER/memory.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Privacy and network behavior

- Memory data is stored in encrypted local SQLite storage.
- Local First does not send memory text to an LLM service.
- Agent Native sends model-assisted memory work to your own Claude Code on your subscription.
- REM Enhanced sends only its covered memory operations through Sno and uses your Claude Code for
  the remaining model-assisted operations.
- Injected memory blocks are labelled as data, not instructions.
- The bind JSON records key names, never key values; a credential in it is refused.

## Reinstall and data safety

Running `install` again refreshes the owned hook groups and permission rule in `settings.json` and
the skill in `skills/sno-mem-claude/`, and touches nothing else. It never writes `CLAUDE.md`,
`CLAUDE.local.md`, rules files, project memory notes, or credentials. Removing the package does not
remove the store. To reinstall:

```bash
npm install -g @snoai/mem-claude@next
sno-mem-claude install --config-dir ~/.claude
```

The memory library is the bound store file. Normal reinstall preserves it. Back it up before any
manual change to the store or the binding.

## License

Licensed under [Apache-2.0](LICENSE).
