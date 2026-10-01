import { readTestModelCalls, readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file 108-atomic-document-field-coverage.e2e.test.ts
 * @purpose Proves every field of a dictated document survives the real window split, not just the first two.
 * @boundary The whole live distiller over real encrypted SQLite; real model calls, no mocks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	AtomicInsightDistiller,
	createSignedAtomicMemoryExtractionTransports,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";
import { assertLiveAgentE2EEnabled } from "./helpers/config";

/**
 * `107` extracts a whole conversation as ONE window, which is not how a session is really
 * extracted: `atomicConversationWindows` cuts a conversation into overlapping slices and gives
 * each turn to exactly one of them. A field lost because its own window returned nothing is
 * therefore invisible to `107` and to every other test in this repository.
 *
 * The material is a real dictated email from the corpus. In a scored run its purpose and its
 * recipient list were stored and its key points and its call to action were not, and the two
 * missing sub-checks cost the question half its score.
 */
const CORPUS_ROOT = path.resolve(import.meta.dirname, "../../../../evals/memora/data/weekly");
const PROJECT_ID = "document-field-coverage";
const ROUNDS = 3;
const MAJORITY = 2;

interface CorpusSession {
	session_id: number;
	date: string;
	conversation: { turn: number; speaker: string; message: string }[];
}

interface DocumentCase {
	persona: string;
	sessionId: number;
	/** One per field the user dictates; every part must appear in one stored row. */
	fields: { name: string; parts: string[] }[];
}

const CASES: DocumentCase[] = [
	{
		persona: "content_writer",
		// Four dictated fields across four user turns, with two consecutive assistant turns at
		// indices 3 and 4 — the shape that already produced one silent loss tonight.
		sessionId: 30,
		fields: [
			{ name: "the purpose", parts: ["workflow"] },
			{ name: "the recipients", parts: ["creative director"] },
			{ name: "the key points", parts: ["strategy session"] },
			{ name: "the call to action", parts: ["consultation"] },
		],
	},
];

function loadSession(persona: string, sessionId: number): CorpusSession {
	const file = path.join(
		CORPUS_ROOT,
		persona,
		"conversations",
		`session_${String(sessionId).padStart(4, "0")}.json`,
	);
	return JSON.parse(readFileSync(file, "utf8")) as CorpusSession;
}

function toConversationText(session: CorpusSession): string {
	return session.conversation
		.map((turn) => `${turn.speaker === "user_agent" ? "user" : "assistant"}: ${turn.message}`)
		.join("\n");
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

async function storedTexts(session: CorpusSession, round: number): Promise<string[]> {
	const fixture: TestDb = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		const distiller = new AtomicInsightDistiller(
			store,
			createSignedAtomicMemoryExtractionTransports(
				{
					preset: "mem_claw/sno_extract_chat",
					apiKey: readTestSnoGpuSettings().apiKey,
					routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: readTestModelCalls() }),
					timeoutMs: 180_000,
				},
				"en",
			),
			{ defaultScope: PROJECT_ID, locale: "en" },
		);
		// The eval harness rebases the corpus a year forward; mirror it so a resolved date lands in
		// the year the conversation claims.
		await distiller.extractAndPersist(
			toConversationText(session),
			`${PROJECT_ID}-${session.session_id}-${round}`,
			{
				sessionDateTime: `${session.date.replace("2025-", "2026-")}T12:00:00Z`,
				sessionTimezone: "UTC",
			},
		);
		return (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ? AND lane = 'active'")
				.all(PROJECT_ID) as { text: string }[]
		).map(({ text }) => text.toLowerCase());
	} finally {
		await store.close();
		fixture.cleanup();
	}
}

describe("atomic document field coverage", () => {
	for (const documentCase of CASES) {
		it(
			`keeps every dictated field from ${documentCase.persona} session ${documentCase.sessionId}`,
			async () => {
				assertLiveAgentE2EEnabled();
				const session = loadSession(documentCase.persona, documentCase.sessionId);
				const rounds: string[][] = [];
				for (let round = 0; round < ROUNDS; round += 1) {
					rounds.push(await storedTexts(session, round));
				}

				const report: string[] = [
					`\n##### document session ${documentCase.sessionId} — rows per round: ${rounds
						.map((texts) => texts.length)
						.join(", ")}`,
				];
				const missed: string[] = [];
				for (const field of documentCase.fields) {
					const hits = rounds.map((texts) =>
						texts.some((text) => field.parts.every((part) => text.includes(part))),
					);
					const hitCount = hits.filter(Boolean).length;
					report.push(
						`  ${hitCount >= MAJORITY ? "OK   " : "MISS "} ${hitCount}/${ROUNDS} — ${field.name}` +
							`${hitCount > 0 && hitCount < ROUNDS ? " (INTERMITTENT)" : ""}`,
					);
					if (hitCount < MAJORITY) missed.push(field.name);
				}
				for (const [index, texts] of rounds.entries()) {
					report.push(`  round ${index + 1}:`);
					for (const text of texts) report.push(`    ${text}`);
				}
				process.stdout.write(`${report.join("\n")}\n`);

				expect(missed).toEqual([]);
			},
			900_000,
		);
	}
});
