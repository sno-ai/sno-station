import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { AtomicInsightDistiller, createSignedAtomicMemoryExtractionTransports } from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { resolveLlmEndpoint } from "../../../../packages/memory/src/model/llm-endpoint-resolution";

const cases = [
	...Array.from({ length: 3 }, (_, repeat) => ({
		name: `recipe-sharing commitment ${repeat}`,
		turns: [
			"Tim: Mmm, that sounds delicious, John! Can I get the recipe for it?",
			"John: Sure thing! I can write it down for you and mail it to you.",
		],
		storesOffer: true,
	})),
	{ name: "bare acknowledgement", turns: ["Tim: Thanks!", "John: You're welcome!"], storesOffer: false },
	{ name: "progress only", turns: ["I am halfway through writing the release notes."], storesOffer: false },
];

// LoCoMo conv-43, session_15, D15:33–34: the exact window that lost the offer.
it.each(cases)("$name", async ({ name, turns, storesOffer }) => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "memoryExtract", transport: "chat-completions" });
	const transcript = turns.map((text) => `user: ${text}`).join("\n\n");
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	try {
		const transports = createSignedAtomicMemoryExtractionTransports({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000, routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }) });
		const complete = transports.generic.complete.bind(transports.generic);
		transports.generic.complete = async (input) => {
			const reply = await complete(input);
			console.log(JSON.stringify({ name, rawReply: reply }));
			return reply;
		};
		const result = await new AtomicInsightDistiller(store, transports, { defaultScope: "issue-219", locale: "en" }).extractAndPersist(transcript, randomUUID(), { sessionDateTime: "2023-10-21T17:51:00Z", sessionTimezone: "UTC" });
		const rows = store.sqlite.prepare("SELECT text, metadata, lane FROM nodix_memories").all() as Array<{ text: string; metadata: string; lane: string }>;
		console.log(JSON.stringify({ host: hostname(), endpoint: endpoint.url, model: endpoint.preset.model, dbPath: fixture.dbPath, name, result, rows }));
		expect(result.llmFailures ?? 0).toBe(0);
		if (!storesOffer) {
			expect(rows).toHaveLength(0);
			return;
		}
		expect(rows.length).toBeGreaterThan(0);
		const saved = rows.filter((row) => row.lane === "active").map((row) => row.text).join("\n");
		expect(saved).toMatch(/recipe/i);
		expect(saved).toMatch(/writ|written/i);
		expect(saved).toMatch(/mail|post/i);
	} finally {
		await store.close();
		fixture.cleanup();
	}
}, 180_000);
