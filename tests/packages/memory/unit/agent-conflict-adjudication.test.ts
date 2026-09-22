import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../packages/memory/src/engine/extraction/profile-section-writer.ts";
import type {
	AgentLlmCompletion,
	AgentLlmPort,
	AgentLlmRequest,
} from "../../../../packages/memory/src/model/agent-llm-port.ts";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

/**
 * The local ranker, stated explicitly. Nothing in this file exercises the remote
 * reranker, and a mode that resolves to the cross-encoder is refused without its key
 * (owner ruling 2026-08-30), so the fixture names the ranker it has always used.
 */
const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;

const DAY = 24 * 60 * 60 * 1_000;

class ScriptedAgentLlmPort implements AgentLlmPort {
	readonly requests: AgentLlmRequest[] = [];

	constructor(private readonly completion: AgentLlmCompletion) {}

	async complete(request: AgentLlmRequest): Promise<AgentLlmCompletion> {
		this.requests.push(request);
		return this.completion;
	}
}

let embedder: Embedder;
let cleanup: (() => void) | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("agent-native conflict adjudication", () => {
	it.each([
		['{"verdict":"replacement"}', 1],
		["not a verdict", 2],
	] as const)("applies the host response %s with a fail-safe parser", async (response, liveCount) => {
		const testDb = createTestDb();
		const store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		cleanup = () => {
			store.close();
			testDb.cleanup();
		};
		const routing = pluginConfigSchema.parse({ ...LOCAL_RERANK, mode: "agent-native" });
		const agentPort = new ScriptedAgentLlmPort({ kind: "ok", text: response });
		const llm = createLlmClient({
			preset: "mem_claw/sno_ai_extract",
			routing,
			agentPort,
		});
		const scope = `agent-conflict-${liveCount}`;
		const started = Date.parse("2025-06-13T12:00:00Z");
		await runProfileSectionUpdate({
			scope,
			sectionName: "preferences.directors",
			newAssertion: "The user no longer enjoys William Wyler's movies.",
			evidence: "The user no longer enjoys William Wyler's movies.",
			source: { messageId: "wyler-older" },
			store,
			llm,
			routing,
			at: started,
		});
		const seeded = (
			await store.list({ projectId: scope, category: "profile", limit: 10 })
		)[0];
		if (!seeded) throw new Error("expected seeded profile row");
		const rawMetadata: unknown = JSON.parse(seeded.metadata ?? "{}");
		if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
			throw new Error("expected profile metadata object");
		}
		Object.assign(rawMetadata, { section_name: "preferences.films" });
		testDb.sqlite
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run(JSON.stringify(rawMetadata), seeded.id);

		await runProfileSectionUpdate({
			scope,
			sectionName: "preferences.films",
			newAssertion: "The user likes William Wyler's films for his attention to detail.",
			evidence: "The user likes William Wyler's films for his attention to detail.",
			source: { messageId: "wyler-newer" },
			store,
			llm,
			routing,
			at: started + 12 * DAY,
		});

		const rows = await store.list({ projectId: scope, category: "profile", limit: 10 });
		const liveRows = rows.filter(
			(row) => parseInsightMetadata(row.metadata, row).invalidated_at === undefined,
		);
		expect(liveRows).toHaveLength(liveCount);
		expect(agentPort.requests).toHaveLength(1);
		expect(agentPort.requests[0]?.system).toContain("adjudicate memory conflicts");
		expect(agentPort.requests[0]?.prompt).toContain("Prefer uncertain over guessing");
		expect(agentPort.requests[0]?.prompt).toContain('"kind":"profile"');
	});
});
