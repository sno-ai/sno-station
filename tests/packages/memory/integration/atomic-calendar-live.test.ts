import { resolveLlmEndpoint } from "../../../../packages/sno-station-mem/src/model/llm-endpoint-resolution";
/** Real shipping extraction prompt and signed transport; no substitute model. */
import { randomUUID } from "node:crypto";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import { episodicEventDate } from "../../../../packages/sno-station-mem/src/engine/bindings/memory-tool-formatting";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAtomicGenericExtractionPrompt, createAtomicGenericExtractionTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client";
import { ATOMIC_EXTRACTION_SKILL_HASH } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-skill";

const cases = [
	{ name: "past duration", text: "I've known these friends for 4 years, since I moved from my home country.", anchor: "2023-06-09T19:55:00Z", label: "2019" },
	{ name: "weekday abbreviation", text: "I just joined a new LGBTQ activist group last Tues.", anchor: "2023-07-20T20:56:00Z", label: "2023-07-18" },
	{ name: "future offset", text: "I will move to Kyoto four years from now.", anchor: "2023-06-09T19:55:00Z", label: "2027" },
	{ name: "undated historical event", text: "I moved from my home country, but I have not said when.", anchor: "2023-06-09T19:55:00Z", label: null },
	{ name: "Chinese past duration", text: "我搬到京都已经四年了。", anchor: "2023-06-09T19:55:00Z", label: "2019" },
	{ name: "explicit source date", text: "I moved to Kyoto on March 15, 2020.", anchor: "2023-06-09T19:55:00Z", label: "2020-03-15" },
] as const;

describe("real model understands time; code calculates", () => {
	it.each(cases)("$name", async ({ name, text, anchor, label }) => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
		const client = createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 });
		const config = await client.getResolvedConfig();
		const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "memoryExtract", transport: "chat-completions" });
		const transport = createAtomicGenericExtractionTransport(client);
		const turns = [{ role: "user" as const, content: text }];
		for (let repeat = 0; repeat < 3; repeat += 1) {
			const completion = await transport.complete({ prompt: buildAtomicGenericExtractionPrompt(turns, anchor), maxTokens: 4096 });
			if (!completion || completion.truncated) throw new Error("Missing or truncated real model reply");
			const parsed = parseAtomicExtractionReply(completion.text, turns.length);
			process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url, name, repeat, raw: completion.text }) + "\n");
			if (!parsed.ok) throw new Error(`Invalid reply: ${completion.text}`);
			expect(parsed.records.length).toBeGreaterThan(0);
			const records = await runAtomicExtractionGauntlet({ records: parsed.records, turns, sessionDateTime: anchor, sessionTimezone: "UTC" });
			process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url,
				skillHash: ATOMIC_EXTRACTION_SKILL_HASH, name, repeat, records: records.map(({ claimText, time, resolvedTime }) => ({ claimText, time, resolvedTime })) }) + "\n");
			if (repeat === 0) {
				const fixture = createTestDb();
				const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
				try {
					const key = { conversationId: randomUUID(), chunkHash: randomUUID(), pipelineVersion: "calendar-live" };
					store.beginAtomicExtractionChunk({ ...key, rawChunk: text, routingSnapshotId: "calendar-live", runParameters: { maxInputTokens: 16000, outputTokenBudget: 4096, subchunkCount: 1 }, nowMs: Date.now() });
					store.recordAtomicExtractionCalls(key, Date.now());
					const cards = buildAtomicWriteCards({ records: records.map((record) => ({ ...record, category: "episodic" as const })), idempotencyKeys: records.map(() => randomUUID()), sourceTurnOffset: 0, sessionTimestampMs: Date.parse(anchor), timezone: "UTC" });
					const written = await store.storeAtomicExtractionChunk({ ledgerKey: key, projectId: "calendar-live", extractorVersion: "calendar-live", cards, nowMs: Date.now() });
					expect(written.createdCount).toBe(records.length);
					const recalledDates = written.cardIds.map((id) => {
						const row = store.getById(id);
						if (!row) throw new Error("Written calendar row cannot be read back");
						const metadata = JSON.parse(row.metadata);
						if (label === null) {
							expect(metadata).not.toHaveProperty("event_at");
							expect(episodicEventDate(row)).toBeUndefined();
						} else {
							expect(episodicEventDate(row)).toBe(label);
							if (label.length === 4) expect(metadata).not.toHaveProperty("event_at");
						}
						return episodicEventDate(row);
					});
					process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url, name, dbPath: fixture.dbPath, stored: written.createdCount, recalledDates }) + "\n");
				} finally { await store.close(); fixture.cleanup(); }
			}
			const dates = records.flatMap((record) => record.resolvedTime ? [record.resolvedTime.label] : []);
			if (label === null) expect(dates).toEqual([]);
			else {
				expect(dates).toContain(label);
				expect(dates.every((date) => date === label)).toBe(true);
			}
		}
	}, 300_000);
});
