# @snoai/common-core

Small ID helpers that every Sno Station package uses.

It makes and checks two kinds of ids. Short, URL-safe ones for records (`createCuid2`, `isCuid2`). And ones that sort by creation time, for things that should line up in the order they were made (`createUUIDv7`, `isLowercaseCanonicalUUIDv7`, `canonicalizeUUIDv7Input`). Everything runs on your machine and keeps no state.

```ts
import { createCuid2, createUUIDv7 } from "@snoai/common-core";
```

Who it is for: the Sno Station packages themselves. If you only want shared agent memory, you
do not install this directly; it arrives as a dependency of the memory engine. To set that up,
follow the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
and install the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/common-core@1.1.2
```

Needs Node.js 22.14 or newer. Licensed under Apache-2.0.
