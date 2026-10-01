import { dirname } from "node:path";
import { buildInsightMetadata, stringifyInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { runWithMutationAttempt } from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { initSqliteRuntimeSync } from "../../../../packages/memory/src/store/sqlite-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestEmbedder } from "./test-db.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("database path is required");

const at = Date.parse("2026-08-04T12:00:00.000Z");
const embedder = await createTestEmbedder();
initSqliteRuntimeSync();
const store = new MemoryStore({ dbPath, embedder });

await runWithMutationAttempt({
	stateDir: dirname(dbPath),
	event: "memory_superseded",
	operation: "profile-crash-boundary",
	writer: "profile-section",
	subject: "identity",
	run: async () => {
		const row = await store.store({
			text: "Crash-boundary committed profile row",
			category: "profile",
			projectId: "mutation-outcome-matrix",
			timestamp: at,
			trusted: true,
			metadata: stringifyInsightMetadata(
				buildInsightMetadata(
					{ text: "Crash-boundary committed profile row", category: "profile", timestamp: at },
					{ section_name: "identity", asserted_at: at, source: "ambient-learning" },
				),
			),
		});
		process.stdout.write(`COMMITTED ${row.id}\n`);
		await new Promise<never>(() => undefined);
	},
	completedOutcome: () => ({ outcome: "committed" }),
});
