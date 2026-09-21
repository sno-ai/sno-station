import { dirname } from "node:path";
import { countTokens } from "@snoai/chunking";
import { expect, it } from "vitest";
import { executeMemoryRecallTool } from "../../../../packages/sno-station-mem/src/engine/bindings/memory-recall-tool.ts";
import { createEmbedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/sno-station-mem/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

it("counts to-dos and structured references in the aggregation consumer budget", async () => {
	const database = createTestDb();
	const embedder = createEmbedder({
		provider: "local-onnx",
		sessionOptions: { intraOpNumThreads: 1, interOpNumThreads: 1 },
	}, dirname(database.dbPath));
	const store = new MemoryStore({ dbPath: database.dbPath, embedder });
	try {
		for (let index = 0; index < 23; index++) {
			await store.store({
				text: `Expedition notebook ${index}. ` +
					("Expedition documentation includes transportation arrangements, accommodation " +
						"reservations, equipment inventories and environmental observations. ").repeat(24) +
					"Equipment transportation arrangements and accommodation reservations were confirmed before departure.",
				category: "episodic",
				projectId: "global",
				timestamp: 1_780_272_000_000,
				metadata: JSON.stringify({ event_at: "2026-06-01T00:00:00Z" }),
			});
		}
		const context = {
			store, embedder, stateDir: dirname(database.dbPath),
			retriever: createRetriever(store, embedder),
			scopePolicy: createScopePolicy({ default: "global", agentAccess: { caller: ["global"] } }),
		};
		const params = {
			query: "What do all expedition notebooks report?",
			aggregation: { operation: "evidence", terms: ["expedition"] },
		};
		const options = { name: "memory_recall", label: "Memory Recall", description: "" };
		const memoriesOnly = await executeMemoryRecallTool(
			context, { agentId: "caller" }, "memories-only", params, options,
		);
		expect(memoriesOnly.isError).not.toBe(true);
		expect(memoriesOnly.details["count"]).toBe(23);
		const baselineTokens = Math.max(
			countTokens(memoriesOnly.content.map(part => part.text).join("\n")),
			countTokens(JSON.stringify(memoriesOnly.details["memories"])),
		);
		expect(baselineTokens).toBeGreaterThan(32_000);
		expect(baselineTokens).toBeLessThanOrEqual(32_768);

		for (let index = 0; index < 10; index++) {
			store.sqlite.prepare(`INSERT INTO nodix_active_task_instances(
				project_id, active_task_id, opening_command_id, canonical_tuple_json,
				identity_state, status, created_at_ms, terminal_at_ms
			) VALUES ('global', ?, NULL, '{}', 'normal', 'active', 10, NULL)`)
				.run(`expedition-task-${index}`);
			store.sqlite.prepare(`INSERT INTO nodix_todos(
				project_id, active_task_id, description, status, opened_at, transitioned_at,
				closed_at, close_reason, source_session, extraction_path
			) VALUES ('global', ?, ?, 'open', 10, 10, NULL, NULL, 'budget-test', 'agent_end')`)
				.run(`expedition-task-${index}`,
					`Prepare expedition checkpoint ${index}. ` +
					"Check the water supplies and confirm the route with the team. ".repeat(6));
		}
		const result = await executeMemoryRecallTool(
			context, { agentId: "caller" }, "with-todos", params, options,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content).toHaveLength(3);
		expect(result.content[0]?.text).toContain("To-dos:\n- [open] Prepare expedition checkpoint");
		expect(result.content[1]?.text).toContain("<relevant-memories>");
		expect(result.content[2]?.text).toContain('"status":"ok"');
		expect(Math.max(
			countTokens(result.content.map(part => part.text).join("\n")),
			countTokens(JSON.stringify(result.details["memories"])),
		)).toBeLessThanOrEqual(32_768);
		expect(result.details["count"]).toBeGreaterThan(0);
		expect(result.details["count"]).toBeLessThan(23);
		expect(result.details["truncated"]).toBe(true);
	} finally {
		await store.close();
		await embedder.dispose();
		database.cleanup();
	}
});
