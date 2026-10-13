# Sno Memory for OpenClaw — Usage Guide

This guide covers the public npm installation, three memory modes, common commands, and safe
configuration changes for `@snoai/mem-claw`.

## Install and first run

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

### Install

Complete the [memory service setup](../memory-setup.md) once, then install the plugin:

```bash
openclaw plugins install @snoai/mem-claw@1.2.13
```

To upgrade later, run `sno update`; OpenClaw refuses a second `openclaw plugins install` while its gateway is running.

`npx @snoai/mem-claw` runs the same install; its only option is `--profile <name>`, forwarded to
OpenClaw. The plugin starts the memory service from the path recorded by the memory service setup.

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

REM is how your agents dream: overnight they strengthen their memory and settle what they learned. It runs at most once a day for each part of your memory: usually overnight, or earlier the same day once about 100 new memories have piled up. REM Enhanced lets Sno's own memory models help with the two hardest jobs: writing down what matters from a conversation, and deciding which of two memories that disagree is right. Your OpenClaw agent does the rest. It needs a Sno key in `snoGpu.apiKey` in `settings.json`.

**Your data stays yours.** In this mode the memory text for the Sno calls, and the lessons your agents learn, go to your own space in Sno's cloud. It works like your own cloud drive: everything in it is yours, and a Sno program processes it for you alone. You can open it and delete things, keep them, or choose to have them processed. Nothing is deleted automatically, and Sno does not give any of it to anyone.

## Routing defaults

| What it does | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Writing down what matters | Saved word for word | Host model | Sno's memory model |
| Knowing what task you are on | Simple keyword matching | Host model | Host model |
| Updating what it knows about you | Fixed rules | Host model | Host model |
| Spotting finished tasks | Word matching | Host model | Host model |
| Settling memories that disagree | Keep both memories | Host model | Sno's memory model |
| Summing up the day | No model reflection; local session memory remains | Same as Local First | Host model |
| Turning "tomorrow" into a date | No model call | Host model | Host model |

No call is off in Agent Native or REM Enhanced. Model-assisted writes happen inline and fall
back per request to the matching Local First behavior when necessary.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

REM also tidies your memory on a schedule, in two ways:

- It rewrites "I used to... then I changed..." stories into one clean, current memory, and keeps the history.
- It settles memories that contradict each other. The one that lost is retired, and you can bring it back.

Both run by default. To turn REM's schedule off, set `rem.tick` to `false` in `~/.sno/settings.json`.

Mode selection governs memory writing. It does not make final claims about retrieval or reranker
routing.

## Change modes

The mode is the `mode` value in `~/.sno/settings.json` (`local-first`, `agent-native` or
`rem-enhanced`), the same for every plugin. Edit it, keep the existing `store.encryptionKey`, and
restart OpenClaw. The installer has no flags for this.

## Daily operation

### Chat commands

| Command | What it does |
| --- | --- |
| `/memory status` | Show memory counts, the store path, and the memory service's process id |
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
- Agent Native uses the host agent's model; no key is collected. By default it also uploads the day's sessions to Sno each night for cloud lessons and skill review and can bring one cloud lesson back on a session's first prompt; you can turn both off in `~/.sno/settings.json`.
- REM Enhanced uses Sno for the memory-specialized calls listed above and for the same nightly session upload. The memory text for those calls goes to your own space in Sno's cloud, which works like your own cloud drive: a Sno program processes it for you alone, and you can delete it whenever you want.
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
