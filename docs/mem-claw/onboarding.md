# Sno Memory for OpenClaw — Onboarding

This walkthrough describes the public first-run experience for `@snoai/mem-claw`.

## Start setup

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

Use the guided installer:

```bash
npx @snoai/mem-claw
```

Or install through OpenClaw first, then open the same wizard:

```bash
openclaw plugins install @snoai/mem-claw
npx @snoai/mem-claw --configure
```

The npm package is the public install source. You do not need a source checkout, a private server,
or a manually copied plugin directory.

The installer is additive over `openclaw plugins install`. It runs that command as a subprocess
when the plugin is not installed yet, then writes only the settings you selected into the OpenClaw
configuration.

## Step 1: choose the memory mode

The wizard asks for the memory profile and the embedder preset, then for the memory mode. Provider
and key questions come only after the mode, and only when that mode needs them.

The default mode is Agent Native.

### Local First

Choose Local First for fully local memory behavior:

- deterministic, verbatim capture;
- content-hash deduplication;
- deterministic profile and task handling;
- no model-written reflection summary;
- no LLM credentials.

The default embedder is local. It may download its model once on first use, then runs from the
local cache.

### Agent Native

Choose Agent Native to use the OpenClaw agent's own model inline.

Setup collects no key: Agent Native always borrows the host agent's model. It runs extraction
only; the model-written reflection summary (LLM mode `extraction+reflection`) is offered in REM
Enhanced.

Agent Native is enabled immediately after valid model access is found. Model calls run inline.

### REM Enhanced

Choose REM Enhanced to use the Sno GPU for the LoRA-covered extraction and conflict calls,
with the host agent's model covering the other model-assisted memory decisions. The wizard asks for
an optional Sno base URL (leave it blank for the default) and the required Sno key; host-model
calls use the agent's normal model configuration.

## Step 2: accept or change the remaining defaults

The wizard then asks for recall depth (Default or Lean) and, when OpenClaw's memory slot is
empty, whether to assign this plugin to it.

The standard defaults are:

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Memory profile | `local-active` (active capture and recall) |
| Embedder | Local |
| Reranking | Local lightweight processing |
| Recall depth | Default (Lean is about 25% cheaper and scores a few points lower) |
| Session handling | Local system session memory |
| Management tools | Off |
| Cloud observability | Off unless explicitly enabled |

Mode-specific defaults are:

| Memory-writing call | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | Deterministic, verbatim | Host model | Sno extraction model |
| Classify active tasks | Keyword rules | Host model | Host model |
| Merge profile sections | Deterministic merge | Host model | Host model |
| Match completed tasks | Token overlap | Host model | Host model |
| Resolve conflicts | Keep both | Host model | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Same as Local First | Host model |
| Resolve relative dates | No model call | Host model | Host model |

No memory-writing call is disabled in Agent Native or REM Enhanced. A failed model request
uses the corresponding Local First behavior for that request instead of switching model tiers.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

Two REM operations run over the store on a periodic trigger and route model calls by the selected
mode:

- `rem-update` rewrites transition narratives into clean current-state memories while keeping the
  history;
- `rem-replace` adjudicates contradictions across the store and soft-closes the losing memory
  reversibly.

The installer requests both by default. Use `--rem-operations rem-update` or
`--rem-operations rem-replace` to request one, and set `remEnhanced.trigger.tick` to `false` to
turn the trigger off. The trigger setting is read once, when the memory store is first set up.

The mode choice does not finalize retrieval or reranker behavior.

## Step 3: complete setup and restart

The completion message states:

- the selected memory profile, embedder, and LLM mode;
- whether the plugin was assigned to OpenClaw's memory slot;
- the environment variables the selected mode requires, or `none`;
- the exact restart command for the OpenClaw gateway;
- how to run setup again.

Keys collected by the wizard are written to the plugin's onboarding env file with mode 0600 and to
a systemd user drop-in for the gateway. The typed characters are never echoed.

After restarting OpenClaw, run:

```text
/memory status
```

The status shows the memory counts, the store path, and the sidecar process id. Use the installer
status command to review the saved setup:

```bash
npx @snoai/mem-claw --status
```

## Step 4: create the first useful memory

Start with information that will help every day:

- preferred language and tone;
- coding and review preferences;
- project rules;
- package-manager rules;
- preferred tools or commands;
- actions the agent should not repeat.

For example:

```text
Remember that I prefer concise replies and tabs for indentation.
```

Then verify:

```text
/memory stats
```

Do not use temporary debug state, test output, or private infrastructure details as first memories.

## Non-interactive installs

Package managers and automated OpenClaw installs may not have an interactive terminal. A
non-interactive install finishes with the public defaults and prints a short handoff. The end state
is identical to a plain `openclaw plugins install` followed by a restart. It tells the user to run
the guided setup later:

```bash
npx @snoai/mem-claw --configure
```

It never guesses a credential, prints a secret, or exposes a private endpoint.

## Already installed

Running the installer again does not overwrite a completed setup. It prints status unless you ask
to reconfigure:

```bash
npx @snoai/mem-claw --status
npx @snoai/mem-claw --configure
```

Re-running `--configure` does not ask again for a key that an earlier run already saved.

Normal reinstall preserves the memory library.

## Onboarding acceptance checklist

Onboarding is complete when:

- mode selection happens before provider details;
- Local First completes without an LLM credential;
- Agent Native borrows the host agent's model and asks for no key;
- REM Enhanced explains the Sno-covered and host-covered work in public terms;
- the completion message names the restart command and the required environment variables;
- `/memory status` works after restart and installer status can read the saved setup;
- the user can create and verify a first memory;
- no secret, private hostname, internal path, or deployment instruction appears in the handoff.
