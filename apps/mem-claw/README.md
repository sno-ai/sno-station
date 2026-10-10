# Sno Memory for OpenClaw

Start a new OpenClaw conversation and most agents have forgotten the last one. Sno Memory keeps
it: an encrypted memory on your own machine that your OpenClaw agents write to and read from
across conversations.

## What you get

- **Agents that remember.** Relevant memories are recalled automatically, and the agent can
  store, look up and open entries itself with `memory_store`, `memory_recall` (also
  `memory_search`) and `memory_get`.
- **Mistakes get corrected, not erased.** `memory_correct` writes the right text as a new entry
  and marks the old one retired. Explicit recall shows retired history with its replacement;
  automatic context only shows what is current. The model has no delete action.
- **One memory for every agent.** Codex, Claude Code, Hermes Agent and OpenClaw read the same
  `~/.sno/settings.json`, so what one learns is there for the others.
- **Yours, and it stays yours.** The store is encrypted from first use with a key made once on
  your machine. Sno never receives your database or your key. There is no daemon to babysit:
  the plugin starts the memory service when it needs it.
- **No account, no API key.** The default mode runs on your machine. After a one-time model
  download during setup, recall works offline. It works in English, Chinese, Japanese, Korean,
  German, French, Spanish and Russian.

## Get started

1. Follow the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md).
   It takes a few minutes and runs once for every agent on the machine. You need Node.js
   22.22.3+, 24.15.0+ or 25.9.0+.
2. Install the plugin:

   ```bash
   openclaw plugins install @snoai/mem-claw@1.2.7
   ```

3. Restart OpenClaw, tell an agent "Remember that I prefer tabs for indentation", start a new
   conversation and ask what you prefer.

Walkthrough: [OpenClaw onboarding](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claw/onboarding.md).
Daily use and troubleshooting: [usage guide](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claw/usage-guide.md).

## Modes

**Local First** (what the shared setup selects) keeps memory work on your machine with no model
call. **Agent Native** uses the OpenClaw agent's own model, and **REM Enhanced** uses Sno's
memory models for extraction and conflict checks and the agent's model for the rest. The
`recall` and `capture` groups in `~/.sno/settings.json` set recall limits and what gets
captured. Keep the existing encryption key when you edit it.

## Under the hood

This package is the OpenClaw side only: it registers the memory tools and the `sno-mem`
command. The memory itself lives in [`@snoai/memory`](https://www.npmjs.com/package/@snoai/memory),
a local service on `127.0.0.1` that owns the encrypted SQLite store, vector and keyword search,
and the local embedding model. Uninstalling the plugin does not erase the store.

## License

Licensed under [Apache-2.0](LICENSE).
