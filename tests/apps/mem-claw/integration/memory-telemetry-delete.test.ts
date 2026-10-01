import { tmpdir } from "node:os";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { registerCommands } from "../../../../apps/mem-claw/src/commands/memory-command-registration.ts";
import { executeMemoryForgetTool } from "../../../../packages/memory/src/engine/bindings/memory-forget-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { createMemoryConnection } from "../../../../apps/mem-claw/src/install/memory-connection";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

interface MemoryEventRow {
	event_type: string;
	fact_id: string;
	project_id: string | null;
	metadata_json: string | null;
}

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

function eventRows(store: MemoryStore): MemoryEventRow[] {
	return store["sqlite"]
		.prepare(
			`SELECT event_type, fact_id, project_id, metadata_json
			 FROM nodix_memory_events
			 ORDER BY id ASC`,
		)
		.all() as MemoryEventRow[];
}

function deleteReasons(store: MemoryStore): string[] {
	return eventRows(store)
		.filter((row) => row.event_type === "delete")
		.map((row) => {
			const metadata = JSON.parse(row.metadata_json ?? "{}") as { delete_reason?: unknown };
			return String(metadata.delete_reason);
		});
}

function createAllowAllScopePolicy(): ReturnType<typeof createScopePolicy> {
	return createScopePolicy();
}

describe("memory telemetry delete events", () => {
	let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
	let connection: ReturnType<typeof createMemoryConnection>;
	let store: MemoryStore;

	beforeEach(async () => {
		fixture = await createMemUpdateFixture(testEmbedder, { telemetry: { memoryUsage: { enabled: true, key: "telemetry-delete-test-key", historicKeys: [] }, observe: { enabled: false } } });
		store = new MemoryStore({ dbPath: fixture.database.dbPath, embedder: testEmbedder, memoryTelemetry: { enabled: true, key: "telemetry-delete-test-key", historicKeys: [] } });
		connection = createMemoryConnection(new OpenClawPluginApiHarness({}), "mem-claw-cli");
	});

	afterEach(async () => {
		await connection.close();
		await store.close();
		await fixture.close();
	});

	it("records direct delete and deleteMany as delete events without purge", async () => {
		const direct = await store.store({
			text: "Telemetry direct delete fact",
			category: "episodic",
			projectId: "telemetry-delete",
		});
		const many = await store.store({
			text: "Telemetry deleteMany fact",
			category: "episodic",
			projectId: "telemetry-delete",
		});

		expect(await store.delete(direct.id)).toBe(1);
		expect(await store.deleteMany([many.id])).toBe(1);

		expect(deleteReasons(store)).toEqual(["admin_delete", "admin_delete"]);
		expect(eventRows(store).some((row) => row.event_type === "purge")).toBe(false);
	});

	it("records one delete event per bulkDelete row", async () => {
		await store.store({
			text: "Telemetry bulk delete first fact",
			category: "episodic",
			projectId: "telemetry-bulk-delete",
		});
		await store.store({
			text: "Telemetry bulk delete second fact",
			category: "episodic",
			projectId: "telemetry-bulk-delete",
		});

		expect(await store.bulkDelete({ projectId: "telemetry-bulk-delete" })).toEqual({
			deleted: 2,
			truncated: false,
		});

		expect(deleteReasons(store)).toEqual(["admin_delete", "admin_delete"]);
		expect(eventRows(store).some((row) => row.event_type === "purge")).toBe(false);
	});

	it("records the service forget reason for confirmed sno-mem delete", async () => {
		const stored = await store.store({
			text: "Telemetry CLI delete fact",
			category: "episodic",
			projectId: "telemetry-cli-delete",
		});
		const program = new Command();
		program.exitOverride();
		registerCommands(program, { connection, stateDir: fixture.profile });

		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		try {
			await program.parseAsync(["node", "cli", "sno-mem", "delete", "--id", stored.id, "--scope", "telemetry-cli-delete", "--yes"]);
		} finally {
			console.log = originalLog;
		}

		expect(output.join("\n")).toMatch(/deleted 1 memor/i);
		// The operator CLI now sends the same HTTP forget operation as internal callers.
		expect(deleteReasons(store)).toEqual(["memory_forget"]);
		expect(eventRows(store).some((row) => row.event_type === "purge")).toBe(false);
	});

	it("returns the full recoverable row through exact-id inspection", async () => {
		const originalValue = "alpha-value-beyond-the-preview-prefix";
		const stored = await store.store({
			text: `${"retained profile context ".repeat(8)}${originalValue}`,
			category: "episodic",
			projectId: "delete-preview-full-row",
		});
		const result = await (await connection.ready()).inspect({ op: "get", id: stored.id },
			await connection.scope({ gatewayClientScopes: ["operator.admin"] }, "delete-preview-full-row"));
		expect(result.degraded).toBe(false);
		if (result.degraded || result.result.op !== "get") throw new Error("memory preview failed");
		expect(result.result.entry?.text).toBe(stored.text);
		expect(result.result.entry?.text).toContain(originalValue);
		expect(store.getById(stored.id)?.text).toBe(stored.text);
	});

	it("records memory_forget for the internal forget binding", async () => {
		const stored = await store.store({
			text: "Telemetry memory forget fact",
			category: "episodic",
			projectId: "global",
		});
		const context = {
			store,
			retriever: {},
			scopePolicy: createAllowAllScopePolicy(),
			embedder: testEmbedder,
			agentId: "memory-telemetry-delete",
			stateDir: tmpdir(),
		} as ToolContext;

		const result = asClawResult(await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-telemetry", { id: stored.id }));

		expect(result.isError).not.toBe(true);
		expect(deleteReasons(store)).toEqual(["memory_forget"]);
		expect(eventRows(store).some((row) => row.event_type === "purge")).toBe(false);
	});
});
