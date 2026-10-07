# Sno Memory for OpenClaw — Onboarding

First-run steps for `@snoai/mem-claw`.

## Step 1: set up the shared memory service

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

Complete the [shared memory setup](../memory-setup.md) once. It writes `~/.sno/settings.json` in
Local First mode and downloads the embedding model. Do not rerun its settings block for an
existing store: it replaces the encryption key and the old memories become unreadable.

## Step 2: install the plugin

```bash
openclaw plugins install @snoai/mem-claw@1.1.0
```

`npx @snoai/mem-claw` runs the same install. Its only option is `--profile <name>`, which is
forwarded to OpenClaw. The plugin starts the memory service from the path recorded by the shared
setup; there is no separate start command.

## Step 3: restart OpenClaw and check

After restarting OpenClaw, run:

```text
/memory status
```

The status shows the memory counts, the store path, and the sidecar process id.

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

## Change settings later

Every plugin reads the same `~/.sno/settings.json`. Edit it, keep the existing
`store.encryptionKey`, and restart OpenClaw. Installing the plugin again preserves the memory
library.
