/** Real encrypted SQLite + real ONNX embedder. The LLM boundary is deterministic. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../packages/sno-station-mem/src/engine/extraction/profile-section-writer.ts";
import {
	createLlmClient,
	type LlmClient,
} from "../../../../packages/sno-station-mem/src/model/llm-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createLegacyProfileTestLlmClient as createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "profile-merge-preservation";
const SECTION = "entities.project_atlas";
const STARTED_AT = Date.parse("2026-07-28T00:00:00Z");
const REAL_MERGE_SAMPLE = [
	{
		section: "entities.project_atlas",
		existing: "Project Atlas has 12 contributors in Austin as of March 5, 2026.",
		incoming: "Alice scheduled a Project Atlas review in Austin for March 6, 2026.",
		requiredTerms: [
			["Project Atlas"],
			["12"],
			["Austin"],
			["March 5, 2026", "2026-03-05"],
			["Alice"],
			["March 6, 2026", "2026-03-06"],
		],
	},
	{
		section: "entities.project_orion",
		existing: "Project Orion uses 24 servers in Seattle as of April 8, 2026.",
		incoming: "Bob added a Project Orion dashboard in Seattle on April 9, 2026.",
		requiredTerms: [
			["Project Orion"],
			["24"],
			["Seattle"],
			["April 8, 2026", "2026-04-08"],
			["Bob"],
			["April 9, 2026", "2026-04-09"],
		],
	},
	{
		section: "entities.nasa",
		existing: "NASA tracks 7 satellites over Houston as of May 10, 2026.",
		incoming: "Carol scheduled a NASA review in Houston for May 11, 2026.",
		requiredTerms: [
			["NASA"],
			["7"],
			["Houston"],
			["May 10, 2026", "2026-05-10"],
			["Carol"],
			["May 11, 2026", "2026-05-11"],
		],
	},
	{
		section: "entities.openai",
		existing: "OpenAI runs 3 labs in Boston as of June 12, 2026.",
		incoming: "David scheduled an OpenAI briefing in Boston on June 13, 2026.",
		requiredTerms: [
			["OpenAI"],
			["3"],
			["Boston"],
			["June 12, 2026", "2026-06-12"],
			["David"],
			["June 13, 2026", "2026-06-13"],
		],
	},
	{
		section: "entities.mobile_partners",
		existing: "iPhone version 17 is tested by eBay in Zürich as of July 1, 2026.",
		incoming: "Eve scheduled an iPhone and eBay review in Zürich for July 2, 2026.",
		requiredTerms: [
			["iPhone"],
			["17"],
			["eBay"],
			["Zürich"],
			["July 1, 2026", "2026-07-01"],
			["Eve"],
			["July 2, 2026", "2026-07-02"],
		],
	},
	{
		section: "entities.project_stars",
		existing: "李雷在北京负责星河项目，截至2026-07-03共有8名成员。",
		incoming: "韩梅在北京为星河项目安排了2026-07-04评审。",
		requiredTerms: [
			["李雷"],
			["北京"],
			["星河"],
			["2026-07-03"],
			["8"],
			["韩梅"],
			["2026-07-04"],
		],
	},
	{
		section: "entities.project_vega",
		existing: "Project Vega reserves 1.50 TB in Denver as of July 5, 2026.",
		incoming: "Frank set a 1.0 GB Project Vega cache in Denver on July 6, 2026.",
		requiredTerms: [
			["Project Vega"],
			["1.50", "1.5"],
			["TB"],
			["Denver"],
			["July 5, 2026", "2026-07-05"],
			["Frank"],
			["1.0", "1"],
			["GB"],
			["July 6, 2026", "2026-07-06"],
		],
	},
	{
		section: "entities.mozilla",
		existing: "Mozilla operates 2 labs in Toronto as of July 7, 2026.",
		incoming: "Grace scheduled a Mozilla briefing in Toronto on July 8, 2026.",
		requiredTerms: [
			["Mozilla"],
			["2"],
			["Toronto"],
			["July 7, 2026", "2026-07-07"],
			["Grace"],
			["July 8, 2026", "2026-07-08"],
		],
	},
] as const;

let embedder: Embedder;

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
}

function replyPreservesRequiredTerms(
	reply: Record<string, unknown> | null,
	requiredTerms: readonly (readonly string[])[],
): boolean | undefined {
	if (reply?.action !== "merge" || typeof reply.content !== "string") return undefined;
	const normalizedContent = reply.content.normalize("NFKC").toLocaleLowerCase();
	return requiredTerms.every((alternatives) =>
		alternatives.some((term) =>
			normalizedContent.includes(term.normalize("NFKC").toLocaleLowerCase()),
		),
	);
}

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder?.dispose?.();
});

describe("profile merge preservation", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.store.close();
		fixture?.testDb.cleanup();
		fixture = undefined;
	});

	function buildFixture(): Fixture {
		const testDb = createTestDb();
		return {
			store: new MemoryStore({ dbPath: testDb.dbPath, embedder }),
			testDb,
		};
	}

	async function seed(existingContent: string, sectionName = SECTION): Promise<string> {
		fixture = buildFixture();
		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName,
			newAssertion: existingContent,
			source: { messageId: "merge-preservation-seed" },
			store: fixture.store,
			at: STARTED_AT,
		});
		return result.rowId;
	}

	function currentContent(sectionName = SECTION): string | undefined {
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${sectionName}`);
		return current ? parseInsightMetadata(current.metadata, current).l2_content : undefined;
	}

	it("keeps every clause when the text response is lossy", async () => {
		const existingContent =
			"Project Atlas is led by Alice in Austin with 12 contributors since March 5, 2026.";
		const incomingAssertion = "Bob joined Project Atlas in Boston on March 6, 2026.";
		const existingId = await seed(existingContent);
		const lossyLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: "Project Atlas is led by Alice and Bob in Boston since March 6, 2026.",
					superseded: [],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-lossy" },
			store: fixture?.store as MemoryStore,
			llm: lossyLlm,
			at: STARTED_AT + 1_000,
		});

		// The text step's answer dropped clauses, so it is discarded and the judged clauses
		// are written instead. Nothing the user said is lost — that is what this case guards.
		expect(result.outcome).toBe("merged");
		expect(currentContent()).toBe(`${existingContent}\n${incomingAssertion}`);
		expect(existingId).toBeTruthy();
		const activeRows = await fixture?.store.list({
			projectId: SCOPE,
			category: "profile",
			limit: 10,
		});
		// The seeded row is superseded by the merged one, so both are listed.
		expect(activeRows).toHaveLength(2);
		const nonActive = await fixture?.store.list({
			projectId: SCOPE,
			category: "profile",
			lane: "quarantined",
			limit: 10,
		});
		expect(nonActive).toHaveLength(0);
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toHaveLength(0);
		const unplaced = fixture?.store.listUnplacedCandidates({ projectId: SCOPE });
		expect(unplaced).toHaveLength(0);
	});

	it.each([
		{
			label: "mixed-case brands",
			section: "entities.mobile_partners",
			existing: "iPhone is maintained by eBay in Zürich.",
			incoming: "Alice scheduled an iPhone review in Zürich.",
			merged: "Alice scheduled a review in Zürich.",
		},
		{
			label: "Chinese names",
			section: "entities.project_stars",
			existing: "李雷在北京负责星河项目。",
			incoming: "韩梅加入星河项目。",
			merged: "韩梅加入项目。",
		},
	])("keeps every clause when a lossy text response contains $label", async (sample) => {
		const existingId = await seed(sample.existing, sample.section);
		const lossyLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: sample.merged,
					superseded: [],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: sample.section,
			newAssertion: sample.incoming,
			source: { messageId: `merge-preservation-${sample.label}` },
			store: fixture?.store as MemoryStore,
			llm: lossyLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(currentContent(sample.section)).toBe(`${sample.existing}\n${sample.incoming}`);
		expect(existingId).toBeTruthy();
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toHaveLength(0);
		const unplaced = fixture?.store.listUnplacedCandidates({ projectId: SCOPE });
		expect(unplaced).toHaveLength(0);
	});

	it("keeps every whole clause when the rewording would not preserve them", async () => {
		const existingContent =
			"Project Atlas has 12 contributors in Austin as of March 5, 2026, led by Alice.";
		const incomingAssertion =
			"Alice confirmed Project Atlas still has 12 contributors in Austin on March 5, 2026.";
		const mergedContent =
			"As of March 5, 2026, Alice leads Project Atlas in Austin with 12 contributors.";
		const existingId = await seed(existingContent);
		const rewordingLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: mergedContent,
					superseded: [],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-rewording" },
			store: fixture?.store as MemoryStore,
			llm: rewordingLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(currentContent()).toBe(`${existingContent}\n${incomingAssertion}`);
		expect(existingId).toBeTruthy();
		expect(
			await fixture?.store.list({
				projectId: SCOPE,
				category: "profile",
				lane: "quarantined",
				limit: 10,
			}),
		).toEqual([]);
	});

	it("accepts a last-write-wins identity replacement", async () => {
		const existingContent = "The user's name is Alice.";
		const incomingAssertion = "The user's name is Bob.";
		const existingId = await seed(existingContent, "identity");
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: incomingAssertion,
					superseded: [existingContent],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "identity",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-identity-replacement" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		expect(currentContent("identity")).toBe(incomingAssertion);
	});

	it("preserves every identity fact when no merge model is available", async () => {
		const existingContent =
			"The user's name is Alice.\nThe user works as an engineer.\nThe user lives in Austin.";
		const incomingAssertion = "The user now works as a researcher.";
		await seed(existingContent, "identity");

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "identity",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-identity-no-model" },
			store: fixture?.store as MemoryStore,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		const current = fixture?.store.getByFactKey(SCOPE, "profile:identity")?.text;
		expect(current).toContain("The user's name is Alice.");
		expect(current).toContain("The user works as an engineer.");
		expect(current).toContain("The user lives in Austin.");
		expect(current).toContain(incomingAssertion);
	});

	it("accepts an explicitly superseded numeric preference", async () => {
		const existingContent = "The user schedules reviews 3 days ahead.";
		const incomingAssertion = "The user now schedules reviews 5 days ahead.";
		const existingId = await seed(existingContent, "preferences.scheduling");
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: incomingAssertion,
					superseded: [existingContent],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.scheduling",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-preference-replacement" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		expect(currentContent("preferences.scheduling")).toBe(incomingAssertion);
	});

	it("shows the merge model every exact clause eligible for supersession", async () => {
		const existingContent = "The user schedules reviews 3 days ahead.";
		const incomingAssertion =
			"The user now schedules reviews 5 days ahead. The earlier timing is obsolete.";
		const currentState = "The user schedules reviews 5 days ahead.";
		await seed(existingContent, "preferences.scheduling");
		let mergePrompt = "";
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(
				request: Parameters<LlmClient["completeJson"]>[0],
			): Promise<T> {
				mergePrompt = request.prompt;
				return {
					action: "merge",
					content: currentState,
					superseded: [existingContent, "The earlier timing is obsolete."],
				} as T;
			},
		});

		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.scheduling",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-eligible-clause-prompt" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		const promptLine = mergePrompt
			.split("\n")
			.find((line) => line.startsWith("Eligible clauses: "));
		if (!promptLine) throw new Error("expected eligible clause prompt line");
		expect(JSON.parse(promptLine.slice("Eligible clauses: ".length))).toEqual([
			{ origin: "stored", value: existingContent },
			{ origin: "incoming", value: "The user now schedules reviews 5 days ahead." },
			{ origin: "incoming", value: "The earlier timing is obsolete." },
		]);
	});

	it("keeps a sentence with amount and date commas as one eligible clause", async () => {
		const existingContent = "The user's current budget is $1,000,000.";
		const incomingAssertion =
			"The user's current budget is set to $1,100,000, replacing the incorrect value of $875,000 as of June 4, 2025.";
		const historicalClause = incomingAssertion;
		await seed(existingContent, "preferences.budget");
		let mergePrompt = "";
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(
				request: Parameters<LlmClient["completeJson"]>[0],
			): Promise<T> {
				mergePrompt = request.prompt;
				return {
					action: "merge",
					content: "The user's current budget is set to $1,100,000.",
					superseded: [existingContent, historicalClause],
				} as T;
			},
		});

		await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.budget",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-lossless-clause-split" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		const promptLine = mergePrompt
			.split("\n")
			.find((line) => line.startsWith("Eligible clauses: "));
		if (!promptLine) throw new Error("expected eligible clause prompt line");
		const eligible = JSON.parse(
			promptLine.slice("Eligible clauses: ".length),
		) as Array<{ origin: "stored" | "incoming"; value: string }>;
		// A comma boundary used to cut this in two at ", replacing". Measured on the
		// 2026-09-01 run, that rule made 111 of 551 live `preferences.general` clauses
		// sentence halves, each judged and retired on its own, so it was removed.
		expect(eligible).toEqual([
			{ origin: "stored", value: existingContent },
			{ origin: "incoming", value: incomingAssertion },
		]);
		expect(eligible.slice(1).map(({ value }) => value).join(" ")).toBe(incomingAssertion);
	});

	it("uses the model current state instead of unioning superseded change narration", async () => {
		const existingContent = "The user's current budget is $1,000,000.";
		const historicalClause = "This replaces the earlier $1,000,000 budget.";
		const incomingAssertion = `The user's current budget is $1,100,000. ${historicalClause}`;
		const mergedContent = "The user's current budget is $1,100,000.";
		const existingId = await seed(existingContent, "preferences.budget");
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: mergedContent,
					superseded: [existingContent, historicalClause],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.budget",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-current-state-only" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		expect(currentContent("preferences.budget")).toBe(mergedContent);
	});

	it("accepts verbatim superseded clauses for durable entity current state", async () => {
		const replacedClause = "Project Atlas has a current limit of $1,000,000.";
		const retainedClause = "Project Atlas is led by Alice.";
		const historicalClause = "The earlier $875,000 figure was incorrect.";
		const existingContent = `${replacedClause} ${retainedClause}`;
		const incomingAssertion =
			`Project Atlas now has a current limit of $1,100,000. ${historicalClause}`;
		const mergedContent =
			"Project Atlas is led by Alice. Project Atlas now has a current limit of $1,100,000.";
		const existingId = await seed(existingContent);
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: mergedContent,
					superseded: [replacedClause, historicalClause],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-entity-replacement" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!current) throw new Error("expected current durable entity row");
		expect(parseInsightMetadata(current.metadata, current).l2_content).toBe(mergedContent);
		expect(
			await fixture?.store.list({
				projectId: SCOPE,
				category: "episodic",
				limit: 10,
			}),
		).toEqual([]);
	});

	it("preserves both assertions when a retired clause is not verbatim", async () => {
		const existingContent =
			"Project Atlas has a current limit of $1,000,000. Project Atlas is led by Alice.";
		const incomingAssertion = "Project Atlas now has a current limit of $1,100,000.";
		const mergedContent =
			"Project Atlas has a current limit of $1,100,000. Project Atlas is led by Alice.";
		const existingId = await seed(existingContent);
		const replacementLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: mergedContent,
					superseded: ["$1,000,000"],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-non-verbatim-supersession" },
			store: fixture?.store as MemoryStore,
			llm: replacementLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!current) throw new Error("expected protected durable entity row");
		expect(current.id).not.toBe(existingId);
		const metadata = parseInsightMetadata(current.metadata, current);
		expect(metadata.l2_content).toContain("Project Atlas has a current limit of $1,000,000.");
		expect(metadata.l2_content).toContain("Project Atlas is led by Alice.");
		expect(metadata.l2_content).toContain(incomingAssertion);
		expect(metadata.merged_without_adjudication).toBe(true);
		expect(metadata.adjudication_failure_reason).toBe("malformed-judgment");
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toEqual([]);
	});

	it("removes only the exact preference clause superseded by a negation", async () => {
		const removedClause = "The user avoids coffee after 2pm.";
		const retainedClause = "The user prefers coffee shops for meetings.";
		const existingContent = `${removedClause} ${retainedClause}`;
		const incomingAssertion = "The user does not like coffee anymore.";
		const existingId = await seed(existingContent, "preferences.coffee");
		const negationLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: `${retainedClause} ${incomingAssertion}`,
					superseded: [removedClause],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.coffee",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-preference-negation" },
			store: fixture?.store as MemoryStore,
			llm: negationLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		expect(currentContent("preferences.coffee")).toBe(
			`${retainedClause} ${incomingAssertion}`,
		);
	});

	it("accepts a negation that leaves no current preference", async () => {
		const existingContent = "The user likes coffee.";
		const incomingAssertion = "The user does not like coffee anymore.";
		const existingId = await seed(existingContent, "preferences.coffee");
		const negationLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: incomingAssertion,
					superseded: [existingContent],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: "preferences.coffee",
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-preference-negation-empty" },
			store: fixture?.store as MemoryStore,
			llm: negationLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(result.rowId).not.toBe(existingId);
		expect(currentContent("preferences.coffee")).toBe(incomingAssertion);
	});

	it("keeps every whole clause when an equivalent numeric rewording changes them", async () => {
		const existingContent = "Project Atlas reserves 1.50 TB in Austin.";
		const incomingAssertion = "Alice set the Project Atlas cache to 1.0 GB in Austin.";
		const mergedContent =
			"Project Atlas reserves 1.5 TB in Austin; Alice set its cache to 1 GB.";
		await seed(existingContent);
		const rewordingLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "merge",
					content: mergedContent,
					superseded: [],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-number-rewording" },
			store: fixture?.store as MemoryStore,
			llm: rewordingLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		expect(currentContent()).toBe(`${existingContent}\n${incomingAssertion}`);
	});

	it("preserves and marks an unrecognized judgment action", async () => {
		const existingContent = "Project Atlas is led by Alice in Austin.";
		const incomingAssertion = "Project Atlas opened a Boston office.";
		const existingId = await seed(existingContent);
		const malformedLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return {
					action: "replace",
					content: "Project Atlas moved to Boston.",
					superseded: [],
				} as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-malformed-action" },
			store: fixture?.store as MemoryStore,
			llm: malformedLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!current) throw new Error("expected preserved profile row");
		expect(current.id).not.toBe(existingId);
		const metadata = parseInsightMetadata(current.metadata, current);
		expect(metadata.l2_content).toContain(existingContent);
		expect(metadata.l2_content).toContain(incomingAssertion);
		expect(metadata.merged_without_adjudication).toBe(true);
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toHaveLength(0);
	});

	it("preserves and marks when the judgment transport is unavailable", async () => {
		// `completeJson` resolves to null rather than throwing whenever the
		// transport is unavailable, which is how every Memora eval run reaches
		// this code: the profile-merge occasion routes to the host-agent seam
		// and the eval server has no host.
		const section = "preferences.books";
		const existingContent = "The user dislikes books about social dynamics.";
		const incomingAssertion = "The user is drawn to tragedy.";
		const existingId = await seed(existingContent, section);

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: section,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-dead-transport" },
			store: fixture?.store as MemoryStore,
			llm: createTestLlmClient(),
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${section}`);
		if (!current) throw new Error("expected preserved profile row");
		expect(current.id).not.toBe(existingId);
		const metadata = parseInsightMetadata(current.metadata, current);
		expect(metadata.l2_content).toContain(existingContent);
		expect(metadata.l2_content).toContain(incomingAssertion);
		expect(metadata.merged_without_adjudication).toBe(true);
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toHaveLength(0);
	});

	it("preserves and marks when no-op would discard an assertion", async () => {
		const section = "preferences.books";
		const existingContent = "The user dislikes books about social dynamics.";
		const incomingAssertion = "The user is drawn to tragedy.";
		const existingId = await seed(existingContent, section);
		const noOpLlm = createTestLlmClient({
			async completeJson<T>(): Promise<T> {
				return { action: "no-op", content: existingContent, superseded: [] } as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: section,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-rejected-no-op" },
			store: fixture?.store as MemoryStore,
			llm: noOpLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("merged");
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${section}`);
		if (!current) throw new Error("expected preserved profile row");
		expect(current.id).not.toBe(existingId);
		const metadata = parseInsightMetadata(current.metadata, current);
		expect(metadata.l2_content).toContain(existingContent);
		expect(metadata.l2_content).toContain(incomingAssertion);
		expect(metadata.merged_without_adjudication).toBe(true);
		const episodic = await fixture?.store.list({
			projectId: SCOPE,
			category: "episodic",
			limit: 10,
		});
		expect(episodic).toHaveLength(0);
	});

	it("honours a no-op when the section already states the assertion", async () => {
		const section = "preferences.books";
		const existingContent = "The user is drawn to tragedy.\nThe user reads nightly.";
		const incomingAssertion = "The user is drawn to tragedy.";
		await seed(existingContent, section);
		const before = fixture?.store.getByFactKey(SCOPE, `profile:${section}`);
		if (!before) throw new Error("expected seeded profile row");
		const calls: string[] = [];
		const noOpLlm = createTestLlmClient({
			async completeJson<T>(
				request: Parameters<LlmClient["completeJson"]>[0],
			): Promise<T> {
				calls.push(request.callLabel);
				return { action: "no-op", content: existingContent, superseded: [] } as T;
			},
		});

		const result = await runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: section,
			newAssertion: incomingAssertion,
			source: { messageId: "merge-preservation-honoured-no-op" },
			store: fixture?.store as MemoryStore,
			llm: noOpLlm,
			at: STARTED_AT + 1_000,
		});

		expect(result.outcome).toBe("no-op");
		const current = fixture?.store.getByFactKey(SCOPE, `profile:${section}`);
		expect(calls).toEqual(["profile-section-judgment"]);
		expect(current?.text).toBe(before.text);
		expect(current).toEqual(before);
	});

	it.skipIf(process.env.PROFILE_MERGE_REAL_SAMPLE !== "1")(
		"reports the bounded real-route merge sample without supplying replies",
		async () => {
			const realLlm = createLlmClient({
				preset: "mem_claw/sno_ai_extract",
				timeoutMs: 60_000,
			});
			const sampleStart = Number.parseInt(
				process.env.PROFILE_MERGE_REAL_SAMPLE_START ?? "0",
				10,
			);
			const selectedSamples = REAL_MERGE_SAMPLE.slice(sampleStart, sampleStart + 4);
			if (selectedSamples.length === 0) {
				throw new Error(`real merge sample start ${sampleStart} selected no cases`);
			}
			const startedAt = Date.now();
			const observations: Array<Record<string, unknown>> = [];
			for (const [offset, sample] of selectedSamples.entries()) {
				const index = sampleStart + offset;
				const testDb = createTestDb();
				const store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
				try {
					const seedResult = await runProfileSectionUpdate({
						scope: `${SCOPE}-real-${index}`,
						sectionName: sample.section,
						newAssertion: sample.existing,
						source: { messageId: `real-merge-seed-${index}` },
						store,
						at: STARTED_AT,
					});
					let rawReply: Record<string, unknown> | null = null;
					const recordingLlm = {
						...realLlm,
						async completeJson<T>(
							request: Parameters<typeof realLlm.completeJson>[0],
						): Promise<T | null> {
							const response = await realLlm.completeJson<T>(request);
							if (response && typeof response === "object" && !Array.isArray(response)) {
								rawReply = response as Record<string, unknown>;
							}
							return response;
						},
					};
					const result = await runProfileSectionUpdate({
						scope: `${SCOPE}-real-${index}`,
						sectionName: sample.section,
						newAssertion: sample.incoming,
						source: { messageId: `real-merge-update-${index}` },
						store,
						llm: recordingLlm,
						at: STARTED_AT + 1_000,
						timeoutMs: 60_000,
					});
					const current = store.getByFactKey(
						`${SCOPE}-real-${index}`,
						`profile:${sample.section}`,
					);
					const episodic = await store.list({
						projectId: `${SCOPE}-real-${index}`,
						category: "episodic",
						limit: 10,
					});
					const replyPreservesInputs = replyPreservesRequiredTerms(
						rawReply,
						sample.requiredTerms,
					);
					expect(replyPreservesInputs).not.toBeUndefined();
					if (replyPreservesInputs) {
						expect(result.outcome).toBe("merged");
						expect(current?.id).toBe(result.rowId);
						expect(
							replyPreservesRequiredTerms(
								{ action: "merge", content: current?.text },
								sample.requiredTerms,
							),
						).toBe(true);
						expect(episodic).toHaveLength(0);
					} else {
						expect(result.outcome).toBe("appended");
						expect(current).toMatchObject({
							id: seedResult.rowId,
							text: sample.existing,
						});
						expect(episodic).toHaveLength(1);
						expect(episodic[0]).toMatchObject({
							id: result.rowId,
							text: sample.incoming,
						});
					}
					const observation = {
						index: index + 1,
						existing: sample.existing,
						incoming: sample.incoming,
						expectedDisposition:
							replyPreservesInputs ? "merged" : "episodic_fallback",
						rawReply,
						result,
						seedRowId: seedResult.rowId,
						currentContent: current?.text ?? null,
						episodic: episodic.map((row) => ({ id: row.id, text: row.text })),
					};
					observations.push(observation);
					const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
					const throughput = observations.length / elapsedSeconds;
					const etaSeconds = (selectedSamples.length - observations.length) / throughput;
					process.stdout.write(
						`PROFILE_MERGE_OBSERVATION ${observations.length}/${selectedSamples.length} throughput=${throughput.toFixed(2)}/s eta=${etaSeconds.toFixed(1)}s ${JSON.stringify(observation)}\n`,
					);
				} finally {
					store.close();
					testDb.cleanup();
				}
			}
			const mergeReplyCount = observations.filter(
				(observation) =>
					(observation.rawReply as Record<string, unknown> | null)?.action === "merge",
			).length;
			const lossCatchCount = observations.filter(
				(observation) => observation.expectedDisposition === "episodic_fallback",
			).length;
			const acceptedLosslessCount = observations.filter(
				(observation) => observation.expectedDisposition === "merged",
			).length;
			process.stdout.write(
				`PROFILE_MERGE_SAMPLE_SUMMARY ${JSON.stringify({
					sampleStart: sampleStart + 1,
					sampleSize: observations.length,
					rawObservationCount: observations.length,
					mergeReplyCount,
					episodicFallbackCount: lossCatchCount,
					lossCatchCount,
					acceptedLosslessCount,
				})}\n`,
			);
			expect(observations).toHaveLength(selectedSamples.length);
			expect(observations.every((observation) => observation.rawReply !== null)).toBe(true);
			expect(mergeReplyCount).toBe(observations.length);
			expect(acceptedLosslessCount + lossCatchCount).toBe(observations.length);
		},
	);
});
