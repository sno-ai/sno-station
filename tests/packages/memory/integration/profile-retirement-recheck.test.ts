import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec.ts";
import {
	PROFILE_RETIREMENT_RECHECK_CALL_LABEL,
	PROFILE_RETIREMENT_RECHECK_PROMPT_SHA256,
	PROFILE_SECTION_JUDGMENT_CALL_LABEL,
	PROFILE_SECTION_TEXT_CALL_LABEL,
	type RetireByNameRunBudget,
	runProfileSectionUpdate,
} from "../../../../packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts";
import {
	type LlmClient,
	LlmClientTerminalError,
	type MemoryLlmRequest,
} from "../../../../packages/sno-station-mem/src/model/llm-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "profile-retirement-recheck";
const SECTION = "preferences.general";
const STARTED_AT = Date.parse("2026-09-01T00:00:00Z");
const TEA = "The user likes tea.";
const PLANNER = "The user keeps a paper planner.";
const COFFEE = "The user now likes coffee.";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder?.dispose?.();
});

describe("profile retirement recheck", () => {
	let store: MemoryStore | undefined;
	let testDb: TestDb | undefined;

	afterEach(() => {
		store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	/** The judge retires BOTH stored clauses; only the tea clause is a real replacement. */
	function judgeRetiresBoth(
		recheck: (request: MemoryLlmRequest) => Promise<unknown>,
		seen: MemoryLlmRequest[],
	): LlmClient {
		return createTestLlmClient({
			async completeJson<T>(request: MemoryLlmRequest): Promise<T | null> {
				seen.push(request);
				if (request.callLabel === PROFILE_SECTION_JUDGMENT_CALL_LABEL) {
					return { verdict: "merge", retired_clause_indices: [0, 1] } as T;
				}
				if (request.callLabel === PROFILE_RETIREMENT_RECHECK_CALL_LABEL) {
					return (await recheck(request)) as T;
				}
				if (request.callLabel === PROFILE_SECTION_TEXT_CALL_LABEL) {
					// Malformed on purpose: the row is then written from the judged clause set.
					return { content: 42 } as T;
				}
				return null;
			},
		});
	}

	async function seedAndMerge(
		llm: LlmClient,
		retireByNameBudget?: RetireByNameRunBudget,
	): Promise<string> {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: `${TEA}\n${PLANNER}`,
			source: { messageId: "recheck-seed" },
			store,
			at: STARTED_AT,
		});
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: COFFEE,
			source: { messageId: "recheck-merge" },
			store,
			llm,
			at: STARTED_AT + 1_000,
			...(retireByNameBudget ? { retireByNameBudget } : {}),
		});
		expect(result.outcome).toBe("merged");
		const current = store.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!current) throw new Error("current profile row missing");
		return current.id;
	}

	it("keeps the clause the second key does not confirm and stamps a receipt", async () => {
		const seen: MemoryLlmRequest[] = [];
		const llm = judgeRetiresBoth(async (request) => {
			return { retire: request.prompt.includes(`Stored clause (retired): ${JSON.stringify(TEA)}`) };
		}, seen);
		const id = await seedAndMerge(llm);
		const row = store?.getById(id);
		const metadata = parseInsightMetadata(row?.metadata, row);
		expect(metadata.l2_content).toBe(`${PLANNER}\n${COFFEE}`);
		expect(metadata.profile_retirement_recheck).toMatchObject({
			prompt_sha256: PROFILE_RETIREMENT_RECHECK_PROMPT_SHA256,
			retired: [TEA],
			kept: [PLANNER],
			unchecked: 0,
		});
		const rechecks = seen.filter(
			(request) => request.callLabel === PROFILE_RETIREMENT_RECHECK_CALL_LABEL,
		);
		expect(rechecks).toHaveLength(2);
		for (const request of rechecks) {
			expect(request.prompt).toContain(`Section: ${SECTION}`);
			expect(request.prompt).toContain(`Incoming assertion: ${JSON.stringify(COFFEE)}`);
			expect(request.enableThinking).toBe(false);
		}
	});

	it("keeps every retired clause when the second key fails on the transport", async () => {
		const llm = judgeRetiresBoth(async () => {
			throw new LlmClientTerminalError("transport", "planted recheck failure");
		}, []);
		const id = await seedAndMerge(llm);
		const row = store?.getById(id);
		const metadata = parseInsightMetadata(row?.metadata, row);
		expect(metadata.l2_content).toBe(`${TEA}\n${PLANNER}\n${COFFEE}`);
		expect(metadata.profile_retirement_recheck).toMatchObject({ retired: [], kept: [TEA, PLANNER] });
	});

	it("keeps every retired clause when the second key answers in the wrong shape", async () => {
		const llm = judgeRetiresBoth(async () => ({ retire: "yes", extra: true }), []);
		const id = await seedAndMerge(llm);
		const row = store?.getById(id);
		const metadata = parseInsightMetadata(row?.metadata, row);
		expect(metadata.l2_content).toBe(`${TEA}\n${PLANNER}\n${COFFEE}`);
	});

	// The sibling owns the topic but its content names Hitchcock, not James Stewart, so the
	// stored general clause is the last copy of that fact. Measured 2026-09-02 on 13 such
	// clauses: with sibling NAMES only the judge retired 4 and was unstable on 2 more; with the
	// sibling CONTENT in the prompt it retired none, and still retired 14 of 20 real replacements.
	it("keeps a general clause no live sibling already states", async () => {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.films",
			newAssertion: "The user likes Hitchcock films.",
			source: { messageId: "ownership-sibling" },
			store,
			at: STARTED_AT,
		});
		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.general",
			newAssertion: `The user likes James Stewart movies.\n${PLANNER}`,
			source: { messageId: "ownership-general-seed" },
			store,
			at: STARTED_AT,
		});
		let recheckPrompt = "";
		const llm = createTestLlmClient({
			async completeJson<T>(request: MemoryLlmRequest): Promise<T | null> {
				if (request.callLabel === PROFILE_SECTION_JUDGMENT_CALL_LABEL) {
					return { verdict: "merge", retired_clause_indices: [0] } as T;
				}
				if (request.callLabel === PROFILE_RETIREMENT_RECHECK_CALL_LABEL) {
					recheckPrompt = request.prompt;
					// Answer the DEC-10 question: retire only when a sibling ALREADY STATES the
					// fact. Read the sibling block alone — the stored clause is elsewhere in the
					// prompt, so a whole-prompt match would answer yes to everything.
					const siblings = request.prompt.slice(
						request.prompt.indexOf("Live sibling sections and their content:"),
					);
					return { retire: siblings.includes("James Stewart") } as T;
				}
				if (request.callLabel === "profile-section-lifecycle-retirement") {
					return { lifecycle_retired_clause_indices: [] } as T;
				}
				if (request.callLabel === PROFILE_SECTION_TEXT_CALL_LABEL) {
					return { content: 42 } as T;
				}
				return null;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.general",
			newAssertion: COFFEE,
			source: { messageId: "ownership-general-update" },
			store,
			llm,
			at: STARTED_AT + 1_000,
		});
		const current = store.getById(result.rowId);

		expect(recheckPrompt).toContain(
			'Live sibling sections and their content: {"preferences.films":"The user likes Hitchcock films."}',
		);
		expect(parseInsightMetadata(current?.metadata, current).l2_content).toBe(
			`The user likes James Stewart movies.\n${PLANNER}\n${COFFEE}`,
		);
	});

	it("keeps rechecks independent from the retire-by-name judgment count", async () => {
		const seen: MemoryLlmRequest[] = [];
		const budget = { remaining: 0, deadlineMs: Date.now() + 30_000 };
		const llm = judgeRetiresBoth(async () => ({ retire: true }), seen);
		const id = await seedAndMerge(llm, budget);
		const row = store?.getById(id);
		const metadata = parseInsightMetadata(row?.metadata, row);

		expect(
			seen.filter((request) => request.callLabel === PROFILE_RETIREMENT_RECHECK_CALL_LABEL),
		).toHaveLength(2);
		expect(budget.remaining).toBe(0);
		expect(metadata.l2_content).toBe(COFFEE);
		expect(metadata.profile_retirement_recheck).toMatchObject({ unchecked: 0 });
	});

	it("keeps rechecks independent from the retire-by-name deadline", async () => {
		const seen: MemoryLlmRequest[] = [];
		const budget = { remaining: 2, deadlineMs: Date.now() - 1 };
		const llm = judgeRetiresBoth(async () => ({ retire: true }), seen);
		const id = await seedAndMerge(llm, budget);
		const row = store?.getById(id);
		const metadata = parseInsightMetadata(row?.metadata, row);

		expect(
			seen.filter((request) => request.callLabel === PROFILE_RETIREMENT_RECHECK_CALL_LABEL),
		).toHaveLength(2);
		expect(budget.remaining).toBe(2);
		expect(metadata.l2_content).toBe(COFFEE);
		expect(metadata.profile_retirement_recheck).toMatchObject({ unchecked: 0 });
	});
});
