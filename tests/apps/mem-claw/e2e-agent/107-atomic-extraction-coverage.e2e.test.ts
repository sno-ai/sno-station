import { readTestModelCalls, readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file 107-atomic-extraction-coverage.e2e.test.ts
 * @purpose Proves the facts a conversation states actually reach the store — the "everything in came out" check nothing else makes.
 * @boundary The whole live atomic extraction path into real encrypted SQLite; no mocks, real model calls.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AtomicExtractionTurn } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import {
	createSignedAtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../helpers/test-db";
import { assertLiveAgentE2EEnabled } from "./helpers/config";

/**
 * Every other atomic test asserts the SHAPE of a row that arrived. None of them asks whether the
 * facts the user actually stated arrived at all, so a silent drop — the most expensive kind of
 * memory bug there is — had no test anywhere in this repository that could go red for it.
 *
 * The material is two real Memora sessions kept in the tree, not invented dialogue, because an
 * authored conversation only tests the cases its author already thought of.
 */
const CORPUS_ROOT = path.resolve(import.meta.dirname, "../../../../evals/memora/data/weekly");
const EXTRACTOR_VERSION = "atomic-extraction-coverage";

/**
 * The model answers at temperature 0.7 by policy, and extraction is measured to drop roughly one
 * numeric fact in twenty run to run. One pass would therefore flake on a healthy build, so each
 * conversation is extracted three times and a fact counts as captured when it survives a
 * majority. The run prints the per-round hit pattern, so an intermittent fact is visible as
 * intermittent rather than being averaged into a pass.
 */
const ROUNDS = 3;
const MAJORITY = 2;

interface ExpectedFact {
	name: string;
	/** Every part must appear in one stored row's text, case-insensitively. */
	parts: string[];
}

interface CoverageCase {
	persona: string;
	sessionId: number;
	/** The rebased year the eval harness uses; the corpus itself is dated a year earlier. */
	facts: ExpectedFact[];
}

const CASES: CoverageCase[] = [
	{
		persona: "academic_researcher",
		// op=add, one coffee expense. This exact fact was missing from a live persona store.
		sessionId: 59,
		facts: [{ name: "the $5.51 coffee", parts: ["5.51", "coffee"] }],
	},
	{
		persona: "academic_researcher",
		// op=delete on the to-do list: the user reports finishing something they had queued.
		// Losing this turn leaves a completed to-do standing forever, which is a forgetting bug.
		sessionId: 36,
		facts: [{ name: "finishing the conference planning", parts: ["conference"] }],
	},
	// The three numeric facts a scored run actually lost, each one buried as a single sentence in
	// a long conversation about something else. Losing any one of them zeroes an aggregation
	// question outright: the answer key wants the exact weekly total, so a 92.7% per-fact capture
	// rate turns into a near-certain miss once eleven facts have to survive together.
	{
		persona: "content_writer",
		sessionId: 70,
		facts: [{ name: "the $6.23 coffee", parts: ["6.23", "coffee"] }],
	},
	{
		persona: "content_writer",
		sessionId: 134,
		facts: [{ name: "the $8.14 coffee", parts: ["8.14", "coffee"] }],
	},
	{
		persona: "content_writer",
		sessionId: 92,
		facts: [{ name: "the 4,471 steps", parts: ["4,471"] }],
	},
	// The two figures a scored run still lost AFTER the sweep landed, both buried at turn 11 of a
	// long conversation about something else. Together they are the whole $10.68 by which that
	// persona's weekly coffee total came out short.
	{
		persona: "business_executive",
		sessionId: 68,
		facts: [{ name: "the $4.22 coffee", parts: ["4.22", "coffee"] }],
	},
	{
		persona: "business_executive",
		sessionId: 138,
		facts: [{ name: "the $6.46 coffee", parts: ["6.46", "coffee"] }],
	},
];

interface CorpusSession {
	session_id: number;
	date: string;
	conversation: { turn: number; speaker: string; message: string }[];
}

function loadSession(persona: string, sessionId: number): CorpusSession {
	const file = path.join(
		CORPUS_ROOT,
		persona,
		"conversations",
		`session_${String(sessionId).padStart(4, "0")}.json`,
	);
	return JSON.parse(readFileSync(file, "utf8")) as CorpusSession;
}

function toTurns(session: CorpusSession): AtomicExtractionTurn[] {
	return session.conversation.map((turn) => ({
		role: turn.speaker === "user_agent" ? ("user" as const) : ("assistant" as const),
		content: turn.message,
	}));
}

async function storedTexts(session: CorpusSession, round: number): Promise<string[]> {
	const projectId = `coverage-${session.session_id}-${round}-${Date.now()}`;
	const embedder = await createTestEmbedder();
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		const turns = toTurns(session);
		// The eval harness rebases the corpus a year forward; mirror it so resolved dates land in
		// the same year the conversation claims.
		const sessionDate = new Date(`${session.date.replace("2025-", "2026-")}T12:00:00Z`);
		let nowMs = Date.now();
		const result = await runAtomicMemoryExtraction({
			store,
			projectId,
			ledgerKey: {
				conversationId: `${projectId}-conversation`,
				chunkHash: `${projectId}-chunk`,
				pipelineVersion: EXTRACTOR_VERSION,
			},
			turns,
			rawChunk: turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
			routingSnapshotId: `${projectId}-routing`,
			runParameters: { maxInputTokens: 16_384, outputTokenBudget: 8_192, subchunkCount: 1 },
			estimatedInputTokens: 2_000,
			extractorVersion: EXTRACTOR_VERSION,
			locale: "en",
			sessionDateTime: sessionDate.toISOString(),
			sessionTimestampMs: sessionDate.getTime(),
			sessionTimezone: "UTC",
			transports: createSignedAtomicMemoryExtractionTransports(
				{
					preset: "mem_claw/sno_extract_chat",
					apiKey: readTestSnoGpuSettings().apiKey,
					routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: readTestModelCalls() }),
					timeoutMs: 180_000,
				},
				"en",
			),
			nowMs: () => nowMs++,
			requestId: `${projectId}-request`,
		});
		if (result.status !== "complete") {
			throw new Error(`extraction ended as ${result.status}`);
		}
		return (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ? AND lane = 'active'")
				.all(projectId) as { text: string }[]
		).map(({ text }) => text.toLowerCase());
	} finally {
		await store.close();
		fixture.cleanup();
	}
}

function captured(texts: readonly string[], fact: ExpectedFact): boolean {
	return texts.some((text) => fact.parts.every((part) => text.includes(part.toLowerCase())));
}

describe("atomic extraction coverage", () => {
	for (const coverageCase of CASES) {
		it(
			`keeps every stated fact from ${coverageCase.persona} session ${coverageCase.sessionId}`,
			async () => {
				assertLiveAgentE2EEnabled();
				const session = loadSession(coverageCase.persona, coverageCase.sessionId);
				const rounds: string[][] = [];
				for (let round = 0; round < ROUNDS; round += 1) {
					rounds.push(await storedTexts(session, round));
				}

				const report: string[] = [
					`\n##### coverage session ${coverageCase.sessionId} — rows per round: ${rounds
						.map((texts) => texts.length)
						.join(", ")}`,
				];
				const missed: string[] = [];
				for (const fact of coverageCase.facts) {
					const hits = rounds.map((texts) => captured(texts, fact));
					const hitCount = hits.filter(Boolean).length;
					report.push(
						`  ${hitCount >= MAJORITY ? "OK   " : "MISS "} ${hitCount}/${ROUNDS} — ${fact.name}` +
							`${hitCount > 0 && hitCount < ROUNDS ? " (INTERMITTENT)" : ""}`,
					);
					if (hitCount < MAJORITY) missed.push(fact.name);
				}
				for (const [index, texts] of rounds.entries()) {
					report.push(`  round ${index + 1}:`);
					for (const text of texts) report.push(`    ${text}`);
				}
				process.stdout.write(`${report.join("\n")}\n`);

				expect(rounds.every((texts) => texts.length > 0)).toBe(true);
				expect(missed).toEqual([]);
			},
			900_000,
		);
	}
});
