/** @file memory-store-task-lifecycle-timestamp-api.ts
 * @purpose Persists lifecycle effective-time value and source under the final command identity.
 * @boundary Existing extraction timestamp table only; no lifecycle command or task-state writes.
 */

import {
	MemoryStore,
	type MemoryStoreInternals,
	TaskLifecycleTimestampCollisionError,
	type TaskLifecycleTimestampInput,
	type TaskLifecycleTimestampResolution,
	type TaskLifecycleTimestampSource,
} from "./memory-store-base";
import { StorageError } from "./memory-store-shared";

const commandIdPattern = /^[0-9a-f]{64}$/u;
const timestampSources = new Set<TaskLifecycleTimestampSource>([
	"event_at",
	"session_time",
	"first_resolution",
]);

interface TimestampRow {
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimestampSource | null;
}

function readTimestampRow(row: unknown): TimestampRow | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	const effectiveAtMs = Reflect.get(row, "effectiveAtMs");
	const timeSource = Reflect.get(row, "timeSource");
	if (!Number.isSafeInteger(effectiveAtMs)) return undefined;
	if (timeSource !== null && !timestampSources.has(timeSource as TaskLifecycleTimestampSource)) {
		return undefined;
	}
	return {
		effectiveAtMs: effectiveAtMs as number,
		timeSource: timeSource as TaskLifecycleTimestampSource | null,
	};
}

function validateInput(input: TaskLifecycleTimestampInput): void {
	if (
		input.projectId.trim().length === 0 ||
		!commandIdPattern.test(input.commandId) ||
		!Number.isSafeInteger(input.effectiveAtMs) ||
		!timestampSources.has(input.timeSource)
	) {
		throw new StorageError(
			"Task lifecycle timestamp requires a project, command identity, finite integer time, and source",
		);
	}
}

function isResolution(value: unknown): value is TaskLifecycleTimestampResolution {
	if (typeof value !== "object" || value === null) return false;
	return (
		Number.isSafeInteger(Reflect.get(value, "effectiveAtMs")) &&
		timestampSources.has(Reflect.get(value, "timeSource") as TaskLifecycleTimestampSource) &&
		typeof Reflect.get(value, "created") === "boolean"
	);
}

Object.assign(MemoryStore.prototype, {
	resolveTaskLifecycleTimestamp(
		this: MemoryStoreInternals,
		input: TaskLifecycleTimestampInput,
	): TaskLifecycleTimestampResolution {
		validateInput(input);
		const transaction = this.sqlite.transaction((): TaskLifecycleTimestampResolution => {
			const inserted = readTimestampRow(
				this.sqlite
					.prepare(
						"INSERT OR IGNORE INTO nodix_memory_extraction_timestamps (project_id, replay_key, resolved_at_ms, time_source) VALUES (?, ?, ?, ?) RETURNING resolved_at_ms AS effectiveAtMs, time_source AS timeSource",
					)
					.get(input.projectId, input.commandId, input.effectiveAtMs, input.timeSource),
			);
			if (inserted?.timeSource) {
				return {
					effectiveAtMs: inserted.effectiveAtMs,
					timeSource: inserted.timeSource,
					created: true,
				};
			}

			const existing = readTimestampRow(
				this.sqlite
					.prepare(
						"SELECT resolved_at_ms AS effectiveAtMs, time_source AS timeSource FROM nodix_memory_extraction_timestamps WHERE project_id = ? AND replay_key = ?",
					)
					.get(input.projectId, input.commandId),
			);
			if (!existing) {
				throw new StorageError(
					"Task lifecycle timestamp transaction did not create or find a resolution",
				);
			}
			if (
				existing.timeSource === null ||
				existing.timeSource !== input.timeSource ||
				(existing.timeSource !== "first_resolution" &&
					existing.effectiveAtMs !== input.effectiveAtMs)
			) {
				throw new TaskLifecycleTimestampCollisionError(input.projectId, input.commandId);
			}
			return {
				effectiveAtMs: existing.effectiveAtMs,
				timeSource: existing.timeSource,
				created: false,
			};
		});
		const resolution = transaction.immediate();
		if (!isResolution(resolution)) {
			throw new StorageError("Task lifecycle timestamp transaction returned an invalid result");
		}
		return resolution;
	},
});
