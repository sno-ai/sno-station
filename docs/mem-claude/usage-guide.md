# Sno Memory for Claude Code — Usage Guide

This guide covers the public npm installation, memory modes, common commands, and safe
configuration changes for `@snoai/mem-claude`.

## Install and first run

Requirements:

- Claude Code on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH

### Install

Complete the [shared memory setup](../memory-setup.md), then run:

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh' && ~/.local/bin/sno setup --harness claude
```

`SNO_PROFILE_DIR` selects the profile root (default `~/.sno`). The shared setup
writes `<profile root>/settings.json` with the memory mode, store path, and key.
Keep a private backup of that file for store recovery.

Open a new Claude Code session inside a git repository, then check the installation:

```bash
sno memory doctor --harness claude
```

Create a test memory from the repository root:

```bash
sno memory remember --harness claude "Prefer tabs for indentation in this repository."
```

Verify it:

```bash
sno memory recall --harness claude "indentation"
```

## The three modes

### Local First

Local First makes no LLM calls and needs no LLM credential.

- Captures deterministic, verbatim content from your turns.
- Uses deterministic rules for profile merges and task classification or matching.
- Keeps both memories when a conflict needs model judgment.
- Does not generate a model-written reflection summary.
- Resolves relative dates without a model.

The local embedder may be downloaded once on first use. After it is cached, Local First processing
does not depend on a network service.

### Agent Native

When selected, Agent Native sends every model-assisted memory-writing call to your own
Claude Code.

The capture worker starts `claude -p` for each model call: one turn, hooks disabled, no tools, no
settings sources, no session persisted, working in the client's own state directory rather than
your repository. It runs on the Claude Code subscription you already have. No API key is
collected, and this client has no bring-your-own-key transport.

### REM Enhanced

REM Enhanced splits model-assisted memory work by capability. The Sno GPU handles the
LoRA-covered calls; your Claude Code handles the rest:

- Sno handles memory extraction.
- Sno handles conflict adjudication.
- Your Claude Code handles active-task classification, profile merging, completed-task matching,
  and relative-date resolution.

If a model request fails, only that request uses its Local First behavior. The client does not
silently reroute it to another model tier.

## Routing defaults

| Occasion | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Memory extraction | Deterministic, verbatim capture | Your Claude Code | Sno extraction model |
| Active-task classification | Keyword rules | Your Claude Code | Your Claude Code |
| Profile-section merge | Deterministic merge | Your Claude Code | Your Claude Code |
| Completed-task match | Token overlap | Your Claude Code | Your Claude Code |
| Conflict adjudication | Keep both memories | Your Claude Code | Sno conflict model |
| Reflection summary | No model reflection; local session memory remains | Same | Same |
| Relative-date resolution | No model call | Your Claude Code | Your Claude Code |

No call is off in Agent Native or REM Enhanced. Model-assisted writes run in the background
capture worker and fall back per request to the matching Local First behavior when necessary.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

Two REM operations run over the store on a periodic trigger and route model calls by the selected
mode:

- `rem-update` rewrites transition narratives into current-state memories and keeps the history;
- `rem-replace` adjudicates contradictions across the store and soft-closes the loser reversibly.

Both are requested by default. Change `rem.operations` in `settings.json` to request one, or
set `rem.tick` to `false` to turn the trigger off.

Mode selection governs memory writing. It does not make final claims about retrieval or reranker
routing.

## Change modes

The mode lives in `<profile root>/settings.json`. Edit it to change the mode.
Keep the same `store.path` and `store.encryptionKey` for an existing store;
a replacement key cannot open it. The file also holds `embedding`, `rerank`,
`recall`, and `rem` settings.

## Common defaults

The installation starts with:

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Scope | The current repository, plus `global` |
| Embedder | Local |
| Ambient capture | On |
| Auto-recall | On |
| Session handling | Local system session memory |
| Management tools | Off |
| Cloud observability | Off |

Keep these defaults until you have a specific reason to change them. In particular, changing the
embedding model or vector dimensions requires rebuilding the stored vectors, and this client has
no reset command for that; the OpenClaw plugin ships one (`openclaw sno-mem-config embedder
wipe-db`).

## Daily operation

### Hooks

The install command registers six Claude Code hooks. Each one is scoped to the git repository
that contains the session's working directory; outside a repository, and in subagents, hooks
inject and capture nothing.

| Hook | Timeout | What it does |
| --- | --- | --- |
| `SessionStart` | 15 s | Injects up to 5 memories (at most 3,500 characters) about standing decisions, open tasks, conventions, and pitfalls for the repository; imports the repository's Claude Code memory notes on first start |
| `UserPromptSubmit` | 8 s | Injects up to 3 memories (at most 1,500 characters) relevant to the prompt; prompts shorter than 12 characters are skipped |
| `Stop` | 5 s | Spools the completed turn and starts the capture worker |
| `SessionEnd` | 8 s | Tells the memory service the session has ended |
| `PreToolUse` | 5 s | Notes when a tool call starts, so its duration can be measured |
| `PostToolUse` | 8 s | Reports each finished tool call to the memory service |

A session receives at most 12,000 characters of injected memory in total, and a memory already
shown in the session is not shown again. The injected block is labelled as data, not
instructions, and names the `get` command for reading a full entry.

Capture runs in a detached worker, not in the hook. The worker lives at most 9 minutes, gives
each model call up to 110 seconds, retries a failed turn twice (after 2 and 10 seconds), and
hands off to a fresh worker when work remains.

### Memory commands

The skill teaches Claude these four commands. Run them from inside a git repository.

| Command | What it does |
| --- | --- |
| `sno memory recall --harness claude <query>` | Search repository and global memory (up to 5 results, full text with ids) |
| `sno memory get --harness claude <id>` | Print one full entry and, when it was corrected, the id that supersedes it |
| `sno memory remember --harness claude <text>` | Store a repository memory; prints the new id |
| `sno memory correct --harness claude <id> <text>` | Store a corrected entry and mark the old one superseded; prints the new id |

There is no deletion command in this client. With `sandbox.enabled: true`, the commands cannot
reach the local sidecar and print a failure line.

### Operator commands

| Command | What it does |
| --- | --- |
| `sno memory doctor --harness claude [--config-dir <dir>]` | Print sidecar health, hook state per event, permission rule state, and import receipts |
| `sno memory import --harness claude --repo <absolute-root>` | Queue a repository's Claude Code memory notes for import into that repository's memory |
| `sno setup --harness claude` | Install or refresh the hook groups, permission rule, and skill |

Import reads the `.md` files in Claude Code's memory directory for the project, under
`projects/` in the Claude configuration directory. A file is imported once per content hash; a
changed file is imported again. There is no user-level import, and instruction files and
transcripts are never imported.

### Read a memory store offline

`sno memory dump` runs the dump tool shipped with the OpenClaw plugin package and reads the same store format. Running it
through `npx` fetches that package into the npx cache and installs nothing into OpenClaw:

```bash
sno memory dump --db ~/.sno/sno-station-mem/$USER/memory.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Files and environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | The Claude configuration directory that `doctor` and `import` read; `install` takes it as `--config-dir` |
| `SNO_PROFILE_DIR` | `~/.sno` | The Sno profile that holds `settings.json`, the memory service, and this client's state |

The install command writes into the Claude configuration directory:

- `settings.json`: one hook group per event with the absolute program path, and one
  `permissions.allow` rule of the form `Bash(<program> *)`; a missing file is created with only
  these entries, and an unparsable file is left untouched;
- `skills/sno-mem-claude/SKILL.md`: the skill Claude reads.

It never writes `CLAUDE.md`, `CLAUDE.local.md`, rules files, project memory notes, or credentials.

The client keeps its own state under `~/.sno/sno-mem-claude/`: per-session receipts, the capture
spool, the worker lock and log, correction state, import receipts, and the child working
directory. The sidecar's discovery file and startup log live under `~/.sno/station/` and
`~/.sno/sno-station-mem/`.

Use the same `SNO_PROFILE_DIR` and repository root as the Codex client to share memories between
the two.

## Reinstall and data safety

Running `install` again refreshes the owned entries and touches nothing else. Removing the
package does not remove the store.

To reinstall:

```bash
npm install -g @snoai/mem-claude
sno setup --harness claude
```

The memory library is the encrypted file at `store.path`. Normal reinstall preserves it.
Back up that file and `settings.json` together; the file holds the only encryption key.

## Privacy and credentials

- Memory data is stored in encrypted local SQLite storage.
- Local First sends no memory text to an LLM service.
- Agent Native sends model-assisted memory work to your own Claude Code on your subscription.
- REM Enhanced uses Sno only for the memory-specialized calls listed above.
- Injected memory blocks are labelled as data, not instructions.
- `settings.json` holds the store key and Sno GPU key; keep the file private and backed up.
- Public setup never requires a private hostname, virtual-machine name, local repository path, or
  internal service token.

## Supported surfaces

Linux CLI installation and hook failure paths have real receipts. macOS CLI and Desktop
local-session support are untested. Cloud, web, SSH-hosted sessions, and the VS Code extension
are not covered.

## Troubleshooting

### `doctor` says the memory service is unavailable

The memory service starts on demand. For a new profile, follow the [shared memory setup](../memory-setup.md);
for an existing store, preserve its key while correcting the settings. Then run a memory command
and `doctor` again. If it stays unavailable, read `<profile root>/sno-station-mem/sidecar-startup.log`.

### `doctor` shows `absent`, `disabled`, or `unparsable` for a hook

`absent` means the hook group is missing: run `install` again. For invalid memory settings,
check `<profile root>/settings.json` and preserve the existing key.

### A memory command prints `no-repository-root`

Memory commands and hooks work inside a git repository. Change into the repository and retry.

### A command prints `correction-in-progress`

Another `correct` for the same id has not finished. Wait for it, or retry after two minutes if it
was interrupted.

### Nothing is captured after a session

1. Confirm the session ran inside a git repository.
2. Confirm the turn had both a prompt and an assistant reply; empty turns are skipped.
3. Confirm the session was not a subagent; subagents capture nothing.
4. Read `~/.sno/sno-mem-claude/worker.log` for the capture worker's result.
5. Confirm `claude` is on the PATH of the shell that started Claude Code; the worker runs it.

### Memory settings are unavailable

Check `<profile root>/settings.json` and its backup. Follow the shared setup only for a
new profile; never generate a replacement key for an existing store.
