# Sno Memory for Hermes Agent

Long-term memory for [Hermes Agent](https://github.com/NousResearch/hermes-agent) sessions.

Sno Memory captures useful facts, preferences, decisions, and lessons so Hermes can carry context
across sessions and across compression. The same memory store is shared with Sno Memory for Codex
CLI and Claude Code on the same machine.

`sno-mem-hermes` is a thin Hermes memory plugin for the local Sno Station Mem sidecar. The sidecar
owns storage, extraction, and retrieval. This plugin owns the Hermes lifecycle hooks, the startup
brief, the compression checkpoint, and four model tools: `sno_memory_recall`, `sno_memory_get`,
`sno_memory_remember`, and `sno_memory_correct`.

## Quickstart

Requirements:

- Hermes Agent on your PATH (Python 3.11 to 3.13)
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

The plugin does not carry the sidecar. It starts the `sno-station-mem` command found on your PATH,
so install the sidecar first:

```bash
npm install -g @snoai/sno-station-mem@next
echo '{"mode":"local-first"}' | sno-station-mem bind ~/.sno/sno-station-mem/$USER/memory.sqlite
hermes plugins install sno-ai/sno-station/apps/mem-hermes/sno-mem-hermes --enable
hermes config set memory.provider sno-mem-hermes
```

The bind command runs once per machine user and records the memory mode; if you already bound a
store for Codex CLI or Claude Code, skip it. Replace `local-first` with `agent-native` or
`rem-enhanced` to choose another mode; the modes are described in the
[Codex CLI plugin README](https://github.com/sno-ai/sno-station/tree/main/apps/mem-codex#choose-a-memory-mode).

Setting `memory.provider` replaces any memory provider Hermes used before.

Start a new Hermes session. The first turn carries a short working brief when your project has
stored memory.

## Update and remove

```bash
npm install -g @snoai/sno-station-mem@next
hermes plugins update sno-mem-hermes
```

```bash
hermes plugins remove sno-mem-hermes
```

Removing the plugin does not remove the store. The memory library is the bound store file; back it
up before any manual change to the store or the binding.

## License

Licensed under [Apache-2.0](LICENSE).
