# @snoai/utils

Logs you can actually read.

When something goes wrong in a Sno Station package, you want to know where and why. This library gives each package a logger that writes plain JSON lines to a daily log file in your Sno folder.

- Every line comes from a known spot in the code.
- Context follows an async call (`withLogContext`, `currentLogContext`).
- Secrets are cleaned out of log attributes before anything is written (`sanitizeLogAttributes`). Keep them out of the message text yourself: it is written as is.
- Several Sno processes can share one log folder without stepping on each other.

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
npm install @snoai/utils@1.1.1
```

Licensed under Apache-2.0.
