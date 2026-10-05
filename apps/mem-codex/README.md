# Sno Memory for Codex CLI

Close a Codex session and most of what it learned is gone. Sno Memory keeps it: an encrypted
memory on your own machine that Codex fills as you work and reads from at the start of every
session.

## What you get

- **It remembers without being asked.** Every completed turn is captured in the background.
  Relevant memories come back when a session starts and before each prompt.
- **Say it, and it is stored.** `remember` saves a fact right now, `recall` looks one up, and
  `get` opens a full entry by id.
- **Mistakes get corrected, not erased.** `correct` writes the right text as a new entry and keeps
  the old one as retired history. Automatic recall only shows what is current.
- **Scoped to your work.** Memory belongs to the git repository you are in, plus a global scope
  you can read everywhere. Other agents that use the same setup (Claude Code, OpenClaw, Hermes
  Agent) share it.
- **Yours, and it stays yours.** The store is encrypted from first use with a key made once on
  your machine. Sno never receives your database or your key. There is no daemon to babysit:
  the memory service starts when Codex needs it.
- **No account, no API key.** The default mode runs on your machine. After a one-time model
  download during setup, recall works offline. It works in English, Chinese, Japanese, Korean,
  German, French, Spanish and Russian.

## Get started

1. Follow the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md).
   It takes a few minutes and runs once for every agent on the machine.
2. Install the plugin (Node.js 22.22.3+, 24.15.0+ or 25.9.0+, and `git`):

   ```bash
   npm install -g @snoai/mem-codex@1.0.1
   sno setup --harness codex
   ```

3. Open a new Codex session inside a git repository, then try it:

   ```bash
   sno memory doctor --harness codex
   sno memory remember --harness codex "Prefer tabs in this repository"
   sno memory recall --harness codex "indentation"
   ```

   `doctor` should report `sidecar: healthy`. To fix a wrong entry:
   `sno memory correct --harness codex <id> "correct text"`. Child agents do not read or write memory.

Walkthrough: [Codex onboarding](https://github.com/sno-ai/sno-station/blob/main/docs/mem-codex/onboarding.md).
Daily use and troubleshooting: [usage guide](https://github.com/sno-ai/sno-station/blob/main/docs/mem-codex/usage-guide.md).

## Modes

**Local First** (what the shared setup selects) needs no model and no API key: capture is
verbatim and everything stays on your machine. **Agent Native** lets Codex itself do the memory
work on your existing subscription, and **REM Enhanced** also uses Sno's memory models for
extraction and conflict checks, which needs a Sno key in `settings.json`. Change the mode in
`~/.sno/settings.json`, and keep the existing encryption key.

## Under the hood

This package is the Codex side only: it installs Codex hooks and adds the memory commands.
The memory itself lives in [`@snoai/memory`](https://www.npmjs.com/package/@snoai/memory), a
local service on `127.0.0.1` that owns the encrypted SQLite store, vector and keyword search,
and the local embedding model.

## License

Licensed under [Apache-2.0](LICENSE).
