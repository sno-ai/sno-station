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
		const llm = createLlmClient({ preset: "mem_claw/sno_extract_chat", apiKey, timeoutMs: 90_000 });
		const config = await llm.getResolvedConfig();
		const endpoint = await resolveLlmEndpoint({ configuredPreset: "mem_claw/sno_extract_chat", occasion: "dateResolution", transport: "chat-completions" });
		const result = await resolveMemoryDate({ text: "I've known these friends for 4 years, since I moved from my home country.", expression: "for 4 years", sessionDateTime: "2023-06-09T19:55:00Z", sessionTimezone: "UTC", llm });
		process.stdout.write(JSON.stringify({ host: hostname(), model: config.model, endpoint: endpoint.url, result }) + "\n");
		expect(result.stage.modelCalled).toBe(true);
		expect(result.interval).toMatchObject({ type: "bounded", date: "2019", precision: "year", from: Date.UTC(2019, 0, 1), until: Date.UTC(2020, 0, 1) });
	}, 120_000);
});
