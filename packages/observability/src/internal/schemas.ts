import { isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
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
	EVENT_LANES,
	EVENT_TYPES,
	type EventLane,
	type EventType,
	type JsonObject,
	type JsonValue,
	type ParsedEvent,
} from "./types.js";

export const agentIdSchema = z.enum(AGENT_IDS);
export const consentValueSchema = z.enum(CONSENT_VALUES);
export const eventLaneSchema = z.enum(EVENT_LANES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const uuidV7Schema = z
	.string()
	.refine(isLowercaseCanonicalUUIDv7, "must be a lowercase canonical UUID-v7 string");

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
const tokenMethodSchema = z.enum([
	"qwen_tokenizer",
	"tiktoken",
	"provider_reported",
	"char_approximation",
]);

const payloadSchemas: Record<EventType, z.ZodType<unknown>> = {
	"agent.identify": z
		.object({
			agent_id: agentIdSchema,
			machine_id: uuidV7Schema,
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
	"memory.snapshot": z
		.object({
			session_uuid: uuidV7Schema,
			snapshot_reason: z.enum(["session_end", "startup", "periodic"]),
			total_entries: z.number().int().nonnegative(),
			total_bytes: z.number().int().nonnegative(),
			oldest_entry_ts_ms: z.number().int().nonnegative().optional(),
			newest_entry_ts_ms: z.number().int().nonnegative().optional(),
		})
		.strict()
		.superRefine((value, ctx) => {
			const hasOldest = value.oldest_entry_ts_ms !== undefined;
			const hasNewest = value.newest_entry_ts_ms !== undefined;
			if (value.total_entries === 0) {
				if (hasOldest) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["oldest_entry_ts_ms"],
						message: "must be omitted when total_entries is 0",
					});
				}
				if (hasNewest) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["newest_entry_ts_ms"],
						message: "must be omitted when total_entries is 0",
					});
				}
				return;
			}
			if (!hasOldest) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["oldest_entry_ts_ms"],
					message: "is required when total_entries is greater than 0",
				});
			}
			if (!hasNewest) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["newest_entry_ts_ms"],
					message: "is required when total_entries is greater than 0",
				});
			}
		}),
	/** `model` SHOULD use `<provider>:<model_id>` or `embedding:<provider>:<model_id>`. */
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
			session_uuid: uuidV7Schema,
			duration_ms: z.number().nonnegative().optional(),
		})
		.strict(),
	"session.end": z
		.object({
			session_uuid: uuidV7Schema,
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
	/** `kind` SHOULD use `<component>:<reason>`, for example `llm.call:provider_throw`. */
	error: z
		.object({
			kind: z.string().min(1),
			message_hash: z.string().min(1),
			recoverable: z.boolean(),
		})
		.strict(),
	"cost.summary": z
		.object({
			session_uuid: uuidV7Schema,
			tokens_in: z.number().int().nonnegative(),
			tokens_out: z.number().int().nonnegative(),
			llm_calls: z.number().int().nonnegative(),
			memory_writes: z.number().int().nonnegative(),
			memory_reads: z.number().int().nonnegative(),
			tool_calls: z.number().int().nonnegative(),
			cost_usd: z.number().nonnegative().optional(),
			event_count: z.number().int().nonnegative().optional(),
		})
		.strict(),
};

const eventInputSchema = z
	.object({
		event_id: uuidV7Schema.optional(),
		event_type: z.string().min(1),
		lane: z.string().min(1),
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
	const { session_uuid: scopeSessionUuid } = base.data.scope ?? {};
	if (scopeSessionUuid !== undefined && !uuidV7Schema.safeParse(scopeSessionUuid).success) {
		throw new InvalidEventPayloadError(
			"scope.session_uuid: must be a lowercase canonical UUID-v7 string",
		);
	}

	const agentId = agentIdSchema.safeParse(base.data.agent_id);
	if (!agentId.success) {
		throw new InvalidAgentIdError(base.data.agent_id);
	}
	const lane = eventLaneSchema.safeParse(base.data.lane);
	if (!lane.success) {
		throw new InvalidEventPayloadError(`lane: expected one of ${EVENT_LANES.join(", ")}`);
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
		lane: lane.data as EventLane,
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
