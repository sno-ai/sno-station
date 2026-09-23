/**
 * QCG-6 (REQ-1, REQ-7, REQ-8, REQ-9): a fact written by `codex` through the real memory_store tool
 * carries `writer_agent_id: "codex"`; recalled into `claude-code` by the real auto-recall hook, its
 * inject row reaches a real buffer.db as a `memory.telemetry` envelope with
 * `source_agent_id: "codex"`. Recalled into `codex`, and a fact with no writer, the inject rows
 * carry no key. Real SQLite store, real embedder and retriever, real usage outbox, real
 * forwardMemoryTelemetryToObserve into a real PluginObservability; the observe base URL is a
 * closed loopback port, so the envelopes stay in buffer.db.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMemoryStoreTool } from "../../../../packages/memory/src/engine/bindings/memory-store-tool.ts";
import { onBeforeAgentStart } from "../../../../packages/memory/src/engine/bindings/sno-station-mem-auto-recall-hook.ts";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter.ts";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retrieval-config.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";
import { forwardMemoryTelemetryToObserve } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-observability.ts";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../../../apps/mem-claw/helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const ENV_KEYS = ["SNO_HOME", "SNO_PROFILE_DIR", "SNO_BUFFER_PATH", "SNO_IDENTITY_PATH",
	"SNO_CONSENT_PATH", "SNO_STATION_MEM_TELEMETRY_HMAC_KEY"] as const;

let root: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
	previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	root = mkdtempSync(join(tmpdir(), "observe-v2-source-agent-"));
	delete process.env.SNO_HOME;
	process.env.SNO_PROFILE_DIR = root;
	process.env.SNO_BUFFER_PATH = join(root, "buffer.db");
	process.env.SNO_IDENTITY_PATH = join(root, "identity.json");
	process.env.SNO_CONSENT_PATH = join(root, "state", "consent.json");
	process.env.SNO_STATION_MEM_TELEMETRY_HMAC_KEY = "observe-v2-source-agent-key";
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

type InjectRow = { event_type: string; fact_id?: string; agent_id: string; source_agent_id?: string };

function injectRows(): InjectRow[] {
	const path = join(root, "buffer.db");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true });
	try {
		return (db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: Buffer }[])
			.map((row) => JSON.parse(row.payload.toString("utf8")))
			.filter((e) => e.event_type === "memory.telemetry")
			.flatMap((e) => e.payload.events as InjectRow[])
			.filter((row) => row.event_type === "inject");
	} finally {
		db.close();
	}
}

describe("the writer of an injected memory reaches the inject row", () => {
	it("names codex as the source when claude-code is injected with codex's fact, and nothing otherwise", async () => {
		const fixture = createTestDb();
		const embedder = await createTestEmbedder();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const retriever = createRetriever(store, embedder, undefined, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" });
		const scopePolicy = createScopePolicy({ default: "global", agentAccess: { codex: ["global"], "claude-code": ["global"] } }, () => {});
		const stateDir = dirname(fixture.dbPath);
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: true, agentId: "claude-code", baseUrl: "http://127.0.0.1:9" },
			}),
			root,
			{ warn: () => undefined },
		);
		try {
			const written = await executeMemoryStoreTool(
				{ store, embedder, retriever, scopePolicy, stateDir, sessionTimestamp: Date.parse("2026-09-23T08:00:00Z"), sessionTimezone: "UTC" } as never,
				{ agentId: "codex" } as never,
				"store-codex",
				{ content: "The user's code editor is helix-2c9d.", category: "episodic" },
			);
			expect(written.isError, JSON.stringify(written)).not.toBe(true);
			const codexRow = store.getById(String(written.details.id));
			expect(JSON.parse(codexRow?.metadata ?? "{}").writer_agent_id).toBe("codex");
			const codexFact = codexRow?.factId ?? codexRow?.id;
			const plain = await store.store({ text: "The user's code editor theme is gruvbox-81ab.", category: "episodic", projectId: "global" });
			const plainFact = plain.factId ?? plain.id;

			const outbox = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: fixture.dbPath, agentId: "claude-code" });
			const config = pluginConfigSchema.parse({
				autoRecall: true, autoRecallMinLength: 1, autoRecallTimeoutMs: 5_000,
				retrieval: { recallTopK: 5, rerank: "none" }, sessionStrategy: "none",
			});
			const recall = (agentId: string) => (onBeforeAgentStart as unknown as (...args: unknown[]) => Promise<{ prependContext?: string } | undefined>)(
				new OpenClawPluginApiHarness(), config, retriever, {}, scopePolicy, new Map(), new Map(),
				{ prompt: "Which code editor and editor theme does the user use?" },
				{ agentId, sessionKey: `session-${agentId}`, sessionId: `turn-${agentId}` },
				stateDir, outbox,
			);
			const intoClaude = await recall("claude-code");
			expect(intoClaude?.prependContext).toContain("helix-2c9d");
			expect(intoClaude?.prependContext).toContain("gruvbox-81ab");
			await recall("codex");
			outbox.flushPending();
			const forwarded = await forwardMemoryTelemetryToObserve({ sqlite: store.sqlite, observe: observability });
			expect(forwarded.status).toBe("forwarded");
			await observability.shutdown();

			const key = (row: InjectRow) => [row.agent_id, row.fact_id === codexFact ? "codex-fact" : row.fact_id === plainFact ? "plain-fact" : row.fact_id, row.source_agent_id];
			expect(injectRows().map(key).sort()).toEqual([
				["claude-code", "codex-fact", "codex"],
				["claude-code", "plain-fact", undefined],
				["codex", "codex-fact", undefined],
				["codex", "plain-fact", undefined],
			]);
		} finally {
			await store.close();
			fixture.cleanup();
		}
	}, 180_000);
});
