# @snoai/memory

The memory engine behind Sno Station: encrypted, local, used by every agent you run.

It stores what your coding agents learn, finds it again when it matters, and corrects it
without losing history. Claude Code, Codex, OpenClaw and Hermes Agent all talk to this one
engine, so what one agent learns is there for the next.

- **Capture and recall.** Completed turns are extracted into memories; recall combines vector
  search and keyword search, scoped to the repository you work in plus a global scope.
- **Corrections keep history.** A corrected memory is retired, not deleted, and points to its
  replacement. Automatic recall only shows what is current.
- **Encrypted from first use.** The store is a SQLite database encrypted with a key made once
  on your machine (`@snoai/sqlite-crypto`). Sno never receives your database or your key.
- **No account, no API key to start.** Local First mode runs fully on your machine; Agent
  Native and REM Enhanced let a model help with the memory work. REM is how your agents dream: overnight they strengthen their memory and settle what they learned. In REM Enhanced your memory text and lessons go to your own space in Sno's cloud, which works like your own cloud drive: a Sno program processes it for you alone, and you can delete it at any time.
- **Eight languages.** English, Chinese (Simplified and Traditional), Japanese, Korean,
  German, French, Spanish and Russian, with each memory stored with its language.
- **No daemon.** The engine runs as a local service on `127.0.0.1` that the agent plugins
  start when they need it.

Who it is for: you do not use this package directly. Follow the
[memory service setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
(it installs this package into `~/.sno`), then add the plugin for your agent:
[Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude) or
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw). The `client` export is what the
plugins use to reach the service.

```bash
npm install @snoai/memory@1.7.1
```

Needs Node.js 22.22.3+, 24.15.0+ or 25.9.0+. Licensed under Apache-2.0.
