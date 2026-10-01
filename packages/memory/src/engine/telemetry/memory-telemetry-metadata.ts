import {
	isMemoryTelemetryEventType,
	type MemoryTelemetryEventType,
	type MemoryTelemetryMetadata,
} from "./memory-telemetry-types";

const RAW_CONTENT_KEYS = new Set([
	"text",
	"content",
	"l0_abstract",
	"l1_overview",
	"l2_content",
	"chunk_text",
	"dense_payload",
	"summary",
]);

const METADATA_ALLOWED_KEYS = {
	create: ["operation_source", "dedupe_status", "content_hash", "receipt_status"],
	update: ["changed_keys", "changed_lifecycle_keys", "content_hash", "receipt_hmac", "key_version"],
	recall: [
		"dense_score",
		"bm25_score",
		"fused_score",
		"rerank_score",
		"mmr_score",
		"retrieval_rank",
		"retrieval_score",
	],
	supersede: ["superseded_by", "supersedes", "source_event_id", "supersede_mode"],
	delete: ["delete_reason", "source_event_id"],
	inject: ["injection_surface", "retrieval_rank", "retrieval_score", "source_agent_id"],
	epoch_boundary: ["subtype", "baseline_pre", "baseline_post", "scorer_version"],
	purge: ["status", "affected_fact_count", "purged_fact_ids", "failed_fact_ids", "blocked_reason"],
} as const satisfies Record<MemoryTelemetryEventType, readonly string[]>;

export function validateMemoryTelemetryMetadata(
	eventType: MemoryTelemetryEventType,
	metadata: MemoryTelemetryMetadata,
): MemoryTelemetryMetadata {
	if (!isMemoryTelemetryEventType(eventType)) {
		throw new Error(`Unsupported memory telemetry event type: ${String(eventType)}`);
	}
	const allowedKeys = new Set<string>(METADATA_ALLOWED_KEYS[eventType]);
	for (const key of Object.keys(metadata)) {
		if (RAW_CONTENT_KEYS.has(key)) {
			throw new Error(`Memory telemetry metadata must not contain raw content key: ${key}`);
		}
		if (!allowedKeys.has(key)) {
			throw new Error(`Memory telemetry metadata key '${key}' is not allowed for ${eventType}`);
		}
	}
	if (eventType === "delete") {
		const deleteReason = metadata.delete_reason;
		if (typeof deleteReason !== "string" || deleteReason.trim().length === 0) {
			throw new Error("delete metadata requires a non-empty delete_reason");
		}
	}
	return metadata;
}
