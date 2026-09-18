import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec.ts";
import {
	parseProfileSectionJudgment,
	PROFILE_SECTION_JUDGMENT_CALL_LABEL,
	PROFILE_SECTION_TEXT_CALL_LABEL,
	retiredProfileSectionMarker,
	runProfileSectionUpdate,
} from "../../../../packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts";
import {
	createLlmClient,
	LlmClientTerminalError,
	type LlmClient,
} from "../../../../packages/sno-station-mem/src/model/llm-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "profile-section-writer-split";
const SECTION = "preferences.drinks";
const STARTED_AT = Date.parse("2026-08-04T09:00:00Z");
const EXISTING = "The user likes coffee.";
const INCOMING = "The user now likes tea.";

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
}

interface AuditRecord {
	decision?: string;
	details?: { mutation_outcome?: string; refusal_reason?: string };
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder.dispose?.();
});

describe("profile section judgment/text split", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.store.close();
		fixture?.testDb.cleanup();
		fixture = undefined;
	});

	function buildFixture(): Fixture {
		const testDb = createTestDb();
		return { store: new MemoryStore({ dbPath: testDb.dbPath, embedder }), testDb };
	}

	async function seed(content = EXISTING): Promise<string> {
		fixture = buildFixture();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: content,
			source: { messageId: "split-seed" },
			store: fixture.store,
			at: STARTED_AT,
		});
		return result.rowId;
	}

	function splitLlm(input: {
		judgment: unknown;
		text?: unknown;
		calls?: string[];
		requests?: Parameters<LlmClient["completeJson"]>[0][];
	}): LlmClient {
		return createTestLlmClient({
			async completeJson<T>(
				request: Parameters<LlmClient["completeJson"]>[0],
			): Promise<T> {
				input.calls?.push(request.callLabel);
				input.requests?.push(request);
				if (request.callLabel === "profile-retirement-recheck") return { retire: true } as T;
				if (request.callLabel === PROFILE_SECTION_JUDGMENT_CALL_LABEL) {
					return input.judgment as T;
				}
				if (request.callLabel === PROFILE_SECTION_TEXT_CALL_LABEL) {
					if (input.text instanceof Error) throw input.text;
					return input.text as T;
				}
				throw new Error(`unexpected call label ${request.callLabel}`);
			},
		});
	}

	function current(): ReturnType<MemoryStore["getByFactKey"]> {
		return fixture?.store.getByFactKey(SCOPE, `profile:${SECTION}`);
	}

	async function episodicAssertions(): Promise<string[]> {
		const rows = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		return rows?.map((row) => row.text) ?? [];
	}

	function terminalAudit(): AuditRecord {
		if (!fixture) throw new Error("fixture missing");
		const records = readFileSync(join(dirname(fixture.store.dbPath), "audit.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as AuditRecord);
		const terminal = records.at(-1);
		if (!terminal) throw new Error("terminal audit record missing");
		return terminal;
	}

	it("confirms a partial restatement before refusing an older delayed preference", async () => {
		await seed("The user likes coffee.\nThe user drinks water with meals.");
		if (!fixture) throw new Error("fixture missing");
		const confirmed = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: "The user likes coffee.",
			source: { messageId: "partial-confirmation" },
			store: fixture.store,
			llm: splitLlm({ judgment: { verdict: "no-op", retired_clause_indices: [] } }),
			at: Date.parse("2026-08-04T09:00:02Z"),
		});
		expect(confirmed.outcome).toBe("no-op");
		expect.soft(parseInsightMetadata(current()?.metadata, current()).valid_from)
			.toBe(1785834002000);
		const delayed = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: "The user now likes tea.",
			source: { messageId: "delayed-preference" },
			store: fixture.store,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: {
					abstract: "The user now likes tea.",
					overview: "The user drinks water with meals and likes tea.",
					content: "The user drinks water with meals.\nThe user now likes tea.",
				},
			}),
			at: Date.parse("2026-08-04T09:00:01Z"),
		});
		expect.soft(delayed.outcome).toBe("no-op");
		expect(parseInsightMetadata(current()?.metadata, current()).l2_content)
			.toBe("The user likes coffee.\nThe user drinks water with meals.");
	});

	it("uses a prose-free judgment call before a separate text call", async () => {
		const existingId = await seed();
		const calls: string[] = [];
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-merge" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: { abstract: INCOMING, overview: `- ${INCOMING}`, content: INCOMING },
				calls,
			}),
			at: STARTED_AT + 1_000,
		});

		expect(calls).toEqual([
			PROFILE_SECTION_JUDGMENT_CALL_LABEL,
			PROFILE_SECTION_TEXT_CALL_LABEL,
		]);
		expect(result).toMatchObject({ outcome: "merged" });
		expect(result.rowId).not.toBe(existingId);
		expect(current()?.text).toBe(INCOMING);
		expect(parseInsightMetadata(current()?.metadata, current())).not.toHaveProperty(
			"merged_without_adjudication",
		);
		expect(terminalAudit().details?.mutation_outcome).toBe("committed");
	});

	it("propagates the adapter slot, timeout, and signal to both split calls", async () => {
		await seed();
		const requests: Parameters<LlmClient["completeJson"]>[0][] = [];
		const controller = new AbortController();
		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-request-propagation" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: { abstract: INCOMING, overview: `- ${INCOMING}`, content: INCOMING },
				requests,
			}),
			at: STARTED_AT + 1_000,
			timeoutMs: 4_321,
			signal: controller.signal,
		});

		expect(requests).toHaveLength(2);
		expect(requests.map(({ callLabel }) => callLabel)).toEqual([
			PROFILE_SECTION_JUDGMENT_CALL_LABEL,
			PROFILE_SECTION_TEXT_CALL_LABEL,
		]);
		for (const request of requests) {
			expect(request.adapterSlot).toBe("profile-merge");
			expect(request.timeoutMs).toBe(4_321);
			expect(request.signal).toBe(controller.signal);
		}
		const textRequest = requests.find(
			(request) => request.callLabel === PROFILE_SECTION_TEXT_CALL_LABEL,
		);
		expect(textRequest?.prompt).toContain("Do not add connective text or any other clause");
		expect(textRequest?.prompt).not.toContain("You may add connective text");
	});

	it.each([
		["old fused response", { action: "merge", content: INCOMING, superseded: [EXISTING] }],
		["null response", null],
		["out-of-range index", { verdict: "merge", retired_clause_indices: [9] }],
		["repeated index", { verdict: "merge", retired_clause_indices: [0, 0] }],
		["tombstone with indices", { verdict: "tombstone", retired_clause_indices: [0] }],
		["all incoming retired", { verdict: "merge", retired_clause_indices: [1] }],
	] as const)("preserves and marks an unusable judgment: %s", async (_label, judgment) => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: `split-fallback-${_label}` },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({ judgment }),
			at: STARTED_AT + 1_000,
		});

		expect(result).toMatchObject({ outcome: "merged" });
		expect(result.rowId).not.toBe(existingId);
		expect(current()?.text).toContain(EXISTING);
		expect(current()?.text).toContain(INCOMING);
		expect(parseInsightMetadata(current()?.metadata, current())).toMatchObject({
			merged_without_adjudication: true,
		});
		expect(terminalAudit().details?.mutation_outcome).toBe(
			"preserved-without-adjudication",
		);
	});

	it("preserves and marks when the live merge route is genuinely unreachable", async () => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-unreachable-route" },
			store: fixture?.store as MemoryStore,
			llm: createLlmClient({
				apiKey: "unreachable",
				baseURL: "http://127.0.0.1:1/v1",
				preset: "mem_claw/sno_ai_extract",
				timeoutMs: 2_000,
			}),
			at: STARTED_AT + 1_000,
		});

		expect(result).toMatchObject({ outcome: "merged" });
		expect(result.rowId).not.toBe(existingId);
		expect(current()?.text).toContain(EXISTING);
		expect(current()?.text).toContain(INCOMING);
		expect(parseInsightMetadata(current()?.metadata, current())).toMatchObject({
			merged_without_adjudication: true,
		});
		expect(terminalAudit().details?.mutation_outcome).toBe(
			"preserved-without-adjudication",
		);
	});

	it("writes the judged clauses when the text step returns nothing", async () => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-empty-text" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: { abstract: "tea", overview: "tea", content: "   " },
			}),
			at: STARTED_AT + 1_000,
		});

		// The judgment retired clause 0 and kept the incoming one. The text step returning blank
		// used to leave the row stale and file the incoming fact as an episodic row instead; the
		// judged clause set is the answer already, so it is written directly.
		expect(current()?.text).toContain(INCOMING);
		expect(current()?.text).not.toBe(retiredProfileSectionMarker(SECTION));
		expect(await episodicAssertions()).not.toContain(INCOMING);
		expect(terminalAudit().details?.mutation_outcome).toBe("repaired-merge-text");
	});

	it("puts back a clause when the text step duplicates another clause", async () => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-dropped-clause" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [] },
				text: {
					abstract: EXISTING,
					overview: `- ${EXISTING}`,
					content: `${EXISTING}\n${EXISTING}`,
				},
			}),
			at: STARTED_AT + 1_000,
		});

		// The rewrite duplicated the existing text, losing the incoming clause. That used to
		// discard the whole write and file the incoming fact as an episodic row; now the missing
		// clause is put back and the section itself carries both.
		expect(current()?.text).toContain(EXISTING);
		expect(current()?.text).toContain(INCOMING);
		expect(await episodicAssertions()).not.toContain(INCOMING);
		expect(terminalAudit().details?.mutation_outcome).toBe("repaired-merge-text");
	});

	it.each([
		["timeout", new LlmClientTerminalError("timeout", "injected timeout")],
		[
			"request timeout",
			new LlmClientTerminalError("cancelled", "injected request timeout", true),
		],
	] as const)("writes the judged clauses after a %s", async (_label, injectedError) => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: `split-${_label}` },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: injectedError,
			}),
			at: STARTED_AT + 1_000,
		});

		// The judgment retired the old clause and kept the incoming one before the text call was
		// ever made, so a failed text call has nothing left to decide. This used to leave the row
		// stale and file the incoming fact as an episodic row instead — a plain dependency failure
		// silently cost the profile its update while the caller was told a row had been written.
		expect(result.outcome).toBe("merged");
		// A merge supersedes: the section keeps its identity through fact_key, not through the row id.
		expect(result.rowId).not.toBe(existingId);
		expect(current()?.text).toContain(INCOMING);
		expect(current()?.text).not.toContain(EXISTING);
		expect(await episodicAssertions()).toEqual([]);
	});

	it("writes the judged clauses after a malformed text response", async () => {
		const existingId = await seed();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-malformed-text" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: { content: 42 },
			}),
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		// A merge supersedes: the section keeps its identity through fact_key, not through the row id.
		expect(result.rowId).not.toBe(existingId);
		expect(current()?.text).toContain(INCOMING);
		expect(current()?.text).not.toContain(EXISTING);
		expect(await episodicAssertions()).toEqual([]);
	});

	it.each([
		["authentication", new LlmClientTerminalError("auth", "injected auth failure")],
		["cancellation", new LlmClientTerminalError("cancelled", "injected cancellation")],
	] as const)("propagates %s failures from the text step", async (_label, injectedError) => {
		await seed();
		await expect(
			runProfileSectionUpdate({
				scope: SCOPE,
				sectionName: SECTION,
				newAssertion: INCOMING,
				source: { messageId: `split-${_label}` },
				store: fixture?.store as MemoryStore,
				llm: splitLlm({
					judgment: { verdict: "merge", retired_clause_indices: [0] },
					text: injectedError,
				}),
				at: STARTED_AT + 1_000,
			}),
		).rejects.toBe(injectedError);
		expect(await episodicAssertions()).toEqual([]);
	});

	it("does not duplicate concurrent merges or later replays", async () => {
		await seed();
		const params = {
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: INCOMING,
			source: { messageId: "split-safety-net-replay" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({
				judgment: { verdict: "merge", retired_clause_indices: [0] },
				text: { abstract: "tea", overview: "tea", content: "   " },
			}),
			at: STARTED_AT + 1_000,
		};
		const concurrent = await Promise.all([
			runProfileSectionUpdate(params),
			runProfileSectionUpdate(params),
		]);
		const replay = await runProfileSectionUpdate(params);

		expect(concurrent.map((result) => result.outcome).sort()).toEqual(["merged", "no-op"]);
		expect(concurrent[0]?.rowId).toBe(concurrent[1]?.rowId);
		expect(replay).toEqual({ outcome: "no-op", rowId: concurrent[0]?.rowId });
		// No episodic row is written for a blank text step any more: the section itself takes the
		// judged clauses, so there is nothing to park elsewhere and nothing to deduplicate.
		expect(await episodicAssertions()).toEqual([]);
		expect(terminalAudit()).toMatchObject({
			decision: "no-mutation",
			details: { mutation_outcome: "no-mutation" },
		});
	});

	it("writes a code-owned marker for an explicit tombstone without calling text generation", async () => {
		await seed();
		const calls: string[] = [];
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: "Remove the saved drink preference.",
			source: { messageId: "split-tombstone" },
			store: fixture?.store as MemoryStore,
			llm: splitLlm({ judgment: { verdict: "tombstone", retired_clause_indices: [] }, calls }),
			at: STARTED_AT + 1_000,
		});

		expect(calls).toEqual([PROFILE_SECTION_JUDGMENT_CALL_LABEL]);
		expect(result.outcome).toBe("tombstoned");
		expect(current()?.text).toBe(retiredProfileSectionMarker(SECTION));
	});

	it("rejects prose and malformed index contracts at the judgment boundary", () => {
		const clauses = [
			{ origin: "stored" as const, value: EXISTING },
			{ origin: "incoming" as const, value: INCOMING },
		];
		expect(
			parseProfileSectionJudgment(
				{ verdict: "merge", retired_clause_indices: [0], content: INCOMING },
				clauses,
			),
		).toBeUndefined();
		for (const response of [
			{ verdict: "merge", retired_clause_indices: [0, 0] },
			{ verdict: "merge", retired_clause_indices: [1] },
			{ verdict: "tombstone", retired_clause_indices: [0] },
			{ verdict: "no-op", retired_clause_indices: [0] },
		]) {
			expect(parseProfileSectionJudgment(response, clauses)).toBeUndefined();
		}
	});

	it("refuses a blank scope instead of writing into a shared profile", async () => {
		fixture = buildFixture();
		for (const scope of ["", "   "]) {
			await expect(
				runProfileSectionUpdate({
					scope,
					sectionName: SECTION,
					newAssertion: INCOMING,
					source: { messageId: "profile-blank-scope" },
					store: fixture.store,
					at: STARTED_AT,
				}),
			).rejects.toThrow("scope is required");
		}
		// The name promises no shared profile is written, so the refusal has to be proved to
		// come before the write, not merely alongside it.
		expect(await fixture.store.list({ category: "profile", limit: 10 })).toEqual([]);
	});
});
