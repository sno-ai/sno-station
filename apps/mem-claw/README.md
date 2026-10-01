# Memory service for OpenClaw

This plugin gives OpenClaw agents long-term memory across conversations. The memory service and every plugin read the same `<profile root>/settings.json` file.

## Install

Install OpenClaw and a supported Node.js version (22.22.3+, 24.15.0+, or 25.9.0+).
Complete the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
once, then run:

```bash
openclaw plugins install @snoai/mem-claw@1.0.0
```

The plugin starts the memory service from the path recorded by the shared setup. There is no separate memory start command.

## Memory modes

The mode in `settings.json` controls where memory model calls go. Local First keeps memory processing local; Agent Native uses the host agent's model; REM Enhanced uses Sno models for selected extraction and conflict calls and the host model for the rest. The same settings apply to OpenClaw, Codex, Claude Code, and Hermes.

The `recall` group controls automatic and explicit recall limits. The `capture` group controls ambient and assistant-message capture, session memory, and the session strategy. Preserve the existing encryption key when changing settings.

## Use

Ask the agent to remember a preference, then start a new conversation and ask about it. The agent uses `memory_recall` (also available as `memory_search`), `memory_get` with a memory id, `memory_store`, and `memory_correct`. Correction creates a new memory and marks the old one retired. Explicit recall and get include retired history with its successor id; automatic context contains only current memories. The model has no delete action.

The local store is encrypted. Uninstalling the OpenClaw plugin does not erase it. For setup or settings errors, check the shared setup and preserve the existing key.

## License

Licensed under [Apache-2.0](LICENSE).
