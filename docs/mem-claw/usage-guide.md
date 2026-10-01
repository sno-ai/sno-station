# Sno Memory for OpenClaw — Usage Guide

This guide covers the public npm installation, three memory modes, common commands, and safe
configuration changes for `@snoai/mem-claw`.

## Install and first run

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

### Guided install

```bash
npx @snoai/mem-claw
```

The wizard installs the plugin if needed, asks for the memory profile, the embedder, and the memory
mode, collects only the credentials required by that mode, and writes the OpenClaw configuration.

### OpenClaw-native install

```bash
openclaw plugins install @snoai/mem-claw
npx @snoai/mem-claw --configure
```

Use the published npm package for public installs. Do not build from a private monorepo, copy a
local build to another machine, or configure a private service address.

Restart the OpenClaw gateway when the installer asks, then run:

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

The guided wizard collects no key for Agent Native: it always borrows the host agent's model.
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

The installer requests both by default (`--rem-operations`), and `remEnhanced.trigger.tick: false`
turns the trigger off. The trigger setting is read once, when the memory store is first set up.

Mode selection governs memory writing. It does not make final claims about retrieval or reranker
routing.

## Change modes

Open the wizard again:

```bash
npx @snoai/mem-claw --configure
```

Or select a mode directly:

```bash
npx @snoai/mem-claw --configure --mode local-first
npx @snoai/mem-claw --configure --mode agent-native
npx @snoai/mem-claw --configure --mode rem-enhanced
```

Use direct flags only when the needed host access or credential is already available. Interactive
setup is recommended when choosing a mode for the first time because it explains each mode before
writing the configuration.

Other installer flags:

| Flag | Effect |
| --- | --- |
| `--memory-profile <p>` | `local-active`, `capture-only`, `manual-only`, or `custom` |
| `--embedder <preset>` | Embedding preset |
| `--llm-mode <m>` | `off`, `extraction`, or `extraction+reflection` |
| `--rem-operations <v>` | `both` (default), `rem-update`, or `rem-replace` |
| `--default` / `--lean` | Recall depth without prompting |
| `--no-slot` | Do not assign the plugin to OpenClaw's memory slot |
| `--non-interactive` | No prompts; same end state as a plain `openclaw plugins install` |
| `--profile <name>` | Forwarded to every `openclaw` call |

Check the result without changing configuration:

```bash
npx @snoai/mem-claw --status
```

Restart OpenClaw after a mode change.

## Common defaults

The guided installer starts with:

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Memory profile | `local-active` (active capture and recall) |
| Embedder | Local |
| Reranking | Local lightweight processing |
| Recall depth | Default |
| Session handling | Local system session memory |
| Management tools | Off |
| Cloud observability | Off unless explicitly enabled |

Keep these defaults until you have a specific reason to change them. In particular, changing the
embedding model or vector dimensions requires rebuilding the stored vectors.

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

The package ships `sno-memdump`. It prints memory rows as JSON Lines without changing the
encrypted store:

```bash
npx --package @snoai/mem-claw sno-memdump --db ~/.openclaw/mem-claw/mem-claw.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Capture profiles and reinstall

To stop automatic capture without uninstalling, switch the memory profile:

```bash
npx @snoai/mem-claw --configure --memory-profile manual-only
```

`manual-only` turns off ambient capture and auto-recall; explicit `memory_store` calls and
`/memory` commands keep working. `capture-only` keeps ambient capture on and turns off auto-recall.
`local-active` has both on. Restart the gateway after the change.

Normal uninstall and reinstall preserve the memory library:

```bash
openclaw plugins uninstall sno-mem-claw
openclaw plugins install @snoai/mem-claw
```

Run setup again only when you want to change the selected mode or other onboarding choices:

```bash
npx @snoai/mem-claw --configure
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
- Keys entered in the wizard are stored in the plugin's onboarding env file (mode 0600) and a
  systemd user drop-in for the gateway, never in the committed OpenClaw configuration.
- The installer names a missing credential without printing its value.
- Public setup never requires a private hostname, virtual-machine name, local repository path, or
  internal service token.

## Troubleshooting

### The wizard cannot finish Agent Native setup

Run the interactive wizard instead of a non-interactive install:

```bash
npx @snoai/mem-claw --configure
```

Agent Native needs the OpenClaw agent's own model to be configured and working; the wizard does not
ask for a key.

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

1. Run `npx @snoai/mem-claw --status` and confirm the memory profile is not `manual-only`.
2. Use a concrete preference or fact rather than a greeting.
3. Run `/memory stats` after the agent replies.
4. Check the OpenClaw logs for capture or embedder errors.

### Setup is already complete

The default installer invocation prints status instead of rewriting a completed configuration.
Use `--configure` when you intentionally want to change it.
