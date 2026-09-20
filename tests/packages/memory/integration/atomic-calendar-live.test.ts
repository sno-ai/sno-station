import { resolveLlmEndpoint } from "../../../../packages/sno-station-mem/src/model/llm-endpoint-resolution";
/** Real shipping extraction prompt and signed transport; no substitute model. */
import { randomUUID } from "node:crypto";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { runAtomicMemoryExtraction, createSignedAtomicMemoryExtractionTransports } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction";
import { llmRoutingConfigSchema } from "../../../../packages/sno-station-mem/config/plugin-config-mode-schema";
import { episodicEventDate } from "../../../../packages/sno-station-mem/src/engine/bindings/memory-tool-formatting";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAtomicGenericExtractionPrompt, createAtomicGenericExtractionTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client";
import { ATOMIC_EXTRACTION_SKILL_HASH } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-skill";

// Undated generic extraction sometimes returns no records; that is completeness issue #219.
// Its raw failures are retained in /tmp/calendar-undated-fixed.log and
// /tmp/calendar-undated-accounting.log. The exact claim is tested at the real time-judgment
// boundary in date-resolution-acceptance.test.ts; no empty extraction is counted as a pass.
const cases = [
	{ name: "past duration", text: "I've known these friends for 4 years, since I moved from my home country.", anchor: "2023-06-09T19:55:00Z", label: "2019", instruction: { kind: "relative", amount: -4, unit: "year", precision: "year" } },
	{ name: "weekday abbreviation", text: "I just joined a new LGBTQ activist group last Tues.", anchor: "2023-07-20T20:56:00Z", label: "2023-07-18", instruction: { kind: "weekday", day_name: "tuesday", direction: "previous", precision: "day" } },
	{ name: "future offset", text: "I will move to Kyoto four years from now.", anchor: "2023-06-09T19:55:00Z", label: "2027", instruction: { kind: "relative", amount: 4, unit: "year", precision: "year" } },
	{ name: "Chinese past duration", text: "我搬到京都已经四年了。", anchor: "2023-06-09T19:55:00Z", label: "2019", instruction: { kind: "relative", amount: -4, unit: "year", precision: "year" } },
	{ name: "explicit source date", text: "I moved to Kyoto on March 15, 2020.", anchor: "2023-06-09T19:55:00Z", label: "2020-03-15", instruction: { kind: "absolute", year: 2020, month: 3, day: 15, precision: "day" } },
	{ name: "named Friday on a Sunday", text: "Last Friday, I did yoga and meditation to relax.", anchor: "2023-07-23T15:20:00Z", label: "2023-07-21", instruction: { kind: "weekday", day_name: "friday", direction: "previous", precision: "day" } },
	{ name: "last weekend", text: "I ran a 5K last weekend.", anchor: "2023-04-07T18:10:00Z", label: "2023-03-27/2023-04-03", instruction: { kind: "relative", amount: -1, unit: "week", precision: "week" } },
	{ name: "last week", text: "I went hiking with my friends last week.", anchor: "2023-07-16T20:30:00Z", label: "2023-07-10/2023-07-17", instruction: { kind: "relative", amount: -1, unit: "week", precision: "week" } },
	{ name: "shared today", text: "Today I shared a photo with you: an apple pie on a wooden board.", anchor: "2023-07-03T17:45:00Z", label: "2023-07-03", instruction: { kind: "relative", amount: 0, unit: "day", precision: "day" } },
] as const;

describe("real model understands time; code calculates", () => {
	it.each(cases)("$name", async ({ name, text, anchor, label, instruction }) => {
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
			for (const record of parsed.records) expect(record.time).toMatchObject(instruction);
			const records = await runAtomicExtractionGauntlet({ records: parsed.records, turns, sessionDateTime: anchor, sessionTimezone: "UTC" });
			process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url,
				skillHash: ATOMIC_EXTRACTION_SKILL_HASH, name, repeat, records: records.map(({ claimText, time, resolvedTime }) => ({ claimText, time, resolvedTime })) }) + "\n");
			const dates = records.map((record) => record.resolvedTime?.label);
			expect(dates).toContain(label);
			expect(dates.every((date) => date === label)).toBe(true);
		}
	}, 300_000);
});

it("keeps independently stated event dates separate", async () => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const client = createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 });
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "memoryExtract", transport: "chat-completions" });
	const text = "I met Ada on March 15, 2019. I moved to Kyoto on April 20, 2022.";
	const turns = [{ role: "user" as const, content: text }];
	const reply = await createAtomicGenericExtractionTransport(client).complete({ prompt: buildAtomicGenericExtractionPrompt(turns, "2023-06-09T19:55:00Z"), maxTokens: 4096 });
	if (!reply || reply.truncated) throw new Error("Missing or truncated model reply");
	const parsed = parseAtomicExtractionReply(reply.text, 1);
	if (!parsed.ok) throw new Error(`Invalid model reply: ${reply.text}`);
	const records = await runAtomicExtractionGauntlet({ records: parsed.records, turns, sessionDateTime: "2023-06-09T19:55:00Z", sessionTimezone: "UTC" });
	process.stdout.write(JSON.stringify({ host: hostname(), model: endpoint.preset.model, endpoint: endpoint.url, name: "independent event dates", raw: reply.text, dates: records.map((record) => record.resolvedTime?.label) }) + "\n");
	const meeting = records.find((record) => record.claimText.includes("Ada"));
	const move = records.find((record) => record.claimText.includes("Kyoto"));
	expect(meeting?.time).toMatchObject({ kind: "absolute", year: 2019, month: 3, day: 15, precision: "day" });
	expect(meeting?.resolvedTime?.label).toBe("2019-03-15");
	expect(move?.time).toMatchObject({ kind: "absolute", year: 2022, month: 4, day: 20, precision: "day" });
	expect(move?.resolvedTime?.label).toBe("2022-04-20");
}, 120_000);


it("keeps a real standing claim open through production classification and durable read-back", async () => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const routing = llmRoutingConfigSchema.parse({ mode: "rem-enhanced" });
	const transports = createSignedAtomicMemoryExtractionTransports({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000, routing });
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "memoryExtract", transport: "chat-completions" });
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	const text = "I have lived in Kyoto for four years.";
	const anchor = "2023-06-09T19:55:00Z";
	try {
		const result = await runAtomicMemoryExtraction({ store, projectId: "calendar-standing-live", ledgerKey: { conversationId: randomUUID(), chunkHash: randomUUID(), pipelineVersion: "calendar-standing-live" }, turns: [{ role: "user", content: text }], rawChunk: text, routingSnapshotId: "calendar-standing-live", runParameters: { maxInputTokens: 16000, outputTokenBudget: 4096, subchunkCount: 1 }, estimatedInputTokens: 20, extractorVersion: "calendar-standing-live", sessionDateTime: anchor, sessionTimestampMs: Date.parse(anchor), sessionTimezone: "UTC", transports, nowMs: Date.now });
		if (result.status !== "complete") throw new Error(`Extraction did not complete: ${JSON.stringify(result)}`);
		expect(result.write.createdCount).toBeGreaterThan(0);
		const standing = result.records.filter((record) => record.category === "profile");
		expect(standing.length).toBeGreaterThan(0);
		for (const record of standing) {
			expect(record.kind).toBe("standing");
			expect(record.time).toMatchObject({ kind: "relative", amount: -4, unit: "year", precision: "year" });
		}
		const rows = result.write.cardIds.map((id) => {
			const row = store.getById(id);
			if (!row) throw new Error("Written row cannot be read back");
			const metadata = JSON.parse(row.metadata);
			if (row.category === "profile") {
				expect(metadata).toMatchObject({ temporal_date: "2019", temporal_precision: "year" });
				expect(metadata.valid_until).toBeUndefined();
				expect(episodicEventDate(row)).toBeUndefined();
				expect(fixture.sqlite.prepare("SELECT valid_until FROM nodix_memories WHERE id = ?").get(id)).toEqual({ valid_until: null });
			}
			return { id, category: row.category, metadata };
		});
		expect(rows.some((row) => row.category === "profile")).toBe(true);
		process.stdout.write(JSON.stringify({ host: hostname(), endpoint: endpoint.url, model: endpoint.preset.model, dbPath: fixture.dbPath, records: result.records, rows }) + "\n");
	} finally { await store.close(); fixture.cleanup(); }
}, 300_000);
