/** @file atomic-session-batch-windows.test.ts
 * @purpose Proves one capture carrying a whole session, far over the extraction input budget, extracts every turn.
 * @boundary The real distiller (capture-batch windows, as `/v1/capture` builds it) over real encrypted SQLite; the model
 * is the only substitute.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ATOMIC_EXTRACTION_MAX_INPUT_TOKENS } from "../../../../packages/memory/config/index";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	AtomicInsightDistiller,
	type AtomicMemoryExtractionTransports,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-session-batch-windows";
const OPTIONS = { sessionDateTime: "2026-10-27T09:00:00Z", sessionTimezone: "UTC" };
const TURNS = 25;
const WORDS = Array.from({ length: TURNS }, (_, index) => `marigold${index}`);

/** A coding-session turn: one durable statement plus the kind of log noise a real session carries. */
function userTurn(index: number): string {
	const noise = `while running the build step ${index} the compiler printed the usual warnings about unused imports `
		.repeat(30);
	return `The release codename for module ${index} is ${WORDS[index]}. Also, ${noise.trim()}.`;
}

function sessionText(from: number, until: number): string {
	return Array.from({ length: until - from }, (_, offset) => {
		const index = from + offset;
		return [`user: ${userTurn(index)}`, `assistant: Noted the codename for module ${index}; the warnings are harmless.`];
	}).flat().join("\n");
}

function sectionTake(prompt: string, label: string): string {
	const after = prompt.split(`${label}:\n`)[1] ?? "";
	return after.split("<take>\n")[1]?.split("\n</take>")[0] ?? "";
}

/**
 * Answers each capture call with one record per codename the window's transcript really holds, and each enrichment
 * call from those records; `counter.captures` counts the capture calls. `failCapturesAfter`: capture calls past this many reject, as a run cut by its deadline.
 */
function transports(counter: { captures: number }, failCapturesAfter = Number.POSITIVE_INFINITY): AtomicMemoryExtractionTransports {
	const byClaim = new Map<string, Record<string, unknown>>();
	return {
		generic: {
			async complete({ callId, prompt }: { callId: string; prompt: string }) {
				// The missed-figure re-ask ships off; this substitute bypasses routing, so it answers it empty.
				if (callId === "E3") return { text: JSON.stringify({ records: [] }), truncated: false };
				if (prompt.includes("facts:\n")) {
					const facts = JSON.parse(sectionTake(prompt, "facts")) as Array<{ id: number; fact: string }>;
					return { text: JSON.stringify({ enrichments: facts.map(({ id, fact }) => ({ id, ...byClaim.get(fact) })) }), truncated: false };
				}
				counter.captures += 1;
				if (counter.captures > failCapturesAfter) throw new Error("timeout");
				const turns = JSON.parse(sectionTake(prompt, "transcript")) as Array<{ turn_index: number; role: string; content: string }>;
				const facts = turns.flatMap((turn) => {
					const match = /The release codename for module (\d+) is (marigold\d+)\./.exec(turn.content);
					if (turn.role !== "user" || !match) return [];
					const claim = `The release codename for module ${match[1]} is ${match[2]}.`;
					byClaim.set(claim, {
						kind: "standing", attribute: null, value: match[2], ends_current: false, importance: "medium",
						changes_current_state: false, todo: "none", close_reason: null, single_claim: true, relations: [],
						time: { kind: "unresolved" }, ended_time: { kind: "none" },
					});
					return [{ fact: claim, subject: "user", subject_kind: "user", temporal_phrase: null, ended_at_phrase: null,
						source_span: { turn_index: turn.turn_index, quote: match[0] } }];
				});
				return {
					text: JSON.stringify({
						claims_found: facts.map(({ source_span }) => source_span.turn_index),
						decisions: turns.filter((turn) => turn.role === "user").map((turn) => ({ turn_index: turn.turn_index, progress_only: false })),
						facts: facts.map((fact, id) => ({ id, ...fact })),
					}),
					truncated: false,
				};
			},
		},
		profileKeying: { async keyTurn() { return null; } },
		resplit: { async resplit() { return null; } },
		retirementVerdict: { async judge() { return "keep"; } },
		subjectGuard: {
			async repairMissingHalf() { return null; },
			async guardUserSubjects({ records }: { records: unknown[] }) { return records.map(() => true); },
		},
	} as unknown as AtomicMemoryExtractionTransports;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("one capture carrying a whole session", () => {
	const opened: Array<{ fixture: TestDb; store: MemoryStore }> = [];

	afterEach(async () => {
		for (const { fixture, store } of opened.splice(0)) {
			await store.close();
			fixture.cleanup();
		}
	});

	function distillerFor(counter: { captures: number }, failCapturesAfter?: number) {
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		opened.push({ fixture, store });
		return {
			store,
			distiller: new AtomicInsightDistiller(store, transports(counter, failCapturesAfter), {
				defaultScope: PROJECT_ID, locale: "en", captureBatch: true,
			}),
		};
	}

	function codenames(store: MemoryStore): string[] {
		return (store.sqlite.prepare("SELECT text FROM nodix_memories WHERE project_id = ?").all(PROJECT_ID) as { text: string }[])
			.flatMap(({ text }) => /marigold\d+/.exec(text)?.[0] ?? []).sort();
	}

	it("stores every turn's claim, leaves nothing pending, and calls the model less than per-turn capture", { timeout: 120_000 }, async () => {
		const text = sessionText(0, TURNS);
		expect(Math.ceil(text.length / 4)).toBeGreaterThan(3 * ATOMIC_EXTRACTION_MAX_INPUT_TOKENS);

		const batched = { captures: 0 };
		const { store, distiller } = distillerFor(batched);
		const result = await distiller.extractAndPersist(text, "whole-session", OPTIONS);
		const pending = store.sqlite.prepare("SELECT state, reprocess_reason FROM nodix_atomic_extraction_ledger WHERE state != 'complete'").all();
		expect({ codenames: codenames(store), pending, llmFailures: result.llmFailures ?? 0 })
			.toEqual({ codenames: [...WORDS].sort(), pending: [], llmFailures: 0 });

		const perTurn = { captures: 0 };
		const single = distillerFor(perTurn);
		for (let index = 0; index < TURNS; index += 1) {
			await single.distiller.extractAndPersist(sessionText(index, index + 1), "per-turn-session", OPTIONS);
		}
		expect(codenames(single.store)).toEqual([...WORDS].sort());
		expect(batched.captures).toBeLessThan(perTurn.captures);
	});

	it("resumes a capture cut off mid-session on the re-send without redoing finished windows", { timeout: 120_000 }, async () => {
		const text = sessionText(0, TURNS);
		const clean = { captures: 0 };
		await distillerFor(clean).distiller.extractAndPersist(text, "clean-session", OPTIONS);

		const cut = { captures: 0 };
		const { store, distiller } = distillerFor(cut, 1);
		await expect(distiller.extractAndPersist(text, "cut-session", OPTIONS)).rejects.toThrow("timeout");

		const resend = { captures: 0 };
		const again = new AtomicInsightDistiller(store, transports(resend), { defaultScope: PROJECT_ID, locale: "en", captureBatch: true });
		await again.extractAndPersist(text, "cut-session", OPTIONS);
		expect({ codenames: codenames(store), resendCaptures: resend.captures })
			.toEqual({ codenames: [...WORDS].sort(), resendCaptures: clean.captures - 1 });
	});
});
