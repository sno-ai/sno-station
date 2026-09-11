import { Temporal } from "@js-temporal/polyfill";
import { calendarInstructionSchema, type CalendarInstruction } from "../../../../packages/sno-station-mem/src/engine/extraction/calendar-instruction";
import { readModelReplyJson } from "../../../../packages/sno-station-mem/src/engine/shared/model-reply-text";
import { resolveLlmEndpoint } from "../../../../packages/sno-station-mem/src/model/llm-endpoint-resolution";
/** Real LlmClient routing; the AgentLlmPort seam injects malformed external replies only. */
import { describe, expect, it } from "vitest";
import { hostname } from "node:os";
import { resolveMemoryDate, unresolvedMemoryDate } from "../../../../packages/sno-station-mem/src/engine/extraction/date-resolution";
import type { Locale } from "../../../../packages/sno-station-mem/src/engine/i18n/locales";
import type { AgentLlmCompletion, AgentLlmPort, AgentLlmRequest } from "../../../../packages/sno-station-mem/src/model/agent-llm-port";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client";
import type { LlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client-types";
import type { LlmRoutingConfig } from "../../../../packages/sno-station-mem/src/model/llm-mode-routing";
/** Observe the actual transport reply without supplying or changing any model output. */
function observeTimeInstructions(llm: LlmClient, instructions: CalendarInstruction[]): LlmClient {
	return { ...llm, async completeText(request) {
		const raw = await llm.completeText(request);
		if (raw) {
			const time = readModelReplyJson(raw, (value) => {
				if (typeof value !== "object" || value === null || !("time" in value)) return undefined;
				const parsed = calendarInstructionSchema.safeParse(value.time);
				return parsed.success ? parsed.data : undefined;
			});
			if (time) instructions.push(time);
		}
		return raw;
	} };
}

const SESSION_DATE_TIME = "2026-06-05T21:00:00-07:00";
const SESSION_TIMEZONE = "America/Los_Angeles";
function routing(locale: Locale = "en", mode: LlmRoutingConfig["mode"] = "rem-enhanced") {
	return {
		mode,
		remEnhanced: {
			occasions: {
				memoryExtract: "snoRemMem",
				dedupDecision: "agent",
				profileSectionMerge: "agent",
				profileActiveTaskClassify: "agent",
				profileActiveTaskMatch: "agent",
				conflictAdjudication: "snoRemMem",
				summaryBuild: "agent",
				intentClassifier: "agent",
				dateResolution: "agent",
			},
		},
		agentNative: { flavor: "subscription" },
		language: locale,
	} satisfies LlmRoutingConfig;
}

class RecordingAgentPort implements AgentLlmPort {
	readonly requests: AgentLlmRequest[] = [];

	constructor(
		private readonly respond: (
			request: AgentLlmRequest,
			attempt: number,
		) => AgentLlmCompletion | Promise<AgentLlmCompletion>,
	) {}

	async complete(request: AgentLlmRequest): Promise<AgentLlmCompletion> {
		this.requests.push(request);
		return this.respond(request, this.requests.length);
	}
}

function client(port: AgentLlmPort, locale: Locale = "en"): LlmClient {
	return createLlmClient({
		preset: "mem_claw/sno_ai_extract",
		routing: routing(locale),
		agentPort: port,
	});
}

async function resolveExpression(
	expression: string,
	port: AgentLlmPort,
	locale: Locale = "en",
) {
	return resolveMemoryDate({
		text: `The event happened on ${expression}.`,
		expression,
		sessionDateTime: SESSION_DATE_TIME,
		sessionTimezone: SESSION_TIMEZONE,
		locale,
		llm: client(port, locale),
		routing: routing(locale),
	});
}

describe("date-resolution semantic contract", () => {
	it.each(["yesterday", "in four years", "2026-06-05", "The user likes quiet rooms"])("makes no semantic judgment without a model: %s", async (text) => {
		const input = { text, sessionDateTime: SESSION_DATE_TIME, sessionTimezone: SESSION_TIMEZONE };
		expect(await resolveMemoryDate(input)).toEqual(unresolvedMemoryDate(input));
		expect((await resolveMemoryDate(input)).interval).toEqual({ type: "unresolved", resolutionStatus: "unresolved", phrase: text });
	});

	it("keeps local-first unresolved even for recognizable time words", async () => {
		const port = new RecordingAgentPort(() => { throw new Error("Forbidden model call"); });
		const result = await resolveMemoryDate({ text: "yesterday", llm: client(port), routing: routing("en", "local-first") });
		expect(result).toMatchObject({ interval: { resolutionStatus: "unresolved" }, stage: { modelCalled: false } });
	});

	it.each([
		{ reason: "extra field", time: { kind: "none" }, date: "2026-06-05" },
		{ reason: "bad numeric type", time: { kind: "relative", amount: "-4", unit: "year", precision: "year" } },
		{ reason: "incomplete", time: { kind: "weekday", weekday: 2 } },
	])("fails loudly for malformed model instructions %j", async (reply) => {
		const port = new RecordingAgentPort(() => ({ kind: "ok", text: JSON.stringify(reply) }));
		await expect(resolveExpression("yesterday", port)).rejects.toThrow("valid calendar instruction");
	});

	it("does not salvage a date from keywords after a transport failure", async () => {
		const port = new RecordingAgentPort(() => ({ kind: "error", category: "transport", message: "HTTP 502" }));
		await expect(resolveExpression("yesterday at 3", port)).rejects.toThrow();
	});

	it("calculates a real model decision from the whole sentence", async () => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
		const timeInstructions: CalendarInstruction[] = [];
	const llm = observeTimeInstructions(createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 }), timeInstructions);
		const config = await llm.getResolvedConfig();
		const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "dateResolution", transport: "chat-completions" });
		const result = await resolveMemoryDate({ text: "I've known these friends for 4 years, since I moved from my home country.", expression: "for 4 years", sessionDateTime: "2023-06-09T19:55:00Z", sessionTimezone: "UTC", llm });
		process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url, result, timeInstructions }) + "\n");
		expect(result.stage.modelCalled).toBe(true);
		expect(result.timestamp).toBe(Date.parse("2023-06-09T19:55:00Z"));
		expect(result.interval).toMatchObject({ type: "bounded", date: "2019", precision: "year", from: Date.UTC(2019, 0, 1), until: Date.UTC(2020, 0, 1) });
		expect(timeInstructions).toEqual([expect.objectContaining({ kind: "relative", amount: -4, unit: "year", precision: "year" })]);
	}, 120_000);
});

it("updates an old event date without rewriting the memory's statement timestamp", async () => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const { dirname } = await import("node:path");
	const { createTestDb, createTestEmbedder } = await import("../../../apps/mem-claw/helpers/test-db");
	const { MemoryStore } = await import("../../../../packages/sno-station-mem/src/store/store");
	const { createRetriever } = await import("../../../../packages/sno-station-mem/src/engine/retrieval/retriever");
	const { createScopePolicy } = await import("../../../../packages/sno-station-mem/src/engine/security/scopes");
	const { executeMemoryUpdateTool } = await import("../../../../packages/sno-station-mem/src/engine/bindings/memory-update-tool");
	const fixture = createTestDb();
	const embedder = await createTestEmbedder();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		const statementTimestamp = Date.parse("2023-06-09T19:55:00Z");
		const row = await store.store({ text: "The user moved to Kyoto.", category: "episodic", projectId: "global", timestamp: statementTimestamp, timezone: "UTC", metadata: JSON.stringify({ kind: "episodic", memory_category: "episodic" }) });
		// Existing pre-cutover rows remain the text-update caller; new atomic rows are immutable.
		fixture.sqlite.prepare("UPDATE nodix_memories SET extractor_version = NULL WHERE id = ?").run(row.id);
		const timeInstructions: CalendarInstruction[] = [];
	const llm = observeTimeInstructions(createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 }), timeInstructions);
		const ctx = { store, embedder, retriever: createRetriever(store, embedder), scopePolicy: createScopePolicy({ default: "global", agentAccess: { "date-test": ["global"] } }), stateDir: dirname(fixture.dbPath), sessionTimestamp: Date.parse("2026-09-11T00:00:00Z"), sessionTimezone: "UTC", profileToolLlm: llm };
		const result = await executeMemoryUpdateTool(ctx, { agentId: "date-test" }, "calendar-update", { id: row.id, text: "The user moved to Kyoto on March 15, 2020." });
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		const stored = store.getById(row.id);
		expect(stored?.timestamp).toBe(statementTimestamp);
		expect(JSON.parse(stored?.metadata ?? "{}")).toMatchObject({ temporal_date: "2020-03-15", temporal_precision: "day", valid_from: Date.UTC(2020, 2, 15) });
		const uncertain = await executeMemoryUpdateTool(ctx, { agentId: "date-test" }, "calendar-update-unresolved", { id: row.id, text: "The user moved to Kyoto, but the date of that move is unknown." });
		expect(uncertain.isError, JSON.stringify(uncertain)).not.toBe(true);
		const updated = store.getById(row.id);
		expect(updated?.timestamp).toBe(statementTimestamp);
		const metadata = JSON.parse(updated?.metadata ?? "{}");
		expect(metadata.temporal_resolution_status).toBe("unresolved");
		for (const field of ["event_at", "temporal_date", "temporal_precision", "valid_from", "valid_until"]) expect(metadata).not.toHaveProperty(field);
		expect(fixture.sqlite.prepare("SELECT valid_from, valid_until FROM nodix_memories WHERE id = ?").get(row.id)).toEqual({ valid_from: null, valid_until: null });

	} finally { await store.close(); fixture.cleanup(); }
}, 120_000);


it("gets a real unresolved judgment for an undated claim without inventing an event interval", async () => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const timeInstructions: CalendarInstruction[] = [];
	const llm = observeTimeInstructions(createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 }), timeInstructions);
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "dateResolution", transport: "chat-completions" });
	const text = "I moved from my home country, but I have not said when.";
	for (let repeat = 0; repeat < 3; repeat += 1) {
		const result = await resolveMemoryDate({ text, sessionDateTime: "2023-06-09T19:55:00Z", sessionTimezone: "UTC", llm });
		process.stdout.write(JSON.stringify({ host: hostname(), model: endpoint.preset.model, endpoint: endpoint.url, name: "undated claim time judgment", repeat, result }) + "\n");
		expect(result.stage.modelCalled).toBe(true);
		expect(result.stage.reason.trim().length).toBeGreaterThan(0);
		expect(result.interval).toEqual({ type: "unresolved", resolutionStatus: "unresolved", phrase: text });
		expect(result.timestamp).toBe(Date.parse("2023-06-09T19:55:00Z"));
	}
}, 300_000);


it.each([
	["de", "Ich bin vor vier Jahren nach Kyoto gezogen."],
	["es", "Me mudé a Kioto hace cuatro años."],
	["fr", "J’ai déménagé à Kyoto il y a quatre ans."],
	["ja", "私は4年前に京都へ引っ越しました。"],
	["ko", "저는 4년 전에 교토로 이사했습니다."],
	["ru", "Я переехал в Киото четыре года назад."],
	["zh-Hant", "我四年前搬到了京都。"],
] as const)("interprets %s time through the real model, without locale keyword tables", async (locale, text) => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const timeInstructions: CalendarInstruction[] = [];
	const llm = observeTimeInstructions(createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 }), timeInstructions);
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "dateResolution", transport: "chat-completions" });
	const result = await resolveMemoryDate({ text, locale, sessionDateTime: "2023-06-09T19:55:00Z", sessionTimezone: "UTC", llm });
	process.stdout.write(JSON.stringify({ host: hostname(), model: endpoint.preset.model, endpoint: endpoint.url, locale, text, result, timeInstructions }) + "\n");
	expect(result.stage.modelCalled).toBe(true);
	expect(result.interval).toMatchObject({ type: "bounded", resolutionStatus: "resolved", date: "2019", precision: "year", from: Date.UTC(2019, 0, 1), until: Date.UTC(2020, 0, 1) });
	expect(timeInstructions).toEqual([expect.objectContaining({ kind: "relative", amount: -4, unit: "year", precision: "year" })]);
}, 120_000);


it("protects an undated row written by the same session from retirement", async () => {
	const { createTestDb, createTestEmbedder } = await import("../../../apps/mem-claw/helpers/test-db");
	const { MemoryStore } = await import("../../../../packages/sno-station-mem/src/store/store");
	const { retireRowsByName } = await import("../../../../packages/sno-station-mem/src/engine/extraction/retire-by-name");
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	try {
		const eventTime = Date.parse("2023-06-09T19:55:00Z");
		const text = "The user moved from their home country.";
		const row = await store.store({ text, category: "episodic", projectId: "global", timestamp: eventTime, metadata: JSON.stringify({ kind: "episodic", temporal_resolution_status: "unresolved", source_session: "same-session", asserted_at: eventTime }) });
		expect(JSON.parse(store.getById(row.id)?.metadata ?? "{}")).not.toHaveProperty("valid_from");
		const judgedCandidateIds = new Set<string>();
		const result = await retireRowsByName({ store, llm: createLlmClient({ preset: "mem_claw/sno_extract_chat" }), scope: "global", retiredPosition: text, currentPositionId: "another-row", triggeringEventIdentity: "different-message", triggeringSessionIdentity: "same-session", eventTime, judgmentBudget: { remaining: 0 }, judgedCandidateIds });
		expect(result).toEqual({ retiredIds: [], completed: true });
		expect(judgedCandidateIds.has(row.id)).toBe(true);
		expect(JSON.parse(store.getById(row.id)?.metadata ?? "{}").invalidated_at).toBeUndefined();
	} finally { await store.close(); fixture.cleanup(); }
});


it("uses a source timezone that differs from the session timezone", async () => {
	const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
	if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required");
	const timeInstructions: CalendarInstruction[] = [];
	const llm = observeTimeInstructions(createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 }), timeInstructions);
	const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "dateResolution", transport: "chat-completions" });
	const result = await resolveMemoryDate({ text: "The deployment happened on June 4, 2026 at 15:00 PDT.", sessionDateTime: SESSION_DATE_TIME, sessionTimezone: "Asia/Tokyo", llm });
	process.stdout.write(JSON.stringify({ host: hostname(), model: endpoint.preset.model, endpoint: endpoint.url, name: "source timezone differs from session", timeInstructions, result }) + "\n");
	expect(timeInstructions).toEqual([expect.objectContaining({ kind: "absolute", year: 2026, month: 6, day: 4, hour: 15, minute: 0, precision: "minute" })]);
	const sourceTime = timeInstructions[0];
	if (sourceTime?.kind !== "absolute" || !sourceTime.timezone) throw new Error("Model omitted the source timezone");
	expect(Temporal.Instant.from("2026-06-04T22:00:00Z").toZonedDateTimeISO(sourceTime.timezone).offset).toBe("-07:00");
	expect(result.interval).toMatchObject({ type: "bounded", from: Date.parse("2026-06-04T22:00:00Z"), until: Date.parse("2026-06-04T22:01:00Z") });
	expect(result.timestamp).toBe(Date.parse(SESSION_DATE_TIME));
}, 120_000);
