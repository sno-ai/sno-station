import type { SqliteDatabaseLike } from "../../store/sqlite-runtime";

export type MemoryTelemetryIncidentSeverity = "warning" | "error";

export interface MemoryTelemetryIncidentInput {
	incidentType: string;
	severity: MemoryTelemetryIncidentSeverity;
	message: string;
	payload?: Record<string, string | number | boolean | null>;
	createdAtMs?: number;
}

export function recordMemoryTelemetryIncident(
	sqlite: SqliteDatabaseLike,
	input: MemoryTelemetryIncidentInput,
): void {
	sqlite
		.prepare(
			`INSERT INTO nodix_memory_telemetry_incidents
			 (incident_type, severity, message, payload_json, created_at_ms)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			input.incidentType,
			input.severity,
			input.message,
			input.payload ? JSON.stringify(input.payload) : null,
			input.createdAtMs ?? Date.now(),
		);
}
