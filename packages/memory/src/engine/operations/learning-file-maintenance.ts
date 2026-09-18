import { memoryFileWrite, checkMemoryOperation, memoryOperationSignal } from "../operation-cancellation";
import { FIXED_PROTOCOL_VALUE_75 } from "../../model/signed-registry-constants";
import { createLogger } from "@snoai/utils/logger";
const diagnosticLog = createLogger("sno-station-mem:learning-file-maintenance");
/** @file learning-file-maintenance.ts
 * @purpose Manages learning files and skill extraction artifacts for improvement loops.
 * @boundary Filesystem layout, markdown records, and promotion state.
 * @see learning-file-hooks.ts, daily-log-generator.ts, memory-tool-registration.ts.
 */

import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LEARNINGS_TEMPLATE = `# Learnings

Append structured entries:
- LRN-YYYYMMDD-XXX for corrections / best practices / knowledge gaps
- Include summary, details, suggested action, metadata, and status`;

export const DEFAULT_ERRORS_TEMPLATE = `# Errors

Append structured entries:
- ERR-YYYYMMDD-XXX for command/tool/integration failures
- Include symptom, context, probable cause, and prevention`;

export const DEFAULT_FEATURE_REQUESTS_TEMPLATE = `# Feature Requests

Append structured entries:
- FEAT-YYYYMMDD-XXX for missing capabilities or workflow gaps
- Include the requested capability, why it matters, and a concrete suggested action`;

const fileWriteQueues = new Map<string, Promise<void>>();
const FILE_APPEND_LOCK_STALE_MS = 30_000;
const FILE_APPEND_LOCK_RETRY_MS = 25;
type SelfImprovementEntryType = "learning" | "error" | "feature";
type LearningIdPrefix = "LRN" | "ERR" | "FEAT";

const ENTRY_DESTINATIONS: Record<
	SelfImprovementEntryType,
	{ fileName: string; idPrefix: LearningIdPrefix }
> = {
	learning: { fileName: "LEARNINGS.md", idPrefix: "LRN" },
	error: { fileName: "ERRORS.md", idPrefix: "ERR" },
	feature: { fileName: "FEATURE_REQUESTS.md", idPrefix: "FEAT" },
};

/** Implements with file write queue as the local self-improvement learning files operation. */
async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
	const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const lock = new Promise<void>((resolve) => {
		release = resolve;
	});
	const next = previous.then(() => lock);
	fileWriteQueues.set(filePath, next);

	// Await the learning-file writes dependency before deriving downstream state.
	await previous;
	// Isolate the learning-file writes operation that can fail because of runtime I/O or input shape.
	try {
		// Await the learning-file writes dependency before deriving downstream state.
		return await action();
	} finally {
		release?.();
		// Execute the prepared statement after all dynamic values have been normalized.
		if (fileWriteQueues.get(filePath) === next) {
			fileWriteQueues.delete(filePath);
		}
	}
}

/** Implements today ymd as the local self-improvement learning files operation. */
function todayYmd(): string {
	// Centralize the module behavior fallback value at the boundary of this helper.
	return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/** Implements sleep as the local self-improvement learning files operation. */
function sleep(ms: number): Promise<void> {
	// Centralize the module behavior fallback value at the boundary of this helper.
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Implements with append lock as the local self-improvement learning files operation. */
async function withAppendLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
	const lockPath = `${filePath}.lock`;

	// Iterate deterministically so learning-file writes output order remains stable.
	for (;;) {
		checkMemoryOperation();
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		// Isolate the learning-file writes operation that can fail because of runtime I/O or input shape.
		try {
			// Await the learning-file writes dependency before deriving downstream state.
			handle = await open(lockPath, "wx");
			// Isolate the learning-file writes operation that can fail because of runtime I/O or input shape.
			try {
				// Await the learning-file writes dependency before deriving downstream state.
				return await action();
			} finally {
				// Await the learning-file writes dependency before deriving downstream state.
				await handle.close().catch((error: unknown) => {
					diagnosticLog.warn("Learning lock handle close failed", { error },
						{ event_name: "memory.learning.lock.close.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "withAppendLock", site_id: "memory.learning.lock.close.failed" });
				});
				// Await the learning-file writes dependency before deriving downstream state.
				await rm(lockPath, { force: true }).catch((error: unknown) => {
					diagnosticLog.warn("Learning lock cleanup failed", { error },
						{ event_name: "memory.learning.lock.cleanup.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "withAppendLock", site_id: "memory.learning.lock.cleanup.failed" });
				});
			}
		} catch (error) {
			// Guard this branch early so the remaining module behavior path works with normalized inputs.
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
				// Surface this invalid learning-file writes state as an explicit typed failure.
				throw error;
			}

			// Await the learning-file writes dependency before deriving downstream state.
			const lockStats = await stat(lockPath).catch((error: unknown) => {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					diagnosticLog.warn("Learning lock metadata unavailable", { error },
						{ event_name: "memory.learning.lock.stat.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "withAppendLock", site_id: "memory.learning.lock.stat.failed" });
				}
				return null;
			});
			// Guard this branch early so the remaining module behavior path works with normalized inputs.
			if (lockStats && Date.now() - lockStats.mtimeMs > FILE_APPEND_LOCK_STALE_MS) {
				// Await the learning-file writes dependency before deriving downstream state.
				await rm(lockPath, { force: true }).catch((error: unknown) => {
					diagnosticLog.warn("Stale learning lock removal failed", { error },
						{ event_name: "memory.learning.lock.stale.cleanup.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "withAppendLock", site_id: "memory.learning.lock.stale.cleanup.failed" });
				});
				continue;
			}

			await sleep(FILE_APPEND_LOCK_RETRY_MS);
		}
	}
}

/** Implements next learning id as the local self-improvement learning files operation. */
async function nextLearningId(filePath: string, prefix: LearningIdPrefix): Promise<string> {
	const date = todayYmd();
	let count = 0;
	// Isolate the learning-file writes operation that can fail because of runtime I/O or input shape.
	try {
		const content = await readFile(filePath, { encoding: "utf8", signal: memoryOperationSignal() });
		const matches = content.match(new RegExp(`\\[${prefix}-${date}-\\d{3}\\]`, "g"));
		count = matches?.length ?? 0;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Learning identifier history unavailable", { error },
				{ event_name: "memory.learning.history.read.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "nextLearningId", site_id: "memory.learning.history.read.failed" });
		}
		// Missing file means this is the first entry for the day.
	}
	return `${prefix}-${date}-${String(count + 1).padStart(3, "0")}`;
}

function learningFilesDir(baseDir: string): string {
	return join(baseDir, ".learnings");
}

async function ensureLearningFile(filePath: string, content: string): Promise<void> {
	// Isolate the learning-file writes operation that can fail because of runtime I/O or input shape.
	try {
		const existing = await readFile(filePath, { encoding: "utf8", signal: memoryOperationSignal() });
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (existing.trim().length > 0) return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Learning file read failed before creation", { error },
				{ event_name: "memory.learning.ensure.read.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "ensureLearningFile", site_id: "memory.learning.ensure.read.failed" });
		}
		// Missing files are created with the default template below.
	}
	await memoryFileWrite(() => writeFile(filePath, `${content.trim()}\n`, "utf-8"));
}

async function ensureLearningFileWithLock(filePath: string, content: string): Promise<void> {
	await withFileWriteQueue(filePath, async () => {
		await withAppendLock(filePath, async () => {
			await ensureLearningFile(filePath, content);
		});
	});
}

/**
 * Ensures the self-improvement learning directory has the baseline files required by tools.
 */
export async function ensureSelfImprovementLearningFiles(baseDir: string): Promise<void> {
	const learningsDir = learningFilesDir(baseDir);
	checkMemoryOperation();
	await mkdir(learningsDir, { recursive: true });

	await ensureLearningFileWithLock(join(learningsDir, "LEARNINGS.md"), DEFAULT_LEARNINGS_TEMPLATE);
	await ensureLearningFileWithLock(join(learningsDir, "ERRORS.md"), DEFAULT_ERRORS_TEMPLATE);
	await ensureLearningFileWithLock(
		join(learningsDir, "FEATURE_REQUESTS.md"),
		DEFAULT_FEATURE_REQUESTS_TEMPLATE,
	);
}

export interface AppendSelfImprovementEntryParams {
	baseDir: string;
	type: "learning" | "error" | "feature";
	summary: string;
	details?: string;
	suggestedAction?: string;
	category?: string;
	area?: string;
	priority?: string;
	status?: string;
	source?: string;
}

interface NormalizedSelfImprovementEntryParams {
	baseDir: string;
	type: SelfImprovementEntryType;
	summary: string;
	details: string;
	suggestedAction: string;
	category: string;
	area: string;
	priority: string;
	status: string;
	source: string;
}

function normalizeSelfImprovementEntryParams(
	params: AppendSelfImprovementEntryParams,
): NormalizedSelfImprovementEntryParams {
	return {
		baseDir: params.baseDir,
		type: params.type,
		summary: params.summary,
		details: params.details ?? "",
		suggestedAction: params.suggestedAction ?? "",
		category: params.category ?? "best_practice",
		area: params.area ?? "config",
		priority: params.priority ?? "medium",
		status: params.status ?? "pending",
		source: params.source ?? FIXED_PROTOCOL_VALUE_75,
	};
}

function renderSelfImprovementEntry(
	params: NormalizedSelfImprovementEntryParams,
	entryId: string,
	loggedAtIso: string,
): string {
	const titleSuffix = params.type === "learning" ? ` ${params.category}` : "";
	return [
		`## [${entryId}]${titleSuffix}`,
		"",
		`**Logged**: ${loggedAtIso}`,
		`**Priority**: ${params.priority}`,
		`**Status**: ${params.status}`,
		`**Area**: ${params.area}`,
		"",
		"### Summary",
		params.summary.trim(),
		"",
		"### Details",
		params.details.trim() || "-",
		"",
		"### Suggested Action",
		params.suggestedAction.trim() || "-",
		"",
		"### Metadata",
		`- Source: ${params.source}`,
		"---",
		"",
	].join("\n");
}

/**
 * Persists self improvement entry through the single self-improvement learning files write
 * path.
 */
// LH: Self-improvement entries default to the sno-station-mem self-improvement source so generated learnings are traceable.
// LH: File appends are queued and locked because tool calls can run concurrently in the same workspace.
// LH: The source field should remain explicit; future promotion tooling needs to know where a learning originated.
export async function appendSelfImprovementEntry(
	params: AppendSelfImprovementEntryParams,
): Promise<{
	id: string;
	filePath: string;
}> {
	const normalized = normalizeSelfImprovementEntryParams(params);
	await ensureSelfImprovementLearningFiles(normalized.baseDir);
	const destination = ENTRY_DESTINATIONS[normalized.type];
	const filePath = join(learningFilesDir(normalized.baseDir), destination.fileName);

	const id = await withFileWriteQueue(filePath, async () => {
		return withAppendLock(filePath, async () => {
			const entryId = await nextLearningId(filePath, destination.idPrefix);
			const nowIso = new Date().toISOString();
			const entry = renderSelfImprovementEntry(normalized, entryId, nowIso);
			// Await the learning-file writes dependency before deriving downstream state.
			const prev = await readFile(filePath, { encoding: "utf8", signal: memoryOperationSignal() }).catch((error: unknown) => {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					diagnosticLog.warn("Learning file read failed before append", { error },
						{ event_name: "memory.learning.append.read.failed", file: "packages/sno-station-mem/src/engine/operations/learning-file-maintenance.ts", function: "appendSelfImprovementEntry", site_id: "memory.learning.append.read.failed" });
				}
				return "";
			});
			const separator = prev.trimEnd().length > 0 ? "\n\n" : "";
			await memoryFileWrite(() => appendFile(filePath, `${separator}${entry}`, "utf-8"));
			return entryId;
		});
	});

	return { id, filePath };
}
