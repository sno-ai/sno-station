/** @file memory-store-suppression-api.ts
 * @purpose Creates the two project-scoped memory suppression shapes.
 * @boundary Storage mechanics only; memory_forget is the sole product caller.
 */

import { createHash } from "node:crypto";
import {
	type MemoryStoreInternals,
	MemoryStore,
	type MemorySuppressionInput,
	type MemorySuppressionResult,
} from "./memory-store-base";
import { StorageError } from "./memory-store-shared";

export function hashMemorySuppressionContent(content: string): string {
	return createHash("sha256").update(content.normalize("NFC"), "utf8").digest("hex");
}

function assertNonEmpty(value: string, name: string): void {
	if (!value.trim()) throw new StorageError(`${name} must not be empty`);
}

Object.assign(MemoryStore.prototype, {
	async createMemorySuppression(
		this: MemoryStoreInternals,
		input: MemorySuppressionInput,
	): Promise<MemorySuppressionResult> {
		assertNonEmpty(input.projectId, "Memory suppression projectId");
		if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
			throw new StorageError("Memory suppression nowMs must be a non-negative safe integer");
		}
		return this.writeMutex.runExclusive(() => {
			if ("content" in input) {
				assertNonEmpty(input.content, "Memory suppression content");
				const result = this.sqlite
					.prepare(
						"INSERT OR IGNORE INTO nodix_memory_suppressions(project_id, subject, attribute, content_hash, created_at) VALUES (?, NULL, NULL, ?, ?)",
					)
					.run(input.projectId, hashMemorySuppressionContent(input.content), input.nowMs) as {
					changes?: number;
				};
				return { created: result.changes === 1, shape: "content", projectId: input.projectId };
			}
			assertNonEmpty(input.subject, "Memory suppression subject");
			assertNonEmpty(input.attribute, "Memory suppression attribute");
			const result = this.sqlite
				.prepare(
					"INSERT OR IGNORE INTO nodix_memory_suppressions(project_id, subject, attribute, content_hash, created_at) VALUES (?, ?, ?, NULL, ?)",
				)
				.run(input.projectId, input.subject, input.attribute, input.nowMs) as {
				changes?: number;
			};
			return { created: result.changes === 1, shape: "key", projectId: input.projectId };
		});
	},
});
