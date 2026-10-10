import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../../apps/mem-claw/vitest.config.ts";

const source = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

// This worktree has installed dependencies but no compiled workspace package entries.
export default defineConfig({
  ...base,
  resolve: {
    ...base.resolve,
    alias: [
      { find: /^@snoai\/memory\/client$/, replacement: source("packages/memory/src/contract/client.ts") },
      { find: /^@snoai\/embedder$/, replacement: source("packages/embedder/src/index.ts") },
      { find: /^@snoai\/common-core$/, replacement: source("packages/common-core/src/index.ts") },
      { find: /^@snoai\/sqlite-crypto$/, replacement: source("packages/sqlite-crypto/src/index.ts") },
      { find: /^@snoai\/utils\/logger$/, replacement: source("packages/utils/src/logger.ts") },
      { find: /^@snoai\/utils$/, replacement: source("packages/utils/src/index.ts") },
      ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : []),
    ],
  },
});
