/** @file group-crud-project-lead.test.ts
 * @purpose Proves a project lead is keyed `project.lead` on the project's own subject, and that a
 *          change of lead replaces the earlier one (cardinality `one`).
 * @boundary Real extraction over the signed Sno GPU transports and the real encrypted store.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AtomicExtractionTurn } from "@/extraction/atomic-extraction-reply";
import {
	createSignedAtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "@/extraction/atomic-memory-extraction";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { llmRoutingConfigSchema } from "@/shared/plugin-config-mode-schema";
import { type AtomicExtractionRunParameters, MemoryStore } from "@/storage/store";
import { applyStateCategoryMigration } from "@/storage/state-category-migration";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "group-crud-project-lead";
const EXTRACTOR_VERSION = "atomic-v3-project-lead-test";
const FIRST_SESSION_MS = Date.UTC(2026, 8, 4, 12, 0);
const SECOND_SESSION_MS = Date.UTC(2026, 8, 5, 12, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 4_096,
	subchunkCount: 1,
};

interface StoredRow {
	id: string;
	text: string;
	category: string;
	subject: string | null;
	attribute: string | null;
	metadata: string;
}

// The Memora shape: a proposal with a title, and its lead stated as "<name>, <title>, will be
// leading the project" — the business persona's own wording from the 2026-09-05 stores.
const FIRST_SESSION: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			'The project proposal is titled "Cockpit Display Integration Platform". Katarina Novak, Chief Strategy Officer, will be leading the project.',
	},
	{ role: "assistant", content: "Noted." },
];

const SECOND_SESSION: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			'An update on the "Cockpit Display Integration Platform" proposal: Priya Kapoor, VP of Engineering Operations, is now leading the project instead of Katarina Novak.',
	},
	{ role: "assistant", content: "Got it." },
];

function readRows(database: TestDb["sqlite"]): StoredRow[] {
	return database
		.prepare(
			"SELECT id, text, category, subject, attribute, metadata FROM nodix_memories WHERE project_id = ? ORDER BY rowid",
		)
		.all(PROJECT_ID) as StoredRow[];
}

function describeRows(rows: readonly StoredRow[]): string {
	return rows
		.map((row) => {
			const closedBy = (JSON.parse(row.metadata) as { superseded_by?: string | null })
				.superseded_by;
			return `${row.category} ${row.subject ?? "-"} ${row.attribute ?? "-"} closed_by=${closedBy ?? "-"} | ${row.text}`;
		})
		.join("\n");
}

function supersededBy(row: StoredRow): string | null {
	return (JSON.parse(row.metadata) as { superseded_by?: string | null }).superseded_by ?? null;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("project.lead — one lead per project, keyed on the project", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.closeSync();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	it("keys the lead as project.lead, and a new lead in a later session replaces the old one", async () => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required; this test is real");
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		applyStateCategoryMigration(fixture.sqlite);
		const database = fixture.sqlite;
		const transports = createSignedAtomicMemoryExtractionTransports(
			{
				preset: "mem_claw/sno_extract_chat",
				apiKey,
				routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }),
				timeoutMs: 180_000,
			},
			"en",
		);
		const run = (turns: readonly AtomicExtractionTurn[], sessionMs: number, suffix: string) =>
			runAtomicMemoryExtraction({
				store: store as MemoryStore,
				projectId: PROJECT_ID,
				ledgerKey: {
					conversationId: `project-lead-${suffix}`,
					chunkHash: `project-lead-chunk-${suffix}`,
					pipelineVersion: EXTRACTOR_VERSION,
				},
				turns,
				rawChunk: turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
				routingSnapshotId: EXTRACTOR_VERSION,
				runParameters: RUN_PARAMETERS,
				estimatedInputTokens: 256,
				extractorVersion: EXTRACTOR_VERSION,
				sessionDateTime: new Date(sessionMs).toISOString(),
				sessionTimestampMs: sessionMs,
				sessionTimezone: "UTC",
				transports,
				nowMs: () => sessionMs,
				locale: "en",
			});

		await run(FIRST_SESSION, FIRST_SESSION_MS, "first");
		const afterFirst = readRows(database);
		const novak = afterFirst.find((row) => /Novak/.test(row.text) && /lead/i.test(row.text));
		expect(novak, `no lead row about Novak\n${describeRows(afterFirst)}`).toBeDefined();
		expect(novak?.category, describeRows(afterFirst)).toBe("state");
		expect(novak?.subject, describeRows(afterFirst)).toMatch(/^entity:/);
		expect(
			novak?.attribute,
			`the lead was stored under ${novak?.attribute ?? "no key"}\n${describeRows(afterFirst)}`,
		).toBe("project.lead");
		expect(novak && supersededBy(novak), describeRows(afterFirst)).toBeNull();

		await run(SECOND_SESSION, SECOND_SESSION_MS, "second");
		const afterSecond = readRows(database);
		const kapoor = afterSecond.find(
			(row) => /Kapoor/.test(row.text) && row.attribute === "project.lead",
		);
		expect(kapoor, `no project.lead row about Kapoor\n${describeRows(afterSecond)}`).toBeDefined();
		// Same project, so the same subject: a second entity would open a second group and close
		// nothing, which is exactly the two-open-rows defect.
		expect(kapoor?.subject, describeRows(afterSecond)).toBe(novak?.subject);
		expect(kapoor && supersededBy(kapoor), describeRows(afterSecond)).toBeNull();
		const novakAfter = afterSecond.find((row) => row.id === novak?.id);
		expect(
			novakAfter && supersededBy(novakAfter),
			`the earlier lead was not replaced by the new one\n${describeRows(afterSecond)}`,
		).toBe(kapoor?.id);
	}, 600_000);
});
