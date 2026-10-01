import { createHash } from "node:crypto";
import { createSnoObserve } from "@snoai/observability";
import { isLowercaseCanonicalUUIDv7 } from "../../../../../packages/common-core/src/index.ts";
import {
	getArrayField,
	getObjectField,
	getStringField,
	isRecord,
} from "./json";
import {
	type EventCriteria,
	type EventSummary,
	type ExpectedEventType,
	expectedEventTypes,
	type GatewayUsageSummary,
	type JsonValue,
} from "./types";

export function collectRunEventSummaries(
	value: unknown,
	criteria: EventCriteria,
): EventSummary[] {
	const summaries: EventSummary[] = [];
	for (const record of activityEventRecords(value)) {
		const event = parseObserveEventRecord(record, criteria);
		if (event) {
			summaries.push(event);
		}
	}
	return summaries;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

let observeHashApi:
	| Pick<ReturnType<typeof createSnoObserve>, "hashRedactedText">
	| undefined;

export function observeRedactedTextHash(value: string): string {
	observeHashApi ??= createSnoObserve();
	return observeHashApi.hashRedactedText(value);
}

export type IncompleteActivityEvidence = {
	reason: "activity_row_missing_scope_or_payload";
	rows: IncompleteActivityRow[];
};

export type IncompleteActivityRow = {
	agentId?: string;
	eventId: string;
	eventType: ExpectedEventType;
	hasPayload: boolean;
	hasScope: boolean;
	keys: string[];
	machineId?: string;
	userId?: string;
};

export function findIncompleteActivityEvidence(
	value: unknown,
	criteria: EventCriteria,
	eventTypes: ReadonlySet<ExpectedEventType>,
): IncompleteActivityEvidence | undefined {
	const rows: IncompleteActivityRow[] = [];
	for (const record of activityEventRecords(value)) {
		const eventType = getObserveEventType(record);
		if (!eventType || !eventTypes.has(eventType)) {
			continue;
		}
		const eventId =
			getStringField(record, "event_id") ??
			getStringField(record, "eventId") ??
			getStringField(record, "id");
		if (!eventId || !isLowercaseCanonicalUUIDv7(eventId)) {
			continue;
		}
		const scope = getObjectField(record, "scope");
		const userId = scope ? getStringField(scope, "user_id") : undefined;
		const machineId = scope ? getStringField(scope, "machine_id") : undefined;
		if (
			scope &&
			(userId !== criteria.sdkUserCuid || machineId !== criteria.machineUuid)
		) {
			continue;
		}
		const hasScope = scope !== undefined;
		const hasPayload = getObjectField(record, "payload") !== undefined;
		if (hasScope && hasPayload) {
			continue;
		}
		rows.push({
			agentId:
				getStringField(record, "agent_id") ?? getStringField(record, "agentId"),
			eventId,
			eventType,
			hasPayload,
			hasScope,
			keys: Object.keys(record).sort(),
			machineId,
			userId,
		});
	}
	return rows.length > 0
		? { reason: "activity_row_missing_scope_or_payload", rows }
		: undefined;
}

function activityEventRecords(value: unknown): Record<string, JsonValue>[] {
	if (!isRecord(value)) {
		return [];
	}
	const records: Record<string, JsonValue>[] = [];
	for (const page of getArrayField(value, "pages")) {
		records.push(...activityEventRecords(page));
	}
	records.push(...getArrayField(value, "events").filter(isRecord));
	return records;
}

export function hasExpectedRunEvents(
	summaries: EventSummary[],
	teachPromptSession: string,
	qaSession: string,
	teachWriteSession = teachPromptSession,
): boolean {
	return (
		hasTeachObserveEvidence(summaries, teachPromptSession, teachWriteSession) &&
		hasRecallObserveEvidence(summaries, qaSession) &&
		hasFinalizeObserveEvidence(summaries, qaSession)
	);
}

export function hasTeachObserveEvidence(
	summaries: EventSummary[],
	teachPromptSession: string,
	teachWriteSession = teachPromptSession,
): boolean {
	return (
		hasStartupSnapshot(summaries) &&
		hasSessionEvent(
			summaries,
			teachPromptSession,
			"session.start",
			hasMatchingPayloadSession(teachPromptSession),
		) &&
		hasSessionEvent(summaries, teachPromptSession, "prompt.submit") &&
		hasHostAgentLlmEvidence(summaries, teachPromptSession) &&
		hasMemoryWriteTokenEvidence(summaries, teachWriteSession)
	);
}

export function hasRecallObserveEvidence(
	summaries: EventSummary[],
	qaSession: string,
): boolean {
	return (
		hasSessionEvent(
			summaries,
			qaSession,
			"session.start",
			hasMatchingPayloadSession(qaSession),
		) &&
		hasSessionEvent(summaries, qaSession, "prompt.submit") &&
		hasSessionEvent(
			summaries,
			qaSession,
			"memory.read",
			(summary) => (summary.hitCount ?? 0) > 0,
		) &&
		hasMemoryReadTokenEvidence(summaries, qaSession) &&
		hasHostAgentLlmEvidence(summaries, qaSession)
	);
}

export function hasFinalizeObserveEvidence(
	summaries: EventSummary[],
	qaSession: string,
): boolean {
	return (
		hasSessionEvent(
			summaries,
			qaSession,
			"cost.summary",
			hasMatchingPayloadSession(qaSession),
		) &&
		hasSessionEvent(
			summaries,
			qaSession,
			"memory.snapshot",
			(summary) =>
				summary.payloadSessionUuid === qaSession &&
				summary.snapshotReason === "session_end",
		) &&
		hasSessionEvent(
			summaries,
			qaSession,
			"session.end",
			hasMatchingPayloadSession(qaSession),
		)
	);
}

export function hasAgentIdentify(summaries: EventSummary[]): boolean {
	return summaries.some(
		(summary) =>
			summary.eventType === "agent.identify" &&
			summary.scopeSessionUuid === undefined,
	);
}

export function hasAgentIdentifyVersionMetadata(
	summaries: EventSummary[],
	expectedVersion?: string,
): boolean {
	return summaries.some(
		(summary) =>
			summary.eventType === "agent.identify" &&
			summary.scopeSessionUuid === undefined &&
			(expectedVersion
				? summary.agentCliVersion === expectedVersion &&
					summary.agentPluginVersion === expectedVersion
				: isSemver(summary.agentCliVersion) &&
					isSemver(summary.agentPluginVersion)),
	);
}

export function hasStartupSnapshot(summaries: EventSummary[]): boolean {
	return summaries.some(
		(summary) =>
			summary.eventType === "memory.snapshot" &&
			summary.snapshotReason === "startup" &&
			summary.scopeSessionUuid === undefined,
	);
}

export function hasSessionEvent(
	summaries: EventSummary[],
	sessionUuid: string,
	eventType: ExpectedEventType,
	matches: (summary: EventSummary) => boolean = () => true,
): boolean {
	return summaries.some(
		(summary) =>
			summary.scopeSessionUuid === sessionUuid &&
			summary.eventType === eventType &&
			matches(summary),
	);
}

export function sessionEvents(
	summaries: EventSummary[],
	sessionUuid: string,
	eventType?: ExpectedEventType,
): EventSummary[] {
	return summaries.filter(
		(summary) =>
			summary.scopeSessionUuid === sessionUuid &&
			(eventType === undefined || summary.eventType === eventType),
	);
}

export function sessionEventCount(
	summaries: EventSummary[],
	sessionUuid: string,
	eventType: ExpectedEventType,
): number {
	return sessionEvents(summaries, sessionUuid, eventType).length;
}

export function hasSeparatedTokenEvidence(
	summaries: EventSummary[],
	teachSession: string,
	qaSession: string,
	_expectedUsage?: {
		qa?: GatewayUsageSummary;
		teach?: GatewayUsageSummary;
	},
): boolean {
	const hasHostAgentUsage =
		hasHostAgentLlmEvidence(summaries, teachSession) &&
		hasHostAgentLlmEvidence(summaries, qaSession);
	const hasSplitSummary = sessionEvents(
		summaries,
		qaSession,
		"cost.summary",
	).some(
		(summary) =>
			hasNumber(summary.hostAgentPromptTokens) &&
			hasNumber(summary.hostAgentCompletionTokens) &&
			hasNumber(summary.pluginInternalPromptTokens) &&
			hasNumber(summary.pluginInternalCompletionTokens) &&
			hasNumber(summary.localMemoryInputTokens) &&
			hasNumber(summary.localMemoryOutputTokens) &&
			summary.tokensIn ===
				summary.hostAgentPromptTokens + summary.pluginInternalPromptTokens &&
			summary.tokensOut ===
				summary.hostAgentCompletionTokens +
					summary.pluginInternalCompletionTokens &&
			(summary.localMemoryInputTokens > 0 ||
				summary.localMemoryOutputTokens > 0),
	);
	return hasHostAgentUsage && hasSplitSummary;
}

export function hasHostAgentLlmEvidence(
	summaries: EventSummary[],
	sessionUuid: string,
): boolean {
	if (hasHostAgentLlmCall(summaries, sessionUuid)) {
		return true;
	}
	return hasSessionEvent(summaries, sessionUuid, "cost.summary");
}

export function hasHostAgentLlmCall(
	summaries: EventSummary[],
	sessionUuid: string,
	expectedUsage?: GatewayUsageSummary,
): boolean {
	const calls = sessionEvents(summaries, sessionUuid, "llm.call").filter(
		(summary) => summary.tokenSource === "host_agent_paid",
	);
	if (calls.length === 0) {
		return false;
	}
	if (!expectedUsage) {
		return true;
	}
	if (expectedUsage.promptTokens + expectedUsage.completionTokens <= 0) {
		return false;
	}
	const promptTokens = sumNumbers(
		calls.map((summary) => summary.llmPromptTokens),
	);
	const completionTokens = sumNumbers(
		calls.map((summary) => summary.llmCompletionTokens),
	);
	return (
		(expectedUsage.promptTokens === 0 || promptTokens > 0) &&
		(expectedUsage.completionTokens === 0 || completionTokens > 0)
	);
}

export function hasMemoryWriteTokenEvidence(
	summaries: EventSummary[],
	sessionUuid: string,
): boolean {
	return sessionEvents(summaries, sessionUuid, "memory.write").some(
		(summary) =>
			isAllowedTokenMethod(summary.tokensMethod) &&
			hasNumber(summary.contentTokens) &&
			summary.contentTokens > 0,
	);
}

export function hasMemoryReadTokenEvidence(
	summaries: EventSummary[],
	sessionUuid: string,
): boolean {
	return sessionEvents(summaries, sessionUuid, "memory.read").some(
		(summary) =>
			isAllowedTokenMethod(summary.tokensMethod) &&
			(summary.hitCount ?? 0) > 0 &&
			hasNumber(summary.queryTokens) &&
			hasNumber(summary.resultTokens),
	);
}

export function findSessionByPromptHash(
	summaries: EventSummary[],
	promptHash: string,
	requiredEvents: readonly ExpectedEventType[],
): string | undefined {
	const candidates = summaries
		.filter(
			(summary) =>
				summary.eventType === "prompt.submit" &&
				summary.promptHash === promptHash &&
				summary.scopeSessionUuid !== undefined,
		)
		.map((summary) => summary.scopeSessionUuid);
	for (const sessionUuid of candidates) {
		if (
			sessionUuid &&
			requiredEvents.every((eventType) =>
				hasSessionEvent(summaries, sessionUuid, eventType),
			)
		) {
			return sessionUuid;
		}
	}
	return undefined;
}

function parseObserveEventRecord(
	value: Record<string, JsonValue>,
	criteria: EventCriteria,
): EventSummary | undefined {
	const eventType = getObserveEventType(value);
	if (!eventType) {
		return undefined;
	}
	const eventId =
		getStringField(value, "event_id") ??
		getStringField(value, "eventId") ??
		getStringField(value, "id");
	if (!eventId || !isLowercaseCanonicalUUIDv7(eventId)) {
		return undefined;
	}
	const scope = getObjectField(value, "scope");
	const payload = getObjectField(value, "payload");
	if (!scope || !payload) {
		return undefined;
	}
	const scopeUserId =
		getStringField(scope, "user_id") ?? getStringField(scope, "userId");
	const scopeMachineId =
		getStringField(scope, "machine_id") ?? getStringField(scope, "machineId");
	const scopeSessionUuid =
		getStringField(scope, "session_uuid") ??
		getStringField(scope, "sessionUuid");
	if (
		scopeUserId !== criteria.sdkUserCuid ||
		scopeMachineId !== criteria.machineUuid
	) {
		return undefined;
	}
	const payloadSessionUuid = getStringField(payload, "session_uuid");

	if (eventType === "agent.identify") {
		if (
			getStringField(payload, "machine_id") !== criteria.machineUuid ||
			scopeSessionUuid !== undefined ||
			!payloadMatchesEventShape(eventType, payload)
		) {
			return undefined;
		}
		return {
			agentCliVersion: getStringField(payload, "cli_version"),
			agentPluginVersion: getStringField(payload, "plugin_version"),
			eventId,
			eventType,
			scopeSessionUuid,
		};
	}

	if (
		eventType === "memory.snapshot" &&
		getStringField(payload, "snapshot_reason") === "startup"
	) {
		if (
			scopeSessionUuid !== undefined ||
			!payloadMatchesEventShape(eventType, payload)
		) {
			return undefined;
		}
		return {
			eventId,
			eventType,
			payloadSessionUuid,
			snapshotReason: "startup",
		};
	}

	if (
		!scopeSessionUuid ||
		(criteria.sessionUuids !== undefined &&
			!criteria.sessionUuids.has(scopeSessionUuid)) ||
		!isLowercaseCanonicalUUIDv7(scopeSessionUuid) ||
		(eventRequiresPayloadSession(eventType) &&
			payloadSessionUuid !== scopeSessionUuid)
	) {
		return undefined;
	}
	if (!payloadMatchesEventShape(eventType, payload)) {
		return undefined;
	}
	return {
		byteLen: getNumberValue(payload, "byte_len"),
		contentTokens: getNumberValue(payload, "content_tokens"),
		errorKind: getStringField(payload, "kind"),
		eventId,
		eventType,
		hitCount: getNumberValue(payload, "hit_count"),
		keyHash: getStringField(payload, "key_hash"),
		hostAgentCompletionTokens: getNumberValue(
			payload,
			"host_agent_completion_tokens",
		),
		hostAgentPromptTokens: getNumberValue(payload, "host_agent_prompt_tokens"),
		localMemoryInputTokens: getNumberValue(
			payload,
			"local_memory_input_tokens",
		),
		localMemoryOutputTokens: getNumberValue(
			payload,
			"local_memory_output_tokens",
		),
		llmCompletionTokens: getNumberValue(payload, "completion_tokens"),
		llmModel: getStringField(payload, "model"),
		llmPreset: getStringField(payload, "preset"),
		llmPromptTokens: getNumberValue(payload, "prompt_tokens"),
		llmProvider: getStringField(payload, "provider"),
		llmResolvedModel: getStringField(payload, "resolved_model"),
		payloadSessionUuid,
		pluginInternalCompletionTokens: getNumberValue(
			payload,
			"plugin_internal_completion_tokens",
		),
		pluginInternalPromptTokens: getNumberValue(
			payload,
			"plugin_internal_prompt_tokens",
		),
		promptHash: getStringField(payload, "prompt_hash"),
		queryHash: getStringField(payload, "query_hash"),
		queryTokens: getNumberValue(payload, "query_tokens"),
		resultTokens: getNumberValue(payload, "result_tokens"),
		scopeProjectId: getStringField(scope, "project_id"),
		scopeSessionUuid,
		snapshotReason: getStringField(payload, "snapshot_reason"),
		tokenSource: getStringField(payload, "token_source"),
		tokensMethod: getStringField(payload, "tokens_method"),
		tokensIn: getNumberValue(payload, "tokens_in"),
		tokensOut: getNumberValue(payload, "tokens_out"),
		toolName: getStringField(payload, "tool_name"),
	};
}

function getObserveEventType(value: Record<string, JsonValue>) {
	const eventType =
		getStringField(value, "event_type") ??
		getStringField(value, "eventType") ??
		getStringField(value, "type");
	return eventType && isExpectedEventType(eventType) ? eventType : undefined;
}

function eventRequiresPayloadSession(eventType: ExpectedEventType): boolean {
	return (
		eventType === "session.start" ||
		eventType === "error" ||
		eventType === "cost.summary" ||
		eventType === "memory.snapshot" ||
		eventType === "session.end"
	);
}

function payloadMatchesEventShape(
	eventType: ExpectedEventType,
	payload: Record<string, JsonValue>,
): boolean {
	switch (eventType) {
		case "agent.identify":
			return (
				hasStringField(payload, "agent_id") &&
				hasStringField(payload, "sdk_version") &&
				isLowercaseCanonicalUUIDv7(getStringField(payload, "machine_id") ?? "")
			);
		case "session.start":
			return hasPayloadSessionUuid(payload);
		case "prompt.submit":
			return (
				hasHashField(payload, "prompt_hash") &&
				hasNumberField(payload, "byte_len") &&
				getStringField(payload, "prompt_text") === undefined &&
				getStringField(payload, "promptText") === undefined
			);
		case "llm.call":
			return (
				hasStringField(payload, "model") &&
				hasAllowedTokenSource(payload) &&
				hasNumberField(payload, "prompt_tokens") &&
				hasNumberField(payload, "completion_tokens") &&
				hasNumberField(payload, "latency_ms") &&
				hasNumberField(payload, "cache_read_tokens") &&
				hasNumberField(payload, "cache_write_tokens")
			);
		case "tool.call":
			return (
				hasStringField(payload, "tool_name") &&
				hasStringField(payload, "decision") &&
				hasHashField(payload, "input_hash") &&
				hasHashField(payload, "output_hash") &&
				hasNumberField(payload, "latency_ms")
			);
		case "memory.write":
			return (
				hasHashField(payload, "key_hash") &&
				hasNumberField(payload, "byte_len") &&
				hasNumberField(payload, "content_tokens") &&
				hasAllowedTokenMethod(payload)
			);
		case "memory.read":
			return (
				hasHashField(payload, "query_hash") &&
				hasNumberField(payload, "query_tokens") &&
				hasNumberField(payload, "k") &&
				hasNumberField(payload, "hit_count") &&
				hasNumberField(payload, "result_tokens") &&
				hasNumberField(payload, "latency_ms") &&
				hasAllowedTokenMethod(payload)
			);
		case "error":
			return (
				hasStringField(payload, "kind") &&
				hasHashField(payload, "message_hash") &&
				typeof payload.recoverable === "boolean" &&
				getStringField(payload, "message") === undefined
			);
		case "cost.summary":
			return (
				hasPayloadSessionUuid(payload) &&
				hasNumberField(payload, "tokens_in") &&
				hasNumberField(payload, "tokens_out") &&
				hasNumberField(payload, "llm_calls") &&
				hasNumberField(payload, "memory_writes") &&
				hasNumberField(payload, "memory_reads") &&
				hasNumberField(payload, "tool_calls") &&
				hasNumberField(payload, "host_agent_prompt_tokens") &&
				hasNumberField(payload, "host_agent_completion_tokens") &&
				hasNumberField(payload, "plugin_internal_prompt_tokens") &&
				hasNumberField(payload, "plugin_internal_completion_tokens") &&
				hasNumberField(payload, "local_memory_input_tokens") &&
				hasNumberField(payload, "local_memory_output_tokens")
			);
		case "memory.snapshot":
			return hasMemorySnapshotShape(payload);
		case "session.end":
			return hasPayloadSessionUuid(payload);
	}
}

function hasMatchingPayloadSession(
	sessionUuid: string,
): (summary: EventSummary) => boolean {
	return (summary) => summary.payloadSessionUuid === sessionUuid;
}

function isExpectedEventType(value: string): value is ExpectedEventType {
	return expectedEventTypes.includes(value as ExpectedEventType);
}

function hasPayloadSessionUuid(value: Record<string, JsonValue>): boolean {
	const sessionUuid = getStringField(value, "session_uuid");
	return sessionUuid !== undefined && isLowercaseCanonicalUUIDv7(sessionUuid);
}

function hasMemorySnapshotShape(value: Record<string, JsonValue>): boolean {
	const reason = getStringField(value, "snapshot_reason");
	if (
		reason !== "session_end" &&
		reason !== "startup" &&
		reason !== "periodic"
	) {
		return false;
	}
	if (
		!hasNumberField(value, "total_entries") ||
		!hasNumberField(value, "total_bytes")
	) {
		return false;
	}
	return reason === "startup"
		? optionalPayloadSessionUuid(value)
		: hasPayloadSessionUuid(value);
}

function optionalPayloadSessionUuid(value: Record<string, JsonValue>): boolean {
	const sessionUuid = getStringField(value, "session_uuid");
	return sessionUuid === undefined || isLowercaseCanonicalUUIDv7(sessionUuid);
}

function hasHashField(value: Record<string, JsonValue>, key: string): boolean {
	const field = getStringField(value, key);
	return field !== undefined && /^[a-f0-9]{64}$/.test(field);
}

function hasNumberField(
	value: Record<string, JsonValue>,
	key: string,
): boolean {
	const field = getNumberValue(value, key);
	return field !== undefined && field >= 0;
}

function getNumberValue(
	value: Record<string, JsonValue>,
	key: string,
): number | undefined {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field)
		? field
		: undefined;
}

function hasStringField(
	value: Record<string, JsonValue>,
	key: string,
): boolean {
	return getStringField(value, key) !== undefined;
}

function hasAllowedTokenMethod(value: Record<string, JsonValue>): boolean {
	return isAllowedTokenMethod(getStringField(value, "tokens_method"));
}

function isAllowedTokenMethod(method: string | undefined): boolean {
	return (
		method === "qwen_tokenizer" ||
		method === "tiktoken" ||
		method === "provider_reported" ||
		method === "char_approximation"
	);
}

function hasAllowedTokenSource(value: Record<string, JsonValue>): boolean {
	const source = getStringField(value, "token_source");
	return source === "host_agent_paid" || source === "plugin_internal_paid";
}

function hasNumber(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

function sumNumbers(values: readonly (number | undefined)[]): number {
	return values.reduce<number>((sum, value) => sum + (hasNumber(value) ? value : 0), 0);
}

function isSemver(value: string | undefined): boolean {
	return value !== undefined && /^\d+\.\d+\.\d+$/.test(value);
}
