# Sno Memory for Claude Code

Long-term memory for Claude Code sessions. The memory service stores and retrieves project memories;
this plugin connects host hooks and the commands `recall`, `get`, `remember`, and `correct`.

## Install

Install Node.js 22.22.3+, 24.15.0+, or 25.9.0+ and Claude Code. Complete the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
once, then run:

```bash
npm install -g @snoai/mem-claude@1.0.0
sno-mem-claude install --config-dir ~/.claude
```

The shared setup installs the memory service and writes `~/.sno/settings.json`. The hooks
start the service when needed. Use `SNO_PROFILE_DIR` to select another profile root.

Open a new Claude Code session in your project. Run `sno-mem-claude doctor` to check the installation.
The plugin captures turns in the background and recalls relevant memory on session start and
prompts. Use `sno-mem-claude remember "Prefer tabs in this repository"` and
`sno-mem-claude recall "indentation"` for explicit memory operations. Correct an identified wrong entry with
`sno-mem-claude correct <id> "correct text"`; it returns a fresh id and keeps the previous entry
visible as retired history. Automatic memory blocks come from the service; child agents do not
inject memory or capture turns.

## Modes

The first-release setup selects Local First in `settings.json`, which stores memory locally.
Agent Native uses your host subscription for model-assisted work; REM Enhanced also uses
Sno's memory models. Preserve the existing encryption key when changing settings.

## License

Licensed under [Apache-2.0](LICENSE).
