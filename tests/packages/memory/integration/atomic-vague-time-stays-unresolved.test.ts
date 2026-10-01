/** Real Sno GPU extraction. A vague time word must not become an exact calendar window. */
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { AtomicInsightDistiller, createSignedAtomicMemoryExtractionTransports } from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS_PATH } from "../fixtures/settings-file-fixture";

// The routing table is `settings.modelCalls`; the shipped default document carries the one `sno` writes.
const MODEL_CALLS = (JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as { modelCalls: unknown }).modelCalls;

type Row = { text: string; metadata: string };
type Temporal = { temporal_resolution_status?: string; temporal_date?: string; temporal_phrase?: string | null; source_span?: { turnIndex?: number } };

async function extract(sessionDateTime: string, turns: string[]): Promise<Array<{ text: string } & Temporal>> {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	try {
		const transports = createSignedAtomicMemoryExtractionTransports({
			preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000,
			routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: MODEL_CALLS }),
		});
		const distiller = new AtomicInsightDistiller(store, transports, { defaultScope: "vague-time", locale: "en" });
		const result = await distiller.extractAndPersist(turns.map((text) => `user: ${text}`).join("\n\n"), randomUUID(), { sessionDateTime, sessionTimezone: "UTC" });
		expect(result.llmFailures ?? 0).toBe(0);
		const rows = store.sqlite.prepare("SELECT text, metadata FROM nodix_memories").all() as Row[];
		return rows.map((row) => ({ text: row.text, ...(JSON.parse(row.metadata) as Temporal) }));
	} finally {
		await store.close();
		fixture.cleanup();
	}
}

// LoCoMo conv-26 D12:1, said on 2023-08-17. "Recently" names no calendar unit, so the row keeps the
// fact without a date. Measured 2026-09-18: the live store held this claim resolved to
// 2023-08-07/2023-08-14 with temporal_phrase "Recently", and the answering model repeated that week.
it("keeps a 'recently' event undated instead of inventing a week", async () => {
	const rows = await extract("2023-08-17T13:50:00Z", [
		"Caroline: Hey Mel! How're ya doin'? Recently, I had a not-so-great experience on a hike. I ran into a group of religious conservatives who said something that really upset me. It made me think how much work we still have to do for LGBTQ rights. It's been so helpful to have people around me who accept and support me, so I know I'll be ok!",
		"Melanie: Hey Caroline, sorry about the hike. It sucks when people are so closed-minded. Strong support really helps.",
	]);
	// Rows from Caroline's turn only (turn 0): Melanie's reply is turn 1 and may carry its day.
	const hike = rows.filter((row) => row.source_span?.turnIndex === 0);
	expect(hike.length).toBeGreaterThan(0);
	for (const row of hike) {
		expect(row, row.text).not.toMatchObject({ temporal_resolution_status: "resolved" });
	}
});

// LoCoMo conv-26 D14:1, said on Friday 2023-08-25. "Last week" is the previous calendar week.
it("still resolves 'last week' to the previous calendar week", async () => {
	const rows = await extract("2023-08-25T13:33:00Z", [
		"Caroline: Hey, Mel! How's it going? There's something I want to tell you. I went hiking last week and got into a bad spot with some people. It really bugged me, so I tried to apologize to them.",
	]);
	const dated = rows.filter((row) => /hike|hiking/iu.test(row.text) && row.temporal_resolution_status === "resolved");
	expect(dated.map((row) => row.temporal_date)).toContain("2023-08-14/2023-08-21");
});
