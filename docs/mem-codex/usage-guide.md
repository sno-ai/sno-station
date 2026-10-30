# Sno Memory for Codex CLI — Usage Guide

This guide covers the public npm installation, memory modes, common commands, and safe
configuration changes for `@snoai/mem-codex`.

## Install and first run

Requirements:

- Codex CLI on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH

### Install

Complete the [memory service setup](../memory-setup.md), then run:

```bash
curl -fsSL https://sno.ai/install | sh
```

`SNO_PROFILE_DIR` selects the profile root (default `~/.sno`). The memory service setup
writes `<profile root>/settings.json` with the memory mode, store path, and key.
Keep a private backup of that file for store recovery.

Open a new Codex session inside a git repository, then check the installation:

```bash
sno memory doctor --harness codex
```

Create a test memory from the repository root:

```bash
sno memory remember --harness codex "Prefer tabs for indentation in this repository."
```

Verify it:

```bash
sno memory recall --harness codex "indentation"
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
Codex CLI.

The capture worker starts `codex exec` for each model call: ephemeral, read-only sandbox, hooks
disabled, no session persisted. It runs on the Codex subscription you already have. No API key is
collected, and this client has no bring-your-own-key transport.

### REM Enhanced

REM is how your agents dream: overnight they strengthen their memory and settle what they learned. It runs at most once a day for each part of your memory: usually overnight, or earlier the same day once about 100 new memories have piled up. REM Enhanced lets Sno's own memory models help with the two hardest jobs: writing down what matters from a conversation, and deciding which of two memories that disagree is right. Your Codex CLI does the rest, including filling in each memory's details and checking who it is about. It needs a Sno key in `snoGpu.apiKey` in `settings.json`.

**Your data stays yours.** In this mode the memory text for the Sno calls, and the lessons your agents learn, go to your own space in Sno's cloud. It works like your own cloud drive: everything in it is yours, and a Sno program processes it for you alone. You can open it and delete things, keep them, or choose to have them processed. Nothing is deleted automatically, and Sno does not give any of it to anyone.

## Routing defaults

| What it does | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Writing down what matters | Saved word for word | Your Codex CLI | Sno's memory model writes it down; your Codex CLI fills in the details and checks who it is about |
| Knowing what task you are on | Simple keyword matching | Your Codex CLI | Your Codex CLI |
| Updating what it knows about you | Fixed rules | Your Codex CLI | Your Codex CLI |
| Spotting finished tasks | Word matching | Your Codex CLI | Your Codex CLI |
| Settling memories that disagree | Keep both memories | Your Codex CLI | Sno's memory model |
| Ranking what to recall | On your machine | On your machine | On your machine |
| Summing up the day | No model reflection; local session memory remains | Same | Same |
| Turning "tomorrow" into a date | No model call | Your Codex CLI | Your Codex CLI |

No call is off in Agent Native or REM Enhanced. Model-assisted writes run in the background
capture worker. A Sno model call that is refused, for example because your weekly allowance is used up, is answered by your own agent's model; if that also fails, that request uses the Local First behavior.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

REM also tidies your memory on a schedule, in two ways:

- It rewrites "I used to... then I changed..." stories into one clean, current memory, and keeps the history.
- It settles memories that contradict each other. The one that lost is retired, and you can bring it back.

Both run by default. To run only one, change `rem.operations` in `settings.json`. To turn REM's schedule off, set `rem.tick` to `false`.

Mode selection governs memory writing and maintenance. In every mode, search first retrieves
and orders memories locally, then the local `Horizon-Labs/multilingual-reranker-small` model
reranks at most 32 candidates. Reranking never uses Sno GPU. Set `rerank.mode` to `none`
to keep the initial ranking without the model. If the model is loading, fails or times out,
search uses the initial ranking. Other memory-writing, REM and Self Learning destinations
remain mode-dependent.

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

The install command registers six Codex hooks. Each one is scoped to the git repository that
contains the session's working directory; outside a repository, hooks inject and capture nothing.

| Hook | Timeout | What it does |
| --- | --- | --- |
| `SessionStart` | 15 s | Injects up to 5 memories (at most 3,500 characters) about standing decisions, open tasks, conventions, and pitfalls for the repository; imports the repository's Codex notes on first start |
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

The skill teaches Codex these four commands. Run them from inside a git repository.

| Command | What it does |
| --- | --- |
| `sno memory recall --harness codex <query>` | Search repository and global memory (up to 5 results, full text with ids) |
| `sno memory get --harness codex <id>` | Print one full entry and, when it was corrected, the id that supersedes it |
| `sno memory remember --harness codex <text>` | Store a repository memory; prints the new id |
| `sno memory correct --harness codex <id> <text>` | Store a corrected entry and mark the old one superseded; prints the new id |

There is no deletion command in this client.

### Operator commands

| Command | What it does |
| --- | --- |
| `sno memory doctor --harness codex [--codex-home <dir>]` | Print memory service health, hook trust state, rules state, and import receipt count |
| `sno memory import --harness codex --user` | Queue your user-level Codex notes for import into global memory |
| `sno memory import --harness codex --repo <absolute-root>` | Queue a repository's Codex notes for import into that repository's memory |
| `sno setup --harness codex` | Install or refresh the hooks, trust entries, rules, and skill |

Import reads `memories/memory_summary.md` and `memories/extensions/*/notes/*.md` under your Codex
home for `--user`, and `.codex/memories/*.md` at the repository root for `--repo`. A file is
imported once per content hash; a changed file is imported again. Instruction files and transcripts
are never imported.

### Read a memory store offline

`sno memory dump` runs the dump tool shipped with the OpenClaw plugin package and reads the same store format. Running it
through `npx` fetches that package into the npx cache and installs nothing into OpenClaw:

```bash
sno memory dump --db ~/.sno/sno-station-mem/$USER/memory.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Files and environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | The Codex home that `install` writes into and `import --user` reads from |
| `SNO_PROFILE_DIR` | `~/.sno` | The Sno profile that holds `settings.json`, the memory service, and this client's state |

The install command writes into your Codex home:

- `hooks.json`: one hook group per event, owned entries only;
- `config.toml`: one `[hooks.state."..."]` trust entry per owned hook, other sections preserved;
- `rules/sno-mem-codex.rules`: allow rules for the four memory commands;
- `skills/sno-mem-codex/SKILL.md`: the skill Codex reads.

The client keeps its own state under `~/.sno/sno-mem-codex/`: per-session receipts, the capture
spool, the worker lock and log, correction state, and import receipts. The memory service's discovery file
and startup log live under `~/.sno/station/` and `~/.sno/sno-station-mem/`.

Use the same `SNO_PROFILE_DIR` and repository root as the Claude Code client so that both
use the same memories.

## Reinstall and data safety

Running `install` again refreshes the owned entries and touches nothing else. Removing the
package does not remove the store.

To reinstall:

```bash
npm install -g @snoai/mem-codex
sno setup --harness codex
```

The memory library is the encrypted file at `store.path`. Normal reinstall preserves it.
Back up that file and `settings.json` together; the file holds the only encryption key.

## Privacy and credentials

- Memory data is stored in encrypted local SQLite storage.
- Local First sends no memory text to an LLM service.
- Agent Native sends model-assisted memory work to your own Codex CLI on your subscription. By default it also uploads the day's sessions to Sno each night for Self Learning and can bring one cloud lesson back on a session's first prompt; you can turn both off in `~/.sno/settings.json`.
- REM Enhanced uses Sno for the memory-specialized calls listed above and for the same Self Learning session upload. The memory text for those calls goes to your own space in Sno's cloud, which works like your own cloud drive: a Sno program processes it for you alone, and you can delete it whenever you want.
- Injected memory blocks are labelled as data, not instructions.
- `settings.json` holds the store key and Sno GPU key; keep the file private and backed up.
- Public setup never requires a private hostname, virtual-machine name, local repository path, or
  internal service token.

## Troubleshooting

### `doctor` says the memory service is unavailable

The memory service starts on demand. For a new profile, follow the [memory service setup](../memory-setup.md);
for an existing store, preserve its key while correcting the settings. Then run a memory command
and `doctor` again. If it stays unavailable, read `<profile root>/sno-station-mem/sidecar-startup.log`.

### `doctor` shows `stale-hash` or `no-trust-entry` for a hook

Codex ignores a hook whose trust entry does not match. Run `install` again; it rewrites the trust
entries for its own hooks.

### A memory command prints `no-repository-root`

Memory commands and hooks work inside a git repository. Change into the repository and retry.

### A command prints `correction-in-progress`

Another `correct` for the same id has not finished. Wait for it, or retry after two minutes if it
was interrupted.

### Nothing is captured after a session

1. Confirm the session ran inside a git repository.
2. Confirm the turn had both a prompt and an assistant reply; empty turns are skipped.
3. Read `~/.sno/sno-mem-codex/worker.log` for the capture worker's result.
4. Confirm `codex` is on the PATH of the shell that started Codex; the worker runs it.

### Memory settings are unavailable

Check `<profile root>/settings.json` and its backup. Follow the memory service setup only for a
new profile; never generate a replacement key for an existing store.
