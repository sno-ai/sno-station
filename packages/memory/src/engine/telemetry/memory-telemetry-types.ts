export const MEMORY_TELEMETRY_EVENT_TYPES = [
	"create",
	"update",
	"recall",
	"supersede",
	"delete",
	"inject",
	"epoch_boundary",
	"purge",
] as const;

export type MemoryTelemetryEventType = (typeof MEMORY_TELEMETRY_EVENT_TYPES)[number];

export type MemoryTelemetryMetadata = Record<string, unknown>;

export type MemoryTelemetryReceiptStatus = "valid" | "invalid" | "tampered" | "key_expired";

export const MEMORY_TELEMETRY_DELETE_REASONS = {
	admin: "admin_delete",
	cli: "cli_delete",
	memoryForget: "memory_forget",
} as const;

export type MemoryTelemetryDeleteReason =
	(typeof MEMORY_TELEMETRY_DELETE_REASONS)[keyof typeof MEMORY_TELEMETRY_DELETE_REASONS];

export function isMemoryTelemetryEventType(value: unknown): value is MemoryTelemetryEventType {
	return (
		typeof value === "string" &&
		(MEMORY_TELEMETRY_EVENT_TYPES as readonly string[]).includes(value)
	);
}
