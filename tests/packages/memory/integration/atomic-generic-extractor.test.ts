/** @file atomic-generic-extractor.test.ts
 * @purpose Proves the generic atomic extractor contract without calling a real model.
 * @boundary Frozen reply schema, transcript windows, parser recovery, runner, and SQLite ledger.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA,
	type AtomicExtractionTurn,
	parseAtomicExtractionReply,
} from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import {
	buildAtomicExtractionWindows,
	buildAtomicGenericExtractionPrompt,
	createAtomicGenericExtractionTransport,
	type AtomicGenericExtractionCompletion,
	type AtomicGenericExtractionInput,
	type AtomicGenericExtractionRequest,
	type AtomicGenericExtractionTransport,
	runAtomicGenericExtractionPass,
} from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import {
	ATOMIC_DATA_INSTRUCTION,
	numberAtomicTurns,
} from "../../../../packages/memory/src/engine/extraction/atomic-replacement-sanitizer";
import type {
	LlmClient,
	MemoryLlmRequest,
	ResolvedLlmConfig,
	TokenUsage,
} from "../../../../packages/memory/src/model/llm-client-types";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const ATTRIBUTE_DICTIONARY_PATH = fileURLToPath(
	new URL("../../../../packages/memory/config/attribute-dictionary.json", import.meta.url),
);
const RELATION_DICTIONARY_PATH = fileURLToPath(
	new URL("../../../../packages/memory/config/relation-dictionary.json", import.meta.url),
);
const RESPONSE_SCHEMA_PATH = fileURLToPath(
	new URL("../../../../packages/memory/config/atomic-extraction-response.schema.json", import.meta.url),
);
const RESPONSE_SCHEMA_HASH_PATH = `${RESPONSE_SCHEMA_PATH}.sha256`;
const ATTRIBUTE_DICTIONARY_HASH_PATH = `${ATTRIBUTE_DICTIONARY_PATH}.sha256`;
const STATE_VOCABULARY_PATH = fileURLToPath(
	new URL("../../../../packages/memory/config/state-vocabulary.json", import.meta.url),
);

const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const TURNS: AtomicExtractionTurn[] = [
	{ role: "system", content: "System line one.\nSystem line two." },
	{ role: "user", content: "I prefer tea.\nKeep this second user line." },
	{ role: "assistant", content: "Noted.\nNothing removed." },
];

interface AttributeDictionary {
	slug_count: number;
	slugs: Array<{ slug: string }>;
}

interface AtomicResponseSchema {
	properties: {
		records: {
			items: {
				required: string[];
				properties: {
					kind: { enum: string[] };
					attribute: { anyOf: Array<{ enum?: string[]; type?: string }> };
					ended_at_phrase: { anyOf: Array<{ type?: string; minLength?: number }> };
					temporal_phrase: { anyOf: Array<{ type?: string; minLength?: number }> };
					[key: string]: unknown;
				};
			};
		};
	};
}

interface LedgerRow {
	state: string;
	reprocess_reason: string | null;
	failed_reply: string | null;
	raw_chunk: string;
	run_parameters_json: string;
}

function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "standing",
		claim_text: "The user prefers tea.",
		subject: "user",
		subject_kind: "user",
		attribute: "preference.food",
		value: "tea",
		temporal_phrase: null,
		time: { kind: "none" }, ended_time: { kind: "none" },
		ends_current: false,
		ended_at_phrase: null,
		importance: "medium",
		changes_current_state: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 1, quote: "I prefer tea." },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

function envelope(records: Array<Record<string, unknown>> = [wireRecord()]): string {
	return JSON.stringify({ records });
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: "atomic-v1",
	};
}

type TransportCallKind = "extraction" | "numeric-sweep" | "unknown";

/**
 * What each prompt the pass sent actually was, recognised from the prompt text, in order. A call
 * the pass was not expected to make — a new stage, a second sweep — shows up here as a kind or a
 * count the case did not script, and the case fails on it instead of on a vague "exhausted".
 */
function transportCallKind(prompt: string): TransportCallKind {
	if (prompt.includes("\nturn_indexes_to_account_for: ")) return "numeric-sweep";
	if (prompt.includes("\nresponse_schema: ") && prompt.includes("\ntranscript:\n")) {
		return "extraction";
	}
	return "unknown";
}

class ScriptedTransport implements AtomicGenericExtractionTransport {
	readonly requests: AtomicGenericExtractionRequest[] = [];

	constructor(private readonly completions: AtomicGenericExtractionCompletion[]) {}

	callKinds(): TransportCallKind[] {
		return this.requests.map(({ prompt }) => transportCallKind(prompt));
	}

	async complete(
		request: AtomicGenericExtractionRequest,
	): Promise<AtomicGenericExtractionCompletion> {
		this.requests.push(request);
		const completion = this.completions.shift();
		if (!completion) throw new Error("scripted transport exhausted");
		try {
			const payload = JSON.parse(completion.text);
			const turns = JSON.parse(request.prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{role: string; turn_index: number}>;
			if (payload && !Array.isArray(payload) && Array.isArray(payload.records)) {
				return { ...completion, text: JSON.stringify({ ...payload, decisions: turns.filter((turn) => turn.role === "user").map((turn) => ({ turn_index: turn.turn_index, progress_only: false })) }) };
			}
		} catch { /* Malformed replies stay malformed for the parser tests. */ }
		return completion;
	}
}

class RecordingLlmClient implements LlmClient {
	request: MemoryLlmRequest | undefined;

	constructor(
		private readonly reply: string,
		private readonly usage: TokenUsage,
	) {}

	async completeJson<T>(_request: MemoryLlmRequest): Promise<T | null> {
		throw new Error("completeJson must not be used by the atomic generic transport");
	}

	async completeText(request: MemoryLlmRequest): Promise<string> {
		this.request = request;
		return this.reply;
	}

	async getResolvedConfig(): Promise<ResolvedLlmConfig> {
		throw new Error("getResolvedConfig must not be used by the atomic generic transport");
	}

	getLastError(): null {
		return null;
	}

	getLastUsage(): TokenUsage {
		return this.usage;
	}
}

function completion(text: string, truncated = false): AtomicGenericExtractionCompletion {
	return { text, truncated };
}

/**
 * The two-lane reply sequence that reproduces a single `{records:[...]}` reply of the old
 * single-call era: a capture reply carrying the lane-1 fields keyed by id, then one enrichment
 * reply carrying the lane-2 fields for the same ids. Split by code exactly as the shipped flow
 * expects, so the projected records — and every downstream assertion on them — are unchanged.
 * Decisions cover TURNS' one user turn (index 1). Assumes the facts fit one enrichment batch.
 */
function captureReplyFor(records: Array<Record<string, unknown>>): string {
	return JSON.stringify({
		claims_found: records.map((record) => record.claim_text),
		decisions: [{ turn_index: 1, progress_only: false }],
		facts: records.map((record, id) => ({
			id,
			fact: record.claim_text,
			subject: record.subject,
			subject_kind: record.subject_kind,
			temporal_phrase: record.temporal_phrase ?? null,
			ended_at_phrase: record.ended_at_phrase ?? null,
			source_span: record.source_span,
		})),
	});
}

function enrichmentReplyFor(records: Array<Record<string, unknown>>): string {
	return JSON.stringify({
		enrichments: records.map((record, id) => ({
			id,
			kind: record.kind,
			attribute: record.attribute,
			value: record.value,
			ends_current: record.ends_current,
			importance: record.importance,
			changes_current_state: record.changes_current_state,
			todo: record.todo,
			close_reason: record.close_reason,
			single_claim: record.single_claim,
			relations: record.relations,
			time: record.time,
			ended_time: record.ended_time,
		})),
	});
}

function twoLaneCompletions(
	records: Array<Record<string, unknown>>,
): AtomicGenericExtractionCompletion[] {
	return [completion(captureReplyFor(records)), completion(enrichmentReplyFor(records))];
}

function readLedger(fixture: TestDb, key: AtomicExtractionLedgerKey): LedgerRow {
	const row = fixture.runtime.db
		.prepare(`
			SELECT state, reprocess_reason, failed_reply, raw_chunk, run_parameters_json
			FROM nodix_atomic_extraction_ledger
			WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
		`)
		.get(key.conversationId, key.chunkHash, key.pipelineVersion) as LedgerRow | undefined;
	if (!row) throw new Error(`missing ledger row for ${key.chunkHash}`);
	return row;
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
	const originalWrite = process.stderr.write;
	let output = "";
	process.stderr.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return Reflect.apply(originalWrite, process.stderr, [chunk, ...args]) as boolean;
	}) as typeof process.stderr.write;
	try {
		return { result: await run(), output };
	} finally {
		process.stderr.write = originalWrite;
	}
}

function expectRejectionPreviews(output: string, expectedCount: number): void {
	const lines = output
		.split("\n")
		.filter(
			(line) =>
				line.includes("atomic extraction reply rejected") ||
				line.includes("atomic extraction reply reached record cap"),
		);
	expect(lines).toHaveLength(expectedCount);
	// The preview is a size only: reply text never reaches the log.
	for (const line of lines) {
		expect(line).toMatch(/"chars":\s*\d+/u);
		expect(line).not.toContain('"head":');
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic generic extractor", () => {
	let fixture: TestDb;
	let store: MemoryStore;
	let now: number;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		now = 0;
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	function input(
		key: AtomicExtractionLedgerKey,
		transport: AtomicGenericExtractionTransport,
		overrides: Partial<AtomicGenericExtractionInput> = {},
	): AtomicGenericExtractionInput {
		return {
			store,
			ledgerKey: key,
			turns: TURNS,
			rawChunk: JSON.stringify(TURNS),
			routingSnapshotId: "routing-snapshot-v1",
			runParameters: RUN_PARAMETERS,
			sessionDateTime: "2026-09-02T12:00:00-07:00",
			estimatedInputTokens: 100,
			nowMs: () => {
				now += 1;
				return now;
			},
			transport,
			...overrides,
		};
	}

	it("freezes the two kinds, the dictionary-plus-vocabulary enum, model time instructions, and code-owned fields", () => {
		// The bytes on disk, not the imported object: a runtime copy could be patched to agree with
		// the dictionaries while the file the prompt is built from stays stale.
		const schemaBytes = readFileSync(RESPONSE_SCHEMA_PATH);
		const dictionaryBytes = readFileSync(ATTRIBUTE_DICTIONARY_PATH);
		for (const [bytes, hashPath, filename] of [
			[schemaBytes, RESPONSE_SCHEMA_HASH_PATH, "atomic-extraction-response.schema.json"],
			[dictionaryBytes, ATTRIBUTE_DICTIONARY_HASH_PATH, "attribute-dictionary.json"],
		] as const) {
			const [expectedHash, hashedFilename] = readFileSync(hashPath, "utf8").trim().split(/\s+/u);
			expect(hashedFilename).toBe(filename);
			expect(createHash("sha256").update(bytes).digest("hex"), filename).toBe(expectedHash);
		}

		const schema = JSON.parse(schemaBytes.toString("utf8")) as AtomicResponseSchema;
		expect(ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA).toEqual(schema);
		const record = schema.properties.records.items;
		const attributeDictionary = JSON.parse(dictionaryBytes.toString("utf8")) as AttributeDictionary;
		const stateVocabulary = JSON.parse(
			readFileSync(STATE_VOCABULARY_PATH, "utf8"),
		) as AttributeDictionary;
		const personSlugs = attributeDictionary.slugs.map(({ slug }) => slug);
		const thingSlugs = stateVocabulary.slugs.map(({ slug }) => slug);
		expect(attributeDictionary.slug_count).toBe(personSlugs.length);
		expect(stateVocabulary.slug_count).toBe(thingSlugs.length);
		expect(record.properties.kind.enum).toEqual(["occurrence", "standing"]);
		// Person slugs then thing slugs, each in its own file's order: one enum, hand-maintained,
		// and this is the only guard that says it fell behind a dictionary.
		expect(record.properties.attribute.anyOf[0]?.enum).toEqual([...personSlugs, ...thingSlugs]);
		expect(record.required).not.toContain("source");
		expect(record.required).not.toContain("maturity");
		expect(record.properties).not.toHaveProperty("source");
		expect(record.properties).not.toHaveProperty("maturity");

		// The model supplies semantic operations; code owns the resulting timestamps.
		expect(record.required).toContain("time");
		expect(record.required).toContain("ended_time");
		expect(record.properties).not.toHaveProperty("resolved_time");
		expect(record.properties).not.toHaveProperty("ended_at");
		expect(record.required).toContain("temporal_phrase");
		expect(record.required).toContain("ended_at_phrase");
		expect(record.properties.temporal_phrase.anyOf.map((option) => option.type)).toEqual([
			"string",
			"null",
		]);
		expect(record.properties.ended_at_phrase.anyOf.map((option) => option.type)).toEqual([
			"string",
			"null",
		]);
	});

	it("builds stride-one two-user windows and renders the complete prompt unchanged", () => {
		const turns: AtomicExtractionTurn[] = [
			{ role: "system", content: "System first line.\nSystem second line." },
			{ role: "user", content: "User one first line.\nUser one second line." },
			{ role: "assistant", content: "Assistant one.\nAssistant line two." },
			{ role: "system", content: "Mid-system message.\nDo not remove it." },
			{ role: "user", content: "User two.\nSecond line two." },
			{ role: "assistant", content: "Assistant two.\nSecond assistant line." },
			{ role: "user", content: "User three.\nFinal user line." },
			{ role: "assistant", content: "Assistant three.\nFinal assistant line." },
		];
		const windows = buildAtomicExtractionWindows(turns);
		expect(windows).toHaveLength(2);
		expect(
			windows.map((window) => window.filter(({ role }) => role === "user").map(({ content }) => content)),
		).toEqual([
			[turns[1]?.content, turns[4]?.content],
			[turns[4]?.content, turns[6]?.content],
		]);
		for (const turn of turns) {
			expect(windows.flat()).toContainEqual(turn);
		}

		const attributeDictionary = JSON.parse(
			readFileSync(ATTRIBUTE_DICTIONARY_PATH, "utf8"),
		) as AttributeDictionary;
		const relationDictionary = JSON.parse(readFileSync(RELATION_DICTIONARY_PATH, "utf8")) as {
			relations: unknown[];
		};
		const stateVocabulary = JSON.parse(
			readFileSync(STATE_VOCABULARY_PATH, "utf8"),
		) as AttributeDictionary;
		const prompt = buildAtomicGenericExtractionPrompt(turns, "2026-09-02T12:00:00-07:00");
		// Turns go in numbered: the model copies `turn_index` rather than counting.
		expect(prompt).toContain(
			[
				"transcript:",
				ATOMIC_DATA_INSTRUCTION,
				"<take>",
				JSON.stringify(numberAtomicTurns(turns)),
				"</take>",
			].join("\n"),
		);
		expect(prompt).toContain(
			`person_attribute_slugs: ${JSON.stringify(attributeDictionary.slugs.map(({ slug }) => slug))}`,
		);
		expect(prompt).toContain(
			`thing_attribute_slugs: ${JSON.stringify(stateVocabulary.slugs.map(({ slug }) => slug))}`,
		);
		expect(prompt).not.toContain("turn_indexes_to_account_for:");
		expect(prompt).toContain(`relation_dictionary: ${JSON.stringify(relationDictionary.relations)}`);
		const schema = JSON.parse(prompt.split("response_schema: ")[1]?.split("\n")[0] ?? "null");
		expect(schema.required).toContain("decisions");
		expect(schema.properties.records).toEqual((ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA as { properties: { records: unknown } }).properties.records);
		expect(schema.properties.decisions.items.required).toEqual(["turn_index", "progress_only"]);
		expect(prompt).not.toMatch(/temperature\s*[:=]\s*0(?:\.0+)?/iu);
	});

	it("maps the generic request to the fixed raw client contract and detects truncation", async () => {
		const client = new RecordingLlmClient("provider reply", {
			inputTokens: 64,
			outputTokens: 128,
			totalTokens: 192,
		});
		const transport = createAtomicGenericExtractionTransport(client);

		// E3 rather than E1: the transport must forward the caller's call id, not pin one.
		await expect(transport.complete({ callId: "E3", prompt: "exact prompt", maxTokens: 128 })).resolves.toEqual({
			text: "provider reply",
			truncated: true,
			// The transport now reports the batch's output-token usage, used by lane-2 budget diagnostics.
			outputTokens: 128,
		});
		expect(client.request).toEqual({
			prompt: "exact prompt",
			extractionSkillHash: createHash("sha256").update(readFileSync(new URL("../../../../packages/memory/skills/extract-atomic-memory/SKILL.md", import.meta.url))).update(readFileSync(new URL("../../../../packages/memory/skills/extract-atomic-memory/references/calendar-meaning.md", import.meta.url))).update(readFileSync(new URL("../../../../packages/memory/skills/extract-atomic-memory/references/capture.md", import.meta.url), "utf8").trim()).update(readFileSync(new URL("../../../../packages/memory/skills/extract-atomic-memory/references/enrichment.md", import.meta.url), "utf8").trim()).digest("hex"),
			callId: "E3",
			maxTokens: 128,
			// The capture call carries its own wall time. Inheriting the installation's generic
			// client timeout (30s by default, 60s on the LoCoMo VM) made a full-length reply
			// unfinishable once the output budget was raised: measured 2026-09-20, four sessions
			// timed out after 105-130s of work and stored nothing.
			timeoutMs: 300_000,
			emptyReplyAttempts: 1,
			enableThinking: false,
		});
		expect(client.request).not.toHaveProperty("temperature");
	});

	it("recovers the measured JSON shapes, takes the first valid payload, and refuses wrong bindings", () => {
		const standard = envelope();
		const accepted = [
			standard,
			JSON.stringify([wireRecord()]),
			`\`\`\`json\n${standard}\n\`\`\``,
			`Reasoning before payload.\n${standard}`,
			`Unclosed stray marker [not payload\n${standard}`,
		];
		for (const raw of accepted) {
			expect(parseAtomicExtractionReply(raw, TURNS.length)).toMatchObject({
				ok: true,
				records: [{ kind: "standing", claimText: "The user prefers tea." }],
			});
		}
		expect(parseAtomicExtractionReply(standard, TURNS.length)).toMatchObject({
			ok: true,
			malformedCandidateCount: 0,
		});
		// Two valid payloads: the first admitted candidate wins. The earlier rule refused the whole
		// reply as ambiguous and lost real memories whenever the model wrote its reasoning as a
		// second payload-shaped block (measured 2026-09-04 on the live Memora run).
		expect(parseAtomicExtractionReply(`${standard}\n${standard}`, TURNS.length)).toMatchObject({
			ok: true,
			records: [{ kind: "standing", claimText: "The user prefers tea." }],
			malformedCandidateCount: 0,
		});

		const wrongBindings = [
			{
				label: "string turn_index",
				record: wireRecord({ source_span: { turn_index: "1", quote: "I prefer tea." } }),
			},
			{
				label: "out-of-range turn_index",
				record: wireRecord({
					source_span: { turn_index: TURNS.length, quote: "I prefer tea." },
				}),
			},
		];
		for (const { label, record } of wrongBindings) {
			expect(parseAtomicExtractionReply(envelope([record]), TURNS.length), label).toMatchObject(
				{
					ok: false,
					reason: "no-schema-payload",
				},
			);
		}

		// A format slip is repaired, never refused: a refused reply cost every memory in the window a
		// retry and then the window. Fields the model has no business setting are dropped, a date the
		// model computed is ignored (the engine resolves the phrase), a fourth relation is cut, and an
		// ending time on a claim that does not end is nulled.
		const repaired = parseAtomicExtractionReply(
			envelope([
				wireRecord({
					source: "edge",
					maturity: "extracted",
					resolved_time: { year: 1999, month: 1, day: 1 },
					ended_at_phrase: "last spring",
					relations: [
						{ subject: "user", predicate: "MENTIONS", object: "a" },
						{ subject: "user", predicate: "MENTIONS", object: "b" },
						{ subject: "user", predicate: "MENTIONS", object: "c" },
						{ subject: "user", predicate: "MENTIONS", object: "d" },
					],
				}),
			]),
			TURNS.length,
		);
		expect(repaired.ok).toBe(true);
		if (repaired.ok) {
			const [only] = repaired.records;
			expect(only).not.toHaveProperty("source");
			expect(only).not.toHaveProperty("maturity");
			expect(only?.resolvedTime).toBeNull();
			expect(only?.endedAtPhrase).toBeNull();
			expect(only?.relations.map(({ object }) => object)).toEqual(["a", "b", "c"]);
		}
		const unknownSlug = parseAtomicExtractionReply(
			envelope([wireRecord({ attribute: "knowledge.technical" })]),
			TURNS.length,
		);
		expect(unknownSlug).toMatchObject({
			ok: true,
			records: [{ claimText: "The user prefers tea.", attribute: null }],
		});
	});

	it("runs once normally and persists input-overflow without extra calls", async () => {
		const successKey = ledgerKey("success");
		// Two-lane sequence: capture then one enrichment batch, reproducing the same single record.
		const successTransport = new ScriptedTransport(twoLaneCompletions([wireRecord()]));
		await expect(runAtomicGenericExtractionPass(input(successKey, successTransport))).resolves.toMatchObject(
			{
				status: "complete",
				records: [{ claimText: "The user prefers tea." }],
			},
		);
		expect(successTransport.callKinds()).toEqual(["extraction", "extraction"]);
		expect(successTransport.requests[0]?.maxTokens).toBe(2_000);
		expect(Object.keys(successTransport.requests[0] ?? {}).sort()).toEqual(["callId", "maxTokens", "prompt"]);
		expect(readLedger(fixture, successKey)).toMatchObject({ state: "calls_recorded" });

		const inputKey = ledgerKey("input-overflow");
		const inputTransport = new ScriptedTransport([]);
		await expect(
			runAtomicGenericExtractionPass(
				input(inputKey, inputTransport, { estimatedInputTokens: RUN_PARAMETERS.maxInputTokens + 1 }),
			),
		).resolves.toEqual({ status: "pending", reason: "input-overflow" });
		expect(inputTransport.callKinds()).toEqual([]);
		expect(readLedger(fixture, inputKey)).toMatchObject({
			state: "pending_reprocess",
			reprocess_reason: "input-overflow",
			failed_reply: null,
			raw_chunk: JSON.stringify(TURNS),
		});
	});

	it("skips a chunk that another capture of the same turn completed while this one waited for the model", async () => {
		// A worker that hit its lifetime cap abandoned a long capture and the next worker sent the same turn again; the
		// first run completed the chunk while the second waited for its model, and the second then failed with
		// "Cannot record calls from atomic extraction state 'complete'", so the turn was marked failed three times.
		const key = ledgerKey("completed-elsewhere");
		const scripted = new ScriptedTransport(twoLaneCompletions([wireRecord()]));
		const racing: AtomicGenericExtractionTransport = {
			async complete(request) {
				fixture.runtime.db.prepare(`
					UPDATE nodix_atomic_extraction_ledger SET state = 'complete'
					WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
				`).run(key.conversationId, key.chunkHash, key.pipelineVersion);
				return scripted.complete(request);
			},
		};
		await expect(runAtomicGenericExtractionPass(input(key, racing))).resolves.toMatchObject({ status: "skip" });
		expect(readLedger(fixture, key)).toMatchObject({ state: "complete" });
	});

	it("returns every valid record without a numeric record cap", async () => {
		const key = ledgerKey("no-record-cap");
		const records = Array.from({ length: 12 }, (_, index) =>
			wireRecord({
				claim_text: `The user prefers tea preparation ${index}.`,
				value: `tea-${index}`,
			}),
		);
		// Two-lane sequence: one capture reply with all 12 facts, then one enrichment batch (they fit
		// a single output-token budget), reproducing all 12 records with no numeric cap.
		const transport = new ScriptedTransport(twoLaneCompletions(records));

		await expect(
			runAtomicGenericExtractionPass(input(key, transport)),
		).resolves.toMatchObject({ status: "complete", records: records.map(() => ({})) });
		expect(transport.callKinds()).toEqual(["extraction", "extraction"]);
		expect(readLedger(fixture, key)).toMatchObject({ state: "calls_recorded" });
	});

	it("retries truncation and parse failures with logged head and tail before pending", async () => {
		const longInvalid = (label: string): string =>
			`HEAD-${label}-${"x".repeat(300)}-TAIL-${label}`;
		const truncationKey = ledgerKey("truncation");
		const secondTruncatedReply = longInvalid("truncation-second");
		const truncationTransport = new ScriptedTransport([
			completion(longInvalid("truncation-first"), true),
			completion(secondTruncatedReply, true),
		]);
		const truncationRun = await captureStderr(() =>
			runAtomicGenericExtractionPass(input(truncationKey, truncationTransport)),
		);
		expect(truncationRun.result).toEqual({
			status: "pending",
			reason: "truncation-exhaustion",
		});
		expect(truncationTransport.callKinds()).toEqual(["extraction", "extraction"]);
		expect(truncationTransport.requests.map(({ maxTokens }) => maxTokens)).toEqual([2_000, 4_000]);
		const truncationLedger = readLedger(fixture, truncationKey);
		expect(truncationLedger).toMatchObject({
			state: "pending_reprocess",
			reprocess_reason: "truncation-exhaustion",
			failed_reply: secondTruncatedReply,
		});
		expect(JSON.parse(truncationLedger.run_parameters_json)).toMatchObject({
			outputTokenBudget: 4_000,
		});
		expectRejectionPreviews(truncationRun.output, 2);

		const parseKey = ledgerKey("parse");
		const secondParseReply = longInvalid("parse-second");
		const parseTransport = new ScriptedTransport([
			completion(longInvalid("parse-first")),
			completion(secondParseReply),
		]);
		const parseRun = await captureStderr(() =>
			runAtomicGenericExtractionPass(input(parseKey, parseTransport)),
		);
		expect(parseRun.result).toEqual({ status: "pending", reason: "parse-exhaustion" });
		expect(parseTransport.callKinds()).toEqual(["extraction", "extraction"]);
		expect(parseTransport.requests.map(({ maxTokens }) => maxTokens)).toEqual([2_000, 2_000]);
		const parseLedger = readLedger(fixture, parseKey);
		expect(parseLedger).toMatchObject({
			state: "pending_reprocess",
			reprocess_reason: "parse-exhaustion",
			failed_reply: secondParseReply,
		});
		expect(JSON.parse(parseLedger.run_parameters_json)).toMatchObject({
			outputTokenBudget: 2_000,
		});
		expectRejectionPreviews(parseRun.output, 2);

		const outOfEnumKey = ledgerKey("out-of-enum");
		const outOfEnum = envelope([wireRecord({ kind: "lesson" })]);
		const outOfEnumTransport = new ScriptedTransport([
			completion(outOfEnum),
			completion(outOfEnum),
		]);
		const outOfEnumRun = await captureStderr(() =>
			runAtomicGenericExtractionPass(input(outOfEnumKey, outOfEnumTransport)),
		);
		expect(outOfEnumRun.result).toEqual({ status: "pending", reason: "parse-exhaustion" });
		expect(outOfEnumTransport.callKinds()).toEqual(["extraction", "extraction"]);
		expect(outOfEnumTransport.requests.map(({ maxTokens }) => maxTokens)).toEqual([2_000, 2_000]);
		expect(readLedger(fixture, outOfEnumKey)).toMatchObject({
			state: "pending_reprocess",
			reprocess_reason: "parse-exhaustion",
			failed_reply: JSON.stringify({ ...JSON.parse(outOfEnum), decisions: [{ turn_index: 1, progress_only: false }] }),
		});
		expectRejectionPreviews(outOfEnumRun.output, 2);
	});
});
