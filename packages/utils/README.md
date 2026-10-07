# @snoai/utils

Structured logging for Sno Station packages, in one small library.

It gives each package a logger that writes JSON diagnostic records to a daily-rotating log file
under the Sno profile directory, and keeps those records safe to keep:

- a log-site catalog, so every log line comes from a known place in the code;
- log context that follows an async call (`withLogContext`, `currentLogContext`);
- attribute sanitizing before anything is written (`sanitizeLogAttributes`);
- a file sink that takes file locks, so several Sno processes can share one log directory.

```ts
import { createLogger, configureLogger } from "@snoai/utils";
```

Who it is for: the Sno Station packages themselves. If you only want shared agent memory, you
do not install this directly; it arrives as a dependency of the memory engine. To set that up,
follow the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
and install the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/utils@1.1.0
```

Licensed under Apache-2.0.
