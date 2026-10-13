import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { setLogLevel } from "@snoai/utils/logger";
import { createTestEnv } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { providerRowPath } from "../../../../packages/memory/src/engine/provider/provider-row-renderer";
import { flushAuditWrites, getAuditPath } from "../../../../packages/memory/src/engine/operations/runtime-audit-log";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it("records returned memories for manual, auto and native recall, get, list and injection without a receipt key", async () => {
 const env = await createTestEnv();
 const config = pluginConfigSchema.parse({ mode: "local-first", modelCalls: defaultSettings().modelCalls, autoRecall: true, retrieval: { rerank: "none" }, observe: { enabled: false } });
 const store = new MemoryStore({ dbPath: env.dbPath, embedder: env.embedder });
 const accessTracker = new AccessTracker({ store });
 const logger = { info: () => {}, warn: () => {}, error: () => {} };
 const telemetryUsage = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: env.dbPath });
 const runtime = new MemoryContractRuntime({ config, store, embedder: env.embedder, accessTracker, telemetryUsage, logger,
  retriever: createRetriever(store, env.embedder, undefined, config.retrieval), stateDir: dirname(env.dbPath),
  observability: new PluginObservability(config, dirname(env.dbPath), logger) });
 cleanups.push(async () => { await runtime.close(); await accessTracker.destroy(); await store.close(); env.cleanup(); });
 const scope = { principal: "test-owner", project: "global", session: "telemetry-read-test", host: { agentId: "codex", sessionTimezone: "UTC" } };
 await runtime.init(scope, { skinId: "codex" });
 const entry = await store.store({ text: "The user's favorite code editor is helix-2c9d.", category: "episodic", projectId: "global" });
 setLogLevel("info");
 for (const source of ["manual", "auto", "native"] as const) {
  const result = await runtime.getRecall("The user's favorite code editor is helix-2c9d.", scope, { source, minScore: 0, limit: 5 });
  expect(result.degraded).toBe(false);
  expect(JSON.stringify(result)).toContain(entry.id);
 }
 await flushAuditWrites();
 const previews = readFileSync(getAuditPath(dirname(env.dbPath)), "utf8").trim().split("\n")
  .map(line => JSON.parse(line)).filter(row => row.decision === "content_preview");
 expect(previews).toHaveLength(3);
 for (const preview of previews) {
  expect(preview.details.queryPreview).toBe("The user's favorite code editor is helix-2c9d.");
  expect(preview.details.topResultPreviews[0]).toContain("helix-2c9d");
 }
 await runtime.inspect({ op: "get", id: entry.id }, scope);
 await runtime.inspect({ op: "get", path: providerRowPath(entry.id) }, scope);
 await runtime.inspect({ op: "list" }, scope);
 await runtime.recordUsage("injection", { event: "inject", memoryIds: [entry.id], at: Date.now() }, scope);
 telemetryUsage.flushPending();
 const rows = store.sqlite.prepare("SELECT event_type, COUNT(*) AS count FROM nodix_memory_events WHERE fact_id=? GROUP BY event_type ORDER BY event_type").all(entry.factId ?? entry.id);
 expect(rows).toEqual([{ event_type: "create", count: 1 }, { event_type: "inject", count: 2 }, { event_type: "recall", count: 6 }]);
});
