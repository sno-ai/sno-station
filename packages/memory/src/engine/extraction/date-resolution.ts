/** Model-only time interpretation followed by deterministic calendar arithmetic. */
import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";
import { calculateCalendarTime, calendarInstructionSchema, calendarSessionTimestamp, sessionZoneCarriedBy } from "./calendar-instruction";
import { RESOURCES_BY_LOCALE } from "../i18n/all-resources";
import { DEFAULT_LOCALE } from "../i18n/locales";
import type { TemporalInterval } from "./memory-temporality-classifier";
import type { Locale } from "../i18n/locales";
import { isTerminalLlmFailure, type LlmClient } from "../../model/llm-client";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import { readModelReplyJson } from "../shared/model-reply-text";

export { sessionZoneCarriedBy } from "./calendar-instruction";

const log = createLogger("sno-station-mem:date-resolution");
export interface DateResolutionStage {
	modelCalled: boolean;
	reason: string;
}
export interface DateResolutionResult {
	interval: TemporalInterval;
	/** When this information was supplied, not when the described event happened. */
	timestamp?: number;
	timezone: string;
	stage: DateResolutionStage;
}
interface DateInput {
	text: string;
	expression?: string;
	sessionDateTime?: string;
	sessionTimestamp?: number;
	sessionTimezone?: string;
	locale?: Locale;
}

/** No model means no semantic decision. Preserve the text rather than interpreting it. */
export function unresolvedMemoryDate(input: DateInput): DateResolutionResult {
	return {
		interval: { type: "unresolved", resolutionStatus: "unresolved", phrase: input.expression ?? input.text },
		timestamp: input.sessionTimestamp ?? calendarSessionTimestamp(input.sessionDateTime, input.sessionTimezone),
		timezone: input.sessionTimezone ?? sessionZoneCarriedBy(input.sessionDateTime) ?? "UTC",
		stage: { modelCalled: false, reason: "no-model-judgment" },
	};
}

const replySchema = z.object({ reason: z.string(), time: calendarInstructionSchema }).strict();

export async function resolveMemoryDate(input: DateInput & {
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
}): Promise<DateResolutionResult> {
	const unresolved = unresolvedMemoryDate(input);
	if (!input.llm || input.routing?.mode === "local-first") return unresolved;
	const anchor = input.sessionDateTime ?? (input.sessionTimestamp === undefined
		? undefined : new Date(input.sessionTimestamp).toISOString());
	const prompt = [
		RESOURCES_BY_LOCALE[input.locale ?? input.routing?.language ?? DEFAULT_LOCALE].extractionPrompts.buildDateResolutionPrompt(),
		JSON.stringify({ schema: z.toJSONSchema(replySchema), sentence: input.text,
			expression: input.expression ?? null, session_date_time: anchor ?? null,
			session_timezone: unresolved.timezone }),
	].join("\n\n");
	let raw: string | null = null;
	try {
		raw = await input.llm.completeText({
			adapterSlot: "date-resolution", callLabel: "date-resolution", prompt, enableThinking: true,
		});
	} catch (error) {
		if (isTerminalLlmFailure(error)) throw error;
		// A failed optional time judgment must not discard the independently supplied text.
	}
	const reply = raw ? readModelReplyJson(raw, (value) => {
		const parsed = replySchema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	}) : undefined;
	if (!reply) {
		const reason = raw === null ? "model-unavailable" : "invalid-model-instruction";
		log.warn("Memory time judgment failed; preserving unresolved time", { model_called: true, reason }, {
			event_name: "memory.date_resolution.unavailable", file: "packages/sno-station-mem/src/engine/extraction/date-resolution.ts",
			function: "resolveMemoryDate", site_id: "date-resolution.model_unavailable",
		});
		return { ...unresolved, stage: { modelCalled: true, reason } };
	}
	const stage = { modelCalled: true, reason: reply.reason };
	const calculated = calculateCalendarTime(reply.time, anchor, unresolved.timezone);
	log.info("Memory date resolution completed", { model_called: true, resolved: calculated !== null }, {
		event_name: "sno_station_mem.date-resolution.date.resolution.stage",
		file: "packages/sno-station-mem/src/engine/extraction/date-resolution.ts",
		function: "resolveMemoryDate", site_id: "date-resolution.resolveMemoryDate.1224fa35b2",
	});
	if (reply.time.kind === "none") return { ...unresolved, interval: { type: "static", resolutionStatus: "static" }, stage };
	if (!calculated) return { ...unresolved, stage };
	return {
		interval: { type: "bounded", resolutionStatus: "resolved", from: calculated.from,
			until: calculated.until, phrase: input.expression ?? input.text,
			date: calculated.label, precision: calculated.precision, timezone: calculated.timezone },
		timestamp: unresolved.timestamp, timezone: unresolved.timezone, stage,
	};
}
