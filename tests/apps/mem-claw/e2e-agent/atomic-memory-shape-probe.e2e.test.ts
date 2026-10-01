import { readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file Prints every stored row the live atomic path writes for a set of named scenarios, so the shape can be read directly. */

import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import {
	createSignedAtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction.ts";
import type { AtomicExtractionTurn } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply.ts";
import type { Locale } from "../../../../packages/memory/src/engine/i18n/locales.ts";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { assertLiveAgentE2EEnabled } from "./helpers/config.ts";

const EXTRACTOR_VERSION = "atomic-shape-probe";

interface Scenario {
	name: string;
	locale: Locale;
	timezone: string;
	turns: AtomicExtractionTurn[];
	/** What a reader should look for; the probe prints, a person judges. */
	expect: string;
}

const SCENARIOS: Scenario[] = [
	{
		name: "zh compound preference",
		locale: "zh",
		timezone: "Asia/Shanghai",
		turns: [{ role: "user", content: "我喜欢吃咖喱，也爱听爵士乐。" }],
		expect: "two rows: food preference, music preference; no joined row",
	},
	{
		name: "zh dated switch",
		locale: "zh",
		timezone: "Asia/Shanghai",
		turns: [
			{
				role: "user",
				content: "2026年9月2日晚上八点十五分，我把主力编辑器从 Vim 换成了 Emacs。",
			},
		],
		expect: "one episodic row with an instant valid window in Asia/Shanghai; one durable editor row",
	},
	{
		name: "zh third-party two claims",
		locale: "zh",
		timezone: "Asia/Shanghai",
		turns: [{ role: "user", content: "张伟是我们公司的后端工程师，他住在深圳。" }],
		expect: "two rows, both subject entity:zhang-wei (occupation, location); none about user",
	},
	{
		name: "zh todo vs progress",
		locale: "zh",
		timezone: "Asia/Shanghai",
		turns: [
			{ role: "user", content: "我明天要去交房租。" },
			{ role: "user", content: "发布说明写到一半了。" },
		],
		expect: "one open to-do for rent; nothing for the half-written notes",
	},
	{
		name: "ordinary chat with assistant turns",
		locale: "en",
		timezone: "America/Los_Angeles",
		turns: [
			{ role: "user", content: "hey, quick one" },
			{ role: "assistant", content: "Sure, what's up?" },
			{ role: "user", content: "how does a sqlite WAL checkpoint actually work?" },
			{
				role: "assistant",
				content:
					"A checkpoint copies committed pages from the WAL file back into the main database file. You are probably fine with the default automatic checkpoint.",
			},
			{ role: "user", content: "thanks. oh and fyi I'm allergic to peanuts, keep that in mind for recipes" },
			{ role: "assistant", content: "Noted — I'll keep peanuts out of any recipe I suggest." },
		],
		expect: "one row: peanut allergy (user). No row for the greeting, the question, or the assistant's explanation",
	},
	{
		name: "en move and durable negation",
		locale: "en",
		timezone: "America/Los_Angeles",
		turns: [
			{ role: "user", content: "btw I moved to Austin last month, and I don't drink coffee anymore." },
		],
		expect: "move event (resolved to a month) + current city Austin; a durable 'does not drink coffee' row",
	},
	{
		name: "mixed zh-en",
		locale: "zh",
		timezone: "Asia/Shanghai",
		turns: [{ role: "user", content: "我上周 join 了 Acme，做 backend。" }],
		expect: "join event (last week resolved from session date) + employer Acme + role backend",
	},
];

const SHOWN_COLUMNS = [
	"text",
	"category",
	"lane",
	"disposition_reason",
	"subject",
	"attribute",
	"importance",
	"valid_from",
	"valid_until",
	"timezone",
] as const;

async function runScenario(scenario: Scenario): Promise<Record<string, unknown>[]> {
	const projectId = `shape-probe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const embedder = await createTestEmbedder();
	const fixture = createTestDb();
	const gpu = readTestSnoGpuSettings();
	const { settings } = writeSettingsFixture(dirname(fixture.dbPath), { mode: "rem-enhanced", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey }, snoGpu: gpu, embedding: { cacheDir: "" } });
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	const transports = createSignedAtomicMemoryExtractionTransports(
		{
			apiKey: gpu.apiKey,
			preset: "mem_claw/sno_extract_chat",
			routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: settings.modelCalls }),
			timeoutMs: 120_000,
		},
		scenario.locale,
	);
	let nowMs = Date.now();
	const result = await runAtomicMemoryExtraction({
		store,
		projectId,
		ledgerKey: {
			conversationId: `${projectId}-conversation`,
			chunkHash: `${projectId}-chunk`,
			pipelineVersion: EXTRACTOR_VERSION,
		},
		turns: scenario.turns,
		rawChunk: scenario.turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
		routingSnapshotId: `${projectId}-routing`,
		runParameters: { maxInputTokens: 4_096, outputTokenBudget: 4_096, subchunkCount: 1 },
		estimatedInputTokens: 200,
		extractorVersion: EXTRACTOR_VERSION,
		locale: scenario.locale,
		sessionDateTime: new Date(nowMs).toISOString(),
		sessionTimestampMs: nowMs,
		sessionTimezone: scenario.timezone,
		transports,
		nowMs: () => nowMs++,
		requestId: `${projectId}-request`,
	});
	if (result.status !== "complete") {
		throw new Error(`atomic extraction ended as ${result.status}`);
	}
	const rows = store.sqlite
		.prepare("SELECT * FROM nodix_memories WHERE project_id = ?")
		.all(projectId) as Record<string, unknown>[];
	const todos = store.sqlite
		.prepare("SELECT * FROM nodix_todos WHERE project_id = ?")
		.all(projectId) as Record<string, unknown>[];

	const out: string[] = [`\n##### SCENARIO ${scenario.name} (locale=${scenario.locale})`];
	out.push(`# expect: ${scenario.expect}`);
	for (const turn of scenario.turns) out.push(`# ${turn.role}: ${turn.content}`);
	out.push(`# rows=${rows.length} todos=${todos.length}`);
	for (const [index, row] of rows.entries()) {
		out.push(`--- row ${index + 1} ---`);
		for (const key of SHOWN_COLUMNS) {
			const value = row[key];
			if (value === null || value === undefined) continue;
			out.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
		const metadata = typeof row.metadata === "string" ? row.metadata : "";
		const note = /"keying_note":"([a-z:-]+)"/u.exec(metadata)?.[1];
		if (note) out.push(`  keying_note: ${note}`);
	}
	for (const [index, todo] of todos.entries()) {
		out.push(`--- todo ${index + 1} ---`);
		for (const [key, value] of Object.entries(todo)) {
			if (value === null || value === undefined) continue;
			out.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	process.stdout.write(`${out.join("\n")}\n`);
	return rows;
}

describe("atomic memory shape probe", () => {
	for (const scenario of SCENARIOS) {
		it(
			scenario.name,
			async () => {
				assertLiveAgentE2EEnabled();
				const rows = await runScenario(scenario);
				expect(rows.length).toBeGreaterThan(0);
				for (const row of rows) {
					expect(row.maturity).toBe("extracted");
					expect(String(row.text).length).toBeGreaterThan(0);
				}
			},
			240_000,
		);
	}
});
