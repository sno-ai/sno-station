# Sno Memory for OpenClaw — Usage Guide

This guide covers the public npm installation, three memory modes, common commands, and safe
configuration changes for `@snoai/mem-claw`.

## Install and first run

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

### Install

Complete the [shared memory setup](../memory-setup.md) once, then install the plugin:

```bash
openclaw plugins install @snoai/mem-claw@1.2.0
```

`npx @snoai/mem-claw` runs the same install; its only option is `--profile <name>`, forwarded to
OpenClaw. The plugin starts the memory service from the path recorded by the shared setup.

Use the published npm package for public installs. Do not build from a private monorepo, copy a
local build to another machine, or configure a private service address.

Restart the OpenClaw gateway, then run:

```text
/memory status
```

Create a test memory:

```text
Remember that I prefer tabs for indentation.
```

Verify it:

```text
/memory stats
```

## The three modes

### Local First

Local First makes no LLM calls and needs no LLM credential.

- Captures deterministic, verbatim user content.
- Removes exact duplicates with content hashes.
- Uses deterministic rules for profile merges and task classification or matching.
- Keeps both memories when a conflict needs model judgment.
- Does not generate a model-written reflection summary.
- Resolves relative dates without a model.

The local embedder may be downloaded once on first use. After it is cached, Local First processing
does not depend on a network service.

### Agent Native

Agent Native is the default. It sends every model-assisted memory-writing call to the OpenClaw
agent's configured model.

Agent Native collects no key: it always borrows the host agent's model.
Agent Native runs extraction only. The reflection summary (LLM mode `extraction+reflection`) is
available in REM Enhanced.

Calls run inline.

### REM Enhanced

REM Enhanced splits model-assisted memory work by capability. The Sno GPU handles the
LoRA-covered calls; the host model handles the rest:

- Sno handles memory extraction.
- Sno handles conflict adjudication.
- The host model handles active-task classification, profile merging, completed-task matching,
  reflection summaries, and relative-date resolution.

If a model request fails, only that request uses its Local First behavior. The plugin does not
silently reroute it to another model tier.

## Routing defaults

| Occasion | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Memory extraction | Deterministic, verbatim capture | Host model | Sno extraction model |
| Active-task classification | Keyword rules | Host model | Host model |
| Profile-section merge | Deterministic merge | Host model | Host model |
| Completed-task match | Token overlap | Host model | Host model |
| Conflict adjudication | Keep both memories | Host model | Sno conflict model |
| Reflection summary | No model reflection; local session memory remains | Same as Local First | Host model |
| Relative-date resolution | No model call | Host model | Host model |

No call is off in Agent Native or REM Enhanced. Model-assisted writes happen inline and fall
back per request to the matching Local First behavior when necessary.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

Two REM operations run over the store on a periodic trigger and route model calls by the selected
mode:

- `rem-update` rewrites transition narratives into current-state memories and keeps the history;
- `rem-replace` adjudicates contradictions across the store and soft-closes the loser reversibly.

Both run by default, and setting `rem.tick` to `false` in `~/.sno/settings.json` turns the trigger
off.

Mode selection governs memory writing. It does not make final claims about retrieval or reranker
routing.

## Change modes

The mode is the `mode` value in `~/.sno/settings.json` (`local-first`, `agent-native` or
`rem-enhanced`), shared by every plugin. Edit it, keep the existing `store.encryptionKey`, and
restart OpenClaw. The installer has no flags for this.

## Daily operation

### Chat commands

| Command | What it does |
| --- | --- |
| `/memory status` | Show memory counts, the store path, and the sidecar process id |
| `/memory stats` | Show memory counts by scope and category |
| `/memory search <query>` | Search memory explicitly |
| `/memory clear --yes --scope <scope>` | Delete memories in one scope |

`/memory clear` is destructive. Confirm the scope and keep a backup before deleting important
memory.

### Operator commands

The plugin registers an `openclaw sno-mem` command group for the terminal:

| Command | What it does |
| --- | --- |
| `openclaw sno-mem list [--scope <scope>] [--category <c>] [--limit <n>] [--offset <n>]` | List memories |
| `openclaw sno-mem search <query> [--scope <scope>] [--limit <n>]` | Search memory |
| `openclaw sno-mem stats [--scope <scope>]` | Print counts as JSON |
| `openclaw sno-mem delete --id <id> \| --query <query> [--yes]` | Delete by id or by search |
| `openclaw sno-mem export --scope <scope> [--output <file>]` | Export one scope as JSON Lines |
| `openclaw sno-mem import <file> [--scope <scope>]` | Store every JSON Lines row |

### Agent tools

The agent may use these tools:

| Tool | Purpose | Enabled |
| --- | --- | --- |
| `memory_recall` | Search for relevant memory | Always |
| `memory_store` | Store a specific memory | Always |
| `memory_update` | Correct or enrich an existing memory | Always |
| `memory_forget` | Delete a memory | Always |
| `memory_stats` | Inspect memory counts programmatically | `enableManagementTools` |
| `memory_list` | List memories by filters | `enableManagementTools` |

Management tools are off by default. Turn them on with `enableManagementTools: true` in the plugin
configuration.

### Read a memory store offline

`sno memory dump` runs the dump tool this package ships. It prints memory rows as JSON Lines without changing the
encrypted store:

```bash
sno memory dump --db ~/.openclaw/mem-claw/mem-claw.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Capture and reinstall

To stop automatic capture without uninstalling, turn off ambient capture in the `capture` group of
`~/.sno/settings.json` and limit automatic recall in the `recall` group, then restart the gateway.
Explicit `memory_store` calls and `/memory` commands are separate and keep working.

Normal uninstall and reinstall preserve the memory library:

```bash
openclaw plugins uninstall sno-mem-claw
openclaw plugins install @snoai/mem-claw
```

## Embedding changes

One memory database cannot mix vectors from different embedding dimensions. If you intentionally
change the embedding model or dimension, stop OpenClaw, back up the memory library, and reset the
database before restarting:

```bash
openclaw sno-mem-config embedder show
openclaw sno-mem-config embedder wipe-db --confirm --force
```

The wipe command deletes memory data. It is not part of normal mode switching or reinstall.

## Privacy and credentials

- Memory data is stored in encrypted local SQLite storage.
- Local First sends no memory text to an LLM service.
- Agent Native uses the host agent's model; no key is collected.
- REM Enhanced uses Sno only for the memory-specialized calls listed above.
- Settings and the encryption key live in `~/.sno/settings.json` (mode 0600); keep a private backup.
- Public setup never requires a private hostname, virtual-machine name, local repository path, or
  internal service token.

## Troubleshooting

### Agent Native cannot reach a model

Agent Native needs the OpenClaw agent's own model to be configured and working; it needs no key in
`settings.json`.

### Capture produces Local First output in a model-assisted mode

A model call may have failed and fallen back for that request. Check `/memory status` and the
OpenClaw logs for a visible credential, quota, timeout, or provider error. Fix model access, then
retry with a new statement. Do not add a private endpoint from an internal troubleshooting note.

### The plugin does not appear after install

1. Confirm Node.js meets the requirement above.
2. Restart the OpenClaw gateway.
3. Run `/memory status`.
4. If the command is missing, inspect the OpenClaw plugin log for `sno-mem-claw` registration
   errors.

### A first memory is not stored

1. Confirm capture is not turned off in the `capture` group of `~/.sno/settings.json`.
2. Use a concrete preference or fact rather than a greeting.
3. Run `/memory stats` after the agent replies.
4. Check the OpenClaw logs for capture or embedder errors.
