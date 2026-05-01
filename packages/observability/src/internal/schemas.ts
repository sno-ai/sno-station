import { z } from "zod";
import {
	InvalidAgentIdError,
	InvalidConsentError,
	InvalidEventPayloadError,
	InvalidEventTypeError,
} from "./errors.js";
import {
	AGENT_IDS,
	type AgentId,
	CONSENT_VALUES,
	type ConsentValue,
	EVENT_TYPES,
	type EventType,
	type JsonObject,
	type JsonValue,
	type ParsedEvent,
} from "./types.js";

export const agentIdSchema = z.enum(AGENT_IDS);
export const consentValueSchema = z.enum(CONSENT_VALUES);
export const eventTypeSchema = z.enum(EVENT_TYPES);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(jsonValueSchema),
	]),
);

const jsonObjectSchema = z.record(jsonValueSchema);
const tokenMethodSchema = z.enum(["bpe", "fast"]);

const payloadSchemas: Record<EventType, z.ZodType<unknown>> = {
	"agent.identify": z
		.object({
			agent_id: agentIdSchema,
			machine_id: z.string().min(1),
			agent_version: z.string().min(1).optional(),
			sdk_version: z.string().min(1),
		})
		.strict(),
	"memory.write": z
		.object({
			key_hash: z.string().min(1),
			byte_len: z.number().int().nonnegative(),
			content_tokens: z.number().int().nonnegative(),
			scope: z.string().min(1).optional(),
			ttl: z.number().int().nonnegative().optional(),
			tokens_method: tokenMethodSchema,
		})
		.strict(),
	"memory.read": z
		.object({
			query_hash: z.string().min(1),
			query_tokens: z.number().int().nonnegative(),
			k: z.number().int().nonnegative(),
			hit_count: z.number().int().nonnegative(),
			result_tokens: z.number().int().nonnegative(),
			latency_ms: z.number().nonnegative(),
			tokens_method: tokenMethodSchema,
		})
		.strict(),
	"llm.call": z
		.object({
			model: z.string().min(1),
			prompt_tokens: z.number().int().nonnegative(),
			completion_tokens: z.number().int().nonnegative(),
			latency_ms: z.number().nonnegative(),
			cache_read_tokens: z.number().int().nonnegative(),
			cache_write_tokens: z.number().int().nonnegative(),
		})
		.strict(),
	"tool.call": z
		.object({
			tool_name: z.string().min(1),
			decision: z.enum(["allow", "deny", "sample"]),
			input_hash: z.string().min(1),
			output_hash: z.string().min(1),
			latency_ms: z.number().nonnegative(),
		})
		.strict(),
	"session.start": z
		.object({
			session_uuid: z.string().min(1),
			duration_ms: z.number().nonnegative().optional(),
		})
		.strict(),
	"session.end": z
		.object({
			session_uuid: z.string().min(1),
			duration_ms: z.number().nonnegative().optional(),
		})
		.strict(),
	"prompt.submit": z
		.object({
			prompt_hash: z.string().min(1),
			byte_len: z.number().int().nonnegative(),
		})
		.strict(),
	"permission.request": z
		.object({
			kind: z.string().min(1),
			decision: z.enum(["allow", "deny"]),
			target_hash: z.string().min(1),
		})
		.strict(),
	"consent.change": z
		.object({
			from: consentValueSchema,
			to: consentValueSchema,
			reason: z.string().max(256),
		})
		.strict(),
	error: z
		.object({
			kind: z.string().min(1),
			message_hash: z.string().min(1),
			recoverable: z.boolean(),
		})
		.strict(),
	"cost.summary": z
		.object({
			session_uuid: z.string().min(1),
			event_count: z.number().int().nonnegative(),
			prompt_tokens: z.number().int().nonnegative(),
			completion_tokens: z.number().int().nonnegative(),
			tool_calls: z.number().int().nonnegative(),
			memory_reads: z.number().int().nonnegative(),
			memory_writes: z.number().int().nonnegative(),
			cost_usd: z.number().nonnegative().optional(),
		})
		.strict(),
};

const eventInputSchema = z
	.object({
		event_id: z.string().min(1).optional(),
		event_type: z.string().min(1),
		agent_id: z.string().min(1),
		ts_edge_ms: z.number().int().nonnegative().optional(),
		consent_level: z.string().optional(),
		scope: jsonObjectSchema.optional(),
		payload: z.unknown(),
	})
	.strict();

export function parseConsentValue(value: string): ConsentValue {
	const parsed = consentValueSchema.safeParse(value);
	if (!parsed.success) {
		throw new InvalidConsentError(value);
	}
	return parsed.data;
}

export function parseEventInput(input: unknown): ParsedEvent {
	const base = eventInputSchema.safeParse(input);
	if (!base.success) {
		throw new InvalidEventPayloadError(base.error.issues.map((issue) => issue.message).join("; "));
	}

	const agentId = agentIdSchema.safeParse(base.data.agent_id);
	if (!agentId.success) {
		throw new InvalidAgentIdError(base.data.agent_id);
	}

	const consentLevel =
		base.data.consent_level === undefined ? undefined : parseConsentValue(base.data.consent_level);

	if (base.data.event_type === "audit.anchor") {
		throw new InvalidEventTypeError(base.data.event_type);
	}
	const eventType = eventTypeSchema.safeParse(base.data.event_type);
	if (!eventType.success) {
		throw new InvalidEventTypeError(base.data.event_type);
	}

	const payload = payloadSchemas[eventType.data].safeParse(base.data.payload);
	if (!payload.success) {
		throw new InvalidEventPayloadError(payload.error.issues.map(formatIssue).join("; "));
	}

	const parsed: ParsedEvent = {
		eventType: eventType.data,
		agentId: agentId.data,
		scope: base.data.scope ?? {},
		payload: toJsonObject(payload.data),
	};
	if (base.data.event_id !== undefined) {
		parsed.eventId = base.data.event_id;
	}
	if (base.data.ts_edge_ms !== undefined) {
		parsed.tsEdgeMs = base.data.ts_edge_ms;
	}
	if (consentLevel !== undefined) {
		parsed.consentLevel = consentLevel;
	}
	return parsed;
}

export function isAgentId(value: string): value is AgentId {
	return agentIdSchema.safeParse(value).success;
}

function formatIssue(issue: z.ZodIssue): string {
	const path = issue.path.length === 0 ? "payload" : `payload.${issue.path.join(".")}`;
	return `${path}: ${issue.message}`;
}

function toJsonObject(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidEventPayloadError("payload: expected object");
	}
	const output: JsonObject = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			output[key] = toJsonValue(entry);
		}
	}
	return output;
}

function toJsonValue(value: unknown): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toJsonValue(entry));
	}
	if (typeof value === "object") {
		return toJsonObject(value);
	}
	throw new InvalidEventPayloadError("payload: expected JSON-compatible value");
}
