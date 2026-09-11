/** @file date-resolution-acceptance.test.ts
 * @purpose Proves the PRD date-resolution prompt, routing, isolation, and validation contract.
 * @boundary Real MemoryLlmClient with a test-owned AgentLlmPort seam; no provider or storage mocks.
 */

import * as chrono from "chrono-node";
import { describe, expect, it } from "vitest";

import {
	DATE_RESOLUTION_PARSER_BY_LOCALE,
	resolveDateLocally,
	resolveMemoryDate,
} from "../../../../packages/sno-station-mem/src/engine/extraction/date-resolution.ts";
import { RESOURCES_BY_LOCALE } from "../../../../packages/sno-station-mem/src/engine/i18n/all-resources.ts";
import {
	type Locale,
	SUPPORTED_LOCALES,
} from "../../../../packages/sno-station-mem/src/engine/i18n/locales.ts";
import type {
	AgentLlmCompletion,
	AgentLlmPort,
	AgentLlmRequest,
} from "../../../../packages/sno-station-mem/src/model/agent-llm-port.ts";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client.ts";
import type { LlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client-types.ts";
import type { LlmRoutingConfig } from "../../../../packages/sno-station-mem/src/model/llm-mode-routing.ts";

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

function validReply(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		resolved: true,
		year: 2026,
		month: 6,
		day: 4,
		hour: null,
		minute: null,
		timezone: null,
		reason: "resolved by the supplied expression and anchor",
		...overrides,
	});
}

function promptPayload(request: AgentLlmRequest): {
	anchor: string;
	weekday: number;
	sentence: string;
	expression: string;
	parserReadings: unknown[];
} {
	const line = request.prompt.split("\n").at(-1);
	if (!line) throw new Error("date-resolution prompt has no payload line");
	return JSON.parse(line) as ReturnType<typeof promptPayload>;
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

describe("date-resolution acceptance contract", () => {
	it("isolates three unresolved phrases so one invalid reply cannot discard two valid results", async () => {
		const callsByExpression = new Map<string, number>();
		const port = new RecordingAgentPort((request) => {
			const expression = promptPayload(request).expression;
			callsByExpression.set(expression, (callsByExpression.get(expression) ?? 0) + 1);
			if (expression === "middle-glorpday") {
				return {
					kind: "ok",
					text: validReply({ timestamp: "2026-06-04T00:00:00Z" }),
				};
			}
			return {
				kind: "ok",
				text: validReply({ day: expression === "first-glorpday" ? 1 : 3 }),
			};
		});

		const results = [];
		for (const expression of ["first-glorpday", "middle-glorpday", "last-glorpday"]) {
			results.push(await resolveExpression(expression, port));
		}

		expect(callsByExpression).toEqual(
			new Map([
				["first-glorpday", 1],
				["middle-glorpday", 1],
				["last-glorpday", 1],
			]),
		);
		expect(results.map((result) => result.interval.resolutionStatus)).toEqual([
			"resolved",
			"unresolved",
			"resolved",
		]);
	});

	it("emits every stage field once for one local resolution", () => {
		const result = resolveDateLocally({
			text: "I walked today.",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		}).result;

		expect(result.stage).toEqual({
			selectedParser: "en",
			selectionReason: "winner",
			winningScore: 3,
			runnerUpScore: 0,
			ambiguityGateFired: false,
			modelCalled: false,
			timezone: "user",
			reason: null,
		});
	});

	it("sends the active non-empty locale prompt for all nine locales", async () => {
		for (const locale of SUPPORTED_LOCALES) {
			const port = new RecordingAgentPort(() => ({ kind: "ok", text: validReply() }));
			const localePrompt = RESOURCES_BY_LOCALE[locale].extractionPrompts
				.buildDateResolutionPrompt()
				.trim();
			expect(localePrompt).not.toBe("");

			await resolveExpression(`glorpday-${locale}`, port, locale);

			expect(port.requests).toHaveLength(1);
			expect(port.requests[0]?.prompt.startsWith(`${localePrompt}\n`)).toBe(true);
		}
	});

	it("forwards thinking without provider sampling keys", async () => {
		const port = new RecordingAgentPort(() => ({ kind: "ok", text: validReply() }));
		await resolveExpression("thinking-glorpday", port);

		const request = port.requests[0] as AgentLlmRequest & Record<string, unknown>;
		expect(request.enableThinking).toBe(true);
		for (const key of ["temperature", "top_p", "top_k", "repetition_penalty"]) {
			expect(request).not.toHaveProperty(key);
		}
	});

	it("uses numeric offset minutes so today stays on June 5", () => {
		const instant = new Date("2026-06-06T04:00:00.000Z");
		const numeric = chrono.en.parse("walked today", { instant, timezone: -420 })[0];
		const iana = chrono.en.parse("walked today", {
			instant,
			timezone: "America/Los_Angeles" as unknown as number,
		})[0];

		expect(numeric?.start.get("day")).toBe(5);
		expect(iana?.start.get("day")).toBe(6);
		const product = resolveDateLocally({
			text: "walked today",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});
		expect(new Date(product.result.timestamp ?? 0).toISOString().slice(0, 10)).toBe("2026-06-05");
	});

	it("calls no model for static text and one model for one unreadable named phrase", async () => {
		const port = new RecordingAgentPort(() => ({ kind: "ok", text: validReply() }));
		const llm = client(port);
		const activeRouting = routing();

		const staticResult = await resolveMemoryDate({
			text: "The user prefers window seats.",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm,
			routing: activeRouting,
		});
		expect(staticResult.interval.resolutionStatus).toBe("static");
		expect(port.requests).toHaveLength(0);

		await resolveMemoryDate({
			text: "The event happened on glorpday.",
			expression: "glorpday",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm,
			routing: activeRouting,
		});
		expect(port.requests).toHaveLength(1);
	});

	it("keeps unreadable Finnish text and writes no interval under local-first", async () => {
		const text = "Tapaaminen on siansaksapäivänä.";
		const port = new RecordingAgentPort(() => {
			throw new Error("local-first must not call the model");
		});
		const result = await resolveMemoryDate({
			text,
			expression: text,
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm: client(port),
			routing: routing("en", "local-first"),
		});

		expect(result.interval).toEqual({
			type: "unresolved",
			resolutionStatus: "unresolved",
			phrase: text,
		});
		expect(result.stage.reason).toBe("local-first-unreadable");
		expect(port.requests).toHaveLength(0);
	});

	it.each([
		["named timezone", { timezone: "PDT" }],
		["February 30", { month: 2, day: 30 }],
		["month 13", { month: 13 }],
		["hour 24", { hour: 24 }],
		["minute 60", { hour: 12, minute: 60 }],
		["resolved without day", { day: null }],
		["unresolved with a date", { resolved: false, year: 2026 }],
	] as const)("rejects the model schema case %s", async (_name, overrides) => {
		const port = new RecordingAgentPort(() => ({
			kind: "ok",
			text: validReply(overrides),
		}));
		const result = await resolveExpression("invalid-schema-glorpday", port);

		expect(result.interval.resolutionStatus).toBe("unresolved");
		expect(result.stage.reason).toBe("model-unresolved");
	});

	it("accepts a thinking-wrapped reply without requesting response_format", async () => {
		const port = new RecordingAgentPort(() => ({
			kind: "ok",
			text: `<thinking>calendar reasoning</thinking>${validReply({ reason: "wrapped" })}`,
		}));
		const result = await resolveExpression("wrapped-glorpday", port);

		expect(result.stage.reason).toBe("wrapped");
		expect(port.requests[0] as AgentLlmRequest & Record<string, unknown>).not.toHaveProperty(
			"response_format",
		);
	});

	it("keeps one valid unresolved reply and its reason without retrying", async () => {
		const port = new RecordingAgentPort(() => ({
			kind: "ok",
			text: validReply({
				resolved: false,
				year: null,
				month: null,
				day: null,
				hour: null,
				minute: null,
				timezone: null,
				reason: "the expression does not establish a calendar date",
			}),
		}));
		const result = await resolveExpression("unknown-calendar-glorpday", port);

		expect(port.requests).toHaveLength(1);
		expect(result.interval.resolutionStatus).toBe("unresolved");
		expect(result.stage).toMatchObject({
			modelCalled: true,
			reason: "the expression does not establish a calendar date",
		});
	});

	it("retries HTTP 502 exactly twice and preserves the parser's full-day partial", async () => {
		const port = new RecordingAgentPort(() => ({
			kind: "error",
			category: "transport",
			message: "HTTP 502",
		}));
		const activeRouting = routing("en");
		const result = await resolveMemoryDate({
			text: "yesterday at 3",
			expression: "yesterday at 3",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm: client(port),
			routing: activeRouting,
		});

		expect(port.requests).toHaveLength(2);
		expect(result).toMatchObject({
			timezone: "user",
			interval: { type: "bounded", resolutionStatus: "resolved", phrase: "yesterday at 3" },
			stage: { ambiguityGateFired: true, modelCalled: true, reason: "model-unresolved" },
		});
	});

	it("sends only the active phrase context and every required anchor field", async () => {
		const port = new RecordingAgentPort(() => ({ kind: "ok", text: validReply() }));
		const sentence = "The deployment happened on context-glorpday.";
		await resolveMemoryDate({
			text: sentence,
			expression: "context-glorpday",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm: client(port),
			routing: routing(),
		});

		const request = port.requests[0];
		if (!request) throw new Error("missing date-resolution request");
		const payload = promptPayload(request);
		expect(payload).toMatchObject({
			anchor: SESSION_DATE_TIME,
			weekday: 5,
			sentence,
			expression: "context-glorpday",
			parserReadings: [],
		});
		expect(request.prompt).not.toContain("SECRET_OTHER_MEMORY");
	});

	it("derives the model anchor when the caller supplies only a timestamp and timezone", async () => {
		const port = new RecordingAgentPort(() => ({ kind: "ok", text: validReply() }));
		await resolveMemoryDate({
			text: "The deployment happened on timestamp-glorpday.",
			expression: "timestamp-glorpday",
			sessionTimestamp: Date.parse(SESSION_DATE_TIME),
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			llm: client(port),
			routing: routing(),
		});

		const request = port.requests[0];
		if (!request) throw new Error("missing date-resolution request");
		expect(promptPayload(request).anchor).toBe(SESSION_DATE_TIME);
	});

	it("carries model reason to the stage and rejects an extra reply field", async () => {
		const acceptedPort = new RecordingAgentPort(() => ({
			kind: "ok",
			text: validReply({ reason: "the anchor makes this the prior day" }),
		}));
		const accepted = await resolveExpression("reason-glorpday", acceptedPort);
		expect(accepted.stage.reason).toBe("the anchor makes this the prior day");

		const rejectedPort = new RecordingAgentPort(() => ({
			kind: "ok",
			text: validReply({ confidence: 0.99 }),
		}));
		const rejected = await resolveExpression("extra-field-glorpday", rejectedPort);
		expect(rejected.interval.resolutionStatus).toBe("unresolved");
	});

	it("uses the configured parser map and no parser for Korean", () => {
		expect(DATE_RESOLUTION_PARSER_BY_LOCALE).toEqual({
			en: "en",
			de: "de",
			es: "es",
			fr: "fr",
			ja: "ja",
			ko: null,
			ru: "ru",
			zh: "zh",
			"zh-Hant": "zh-Hant",
		});
		const korean = resolveDateLocally({
			text: "03/04/2026",
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "ko",
			localFirst: true,
		});
		expect(korean.result.stage.selectedParser).toBeNull();
		expect(korean.result.stage.selectionReason).toBe("tie-disagreed");
	});
});
