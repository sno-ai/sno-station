# @snoai/common-core

Identifier helpers shared by Sno Station packages.

It creates and checks the two kinds of id Sno uses: CUID2 (`createCuid2`, `isCuid2`) for
short, URL-safe record ids, and UUID v7 (`createUUIDv7`, `isLowercaseCanonicalUUIDv7`,
`canonicalizeUUIDv7Input`) for ids that sort by creation time. Everything runs locally and has
no state.

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
npm install @snoai/common-core@1.0.1
```

Needs Node.js 22.14 or newer. Licensed under Apache-2.0.
