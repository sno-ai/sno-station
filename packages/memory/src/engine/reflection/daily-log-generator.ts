import { memoryFileWrite, checkMemoryOperation, memoryOperationSignal } from "../operation-cancellation";
import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:daily-log-generator");
/** @file daily-log-generator.ts
 * @purpose Runs reflection analysis and writes durable improvement-oriented records.
 * @boundary LLM prompts, reflection stores, retry handling, and learning extraction.
 * @see strategy-hook-runner.ts, memory-entry-projector.ts, learning-file-maintenance.ts.
 */

import { randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { REFLECTION_MAX_FILENAME_ATTEMPTS } from "../../../config/index";
import { RESOURCES_BY_LOCALE } from "../i18n/all-resources";
import { resolveLocale } from "../i18n/resolver";
import {
	extractTextContent,
	sanitizeFileToken,
	sortFileNamesByMtimeDesc,
} from "../operations/session-summary-storage";
import { prepareReflectionPromptInputs } from "./reflection-prompt-input";
import { runWithReflectionTransientRetryOnce } from "./transient-generation-retry";
import type { ReflectionErrorSignal } from "../security/error-signals";
import { sha256Hex } from "../security/error-signals";
import { redactSecrets } from "../security/redact";

// Re-export from canonical location so existing consumers (e.g. tests)
// that import extractTextContent from "@/reflection/daily-log-generator" continue to work.
export { extractTextContent };

export const REFLECTION_FALLBACK_MARKER =
	"(fallback) Reflection generation failed; storing minimal pointer only.";

const USER_SKIP_MARKERS = ["<relevant-memories>", "UNTRUSTED DATA", "END UNTRUSTED DATA"];

// Pure helpers used by reflection parsing and tests.

/**
 * Tests whether should skip reflection message without mutating reflection capture policy state.
 */
export function shouldSkipReflectionMessage(role: string, text: string): boolean {
	const trimmed = text.trim();
	// Guard this branch early so the remaining reflection capture path works with normalized inputs.
	if (!trimmed) return true;
	// Keep this reflection capture predicate close to the branch that owns the match semantics.
	if (trimmed.startsWith("/")) return true;
	// Keep this reflection capture predicate close to the branch that owns the match semantics.
	if (role === "user" && USER_SKIP_MARKERS.some((m) => trimmed.includes(m))) {
		// Centralize the reflection capture fallback value at the boundary of this helper.
		return true;
	}
	// Centralize the reflection capture fallback value at the boundary of this helper.
	return false;
}

// Session readers normalize JSONL transcripts into reflection input.

/**
 * Reads session conversation for reflection and applies reflection capture policy fallback
 * behavior for missing data.
 */
export async function readSessionConversationForReflection(
	filePath: string,
	messageCount: number,
): Promise<string | null> {
	void messageCount;
	// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
	try {
		// Await the reflection capture dependency before deriving downstream state.
		const lines = (await readFile(filePath, { encoding: "utf8", signal: memoryOperationSignal() })).trim().split("\n");
		const messages: string[] = [];

		// Iterate deterministically so reflection capture output order remains stable.
		for (const line of lines) {
			// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
			try {
				// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
				const entry = JSON.parse(line) as Record<string, unknown>;
				// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
				if (entry.type !== "message" || !entry.message) continue;
				// SDK message object — safe boundary cast
				const msg = entry.message as Record<string, unknown>;
				const role = typeof msg.role === "string" ? msg.role : "";
				// Guard this branch early so the remaining reflection capture path works with normalized inputs.
				if (role !== "user" && role !== "assistant") continue;

				const text = extractTextContent(msg.content);
				// Handle the absent-value case explicitly before the happy path depends on it.
				if (!text || shouldSkipReflectionMessage(role, text)) continue;
				// Append only after validation has accepted this value for the current branch.
				messages.push(`${role}: ${redactSecrets(text)}`);
			} catch {
				// Skip malformed JSONL lines.
			}
		}

		// Treat the empty collection as a first-class outcome instead of widening behavior.
		if (messages.length === 0) return null;
		// Centralize the reflection capture fallback value at the boundary of this helper.
		return messages.join("\n");
	} catch {
		// Missing or unreadable session file means no reflection input.
		return null;
	}
}

/**
 * Reads session conversation with reset fallback and applies reflection capture policy fallback
 * behavior for missing data.
 */
export async function readSessionConversationWithResetFallback(
	sessionFilePath: string,
	messageCount: number,
): Promise<string | null> {
	// Await the reflection capture dependency before deriving downstream state.
	const primary = await readSessionConversationForReflection(sessionFilePath, messageCount);
	// Guard this branch early so the remaining reflection capture path works with normalized inputs.
	if (primary) return primary;

	// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
	try {
		const dir = dirname(sessionFilePath);
		const resetPrefix = `${basename(sessionFilePath)}.reset.`;
		// Await the reflection capture dependency before deriving downstream state.
		const files = await readdir(dir);
		// Await the reflection capture dependency before deriving downstream state.
		const candidates = await sortFileNamesByMtimeDesc(
			dir,
			files.filter((name) => name.startsWith(resetPrefix)),
		);
		const latest = candidates[0];
		// Guard guard condition here so the remaining reflection capture path works with normalized inputs.
		if (latest) {
			// Await the reflection capture dependency before deriving downstream state.
			return await readSessionConversationForReflection(join(dir, latest), messageCount);
		}
	} catch {
		// Reset file directory is optional; return the primary result on read failure.
	}

	// Centralize the reflection capture fallback value at the boundary of this helper.
	return primary;
}

// Prompt builders keep reflection output structured for downstream slicing.

/**
 * Assembles reflection prompt from validated inputs for deterministic reflection capture policy.
 *
 * Locale-aware: resolves the conversation's locale and dispatches to the
 * matching `i18n/res/<locale>/reflection-prompts.ts` builder.
 */
export function buildReflectionPrompt(
	conversation: string,
	maxInputChars: number,
	toolErrorSignals: ReflectionErrorSignal[] = [],
): string {
	const locale = resolveLocale({ text: conversation });
	return RESOURCES_BY_LOCALE[locale].reflectionPrompts.buildReflectionPrompt(
		conversation,
		maxInputChars,
		toolErrorSignals,
	);
}

/**
 * Assembles reflection fallback text from validated inputs for deterministic reflection capture
 * policy.
 *
 * Locale-aware: optional `conversation` text seeds locale resolution; absent
 * input defaults to the system default locale.
 */
export function buildReflectionFallbackText(conversation = ""): string {
	const locale = resolveLocale({ text: conversation });
	return RESOURCES_BY_LOCALE[locale].reflectionPrompts.buildReflectionFallbackText();
}

// Reflection generation wraps the configured model with fallback persistence.

export type ReflectionGenerator = (prompt: string, timeoutMs: number) => Promise<string | null>;

export type ReflectionResult = {
	text: string;
	usedFallback: boolean;
	promptHash: string;
	error?: string;
};

/** Implements generate reflection text as the local reflection capture policy operation. */
// LH: Reflection generation uses a two-tier strategy: host AI SDK when available, then deterministic template fallback.
// LH: No embedded PI runner is required in the active path, keeping reflection portable inside the plugin runtime.
// LH: Retry behavior is dependency-injected so tests can exercise transient handling without sleeping or calling services.
// LH: The fallback text preserves operational usefulness when model generation is unavailable.
export async function generateReflectionText(params: {
	conversation: string;
	maxInputChars: number;
	timeoutMs: number;
	toolErrorSignals?: ReflectionErrorSignal[];
	generate: ReflectionGenerator;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<ReflectionResult> {
	const promptInputs = prepareReflectionPromptInputs(params.conversation, params.maxInputChars);
	if (promptInputs.length === 0) {
		return {
			text: buildReflectionFallbackText(params.conversation),
			usedFallback: true,
			promptHash: sha256Hex(""),
			error: "empty reflection input",
		};
	}
	const prompts: string[] = [];
	const outputs: string[] = [];
	/** Implements on retry log as the local reflection capture policy operation. */
	const onRetryLog = (level: "info" | "warn", message: string) => {
		// Guard this branch early so the remaining reflection capture path works with normalized inputs.
		if (level === "warn") diagnosticLog.warn("Reflection generation retry reported", { error: message }, { event_name: "memory.daily_log_generator.reflection.generation.retry.reported", file: "packages/sno-station-mem/src/engine/reflection/daily-log-generator.ts", function: "onRetryLog", site_id: "reflection.daily-log-generator.onRetryLog.b52810f5af" });
		else diagnosticLog.info("Reflection generation retry reported", { error: message }, { event_name: "memory.daily_log_generator.reflection.generation.retry.reported", file: "packages/sno-station-mem/src/engine/reflection/daily-log-generator.ts", function: "onRetryLog", site_id: "reflection.daily-log-generator.onRetryLog.977c99d43c" });
	};

	for (const promptInput of promptInputs) {
		const prompt = buildReflectionPrompt(
			promptInput,
			params.maxInputChars,
			params.toolErrorSignals ?? [],
		);
		prompts.push(prompt);
		const promptHash = sha256Hex(prompts.join("\n\n--- chunk ---\n\n"));
		const retryState = { count: 0 };
		// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
		try {
			const text = await runWithReflectionTransientRetryOnce({
				scope: "reflection",
				runner: "embedded",
				retryState,
				onLog: onRetryLog,
				/** Executes the registered command after SDK argument validation and shared safety checks. */
				execute: async () => params.generate(prompt, params.timeoutMs),
			});
			// Guard text here so the remaining reflection capture path works with normalized inputs.
			if (text && text.trim().length > 0) {
				outputs.push(text.trim());
				continue;
			}
		} catch (err) {
			const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			// This reflection capture step establishes state that later reads and cleanup paths depend on.
			diagnosticLog.warn("Reflection generation failed", { error: err }, { event_name: "memory.daily_log_generator.reflection.generation.failed", file: "packages/sno-station-mem/src/engine/reflection/daily-log-generator.ts", function: "generateReflectionText", site_id: "reflection.daily-log-generator.generateReflectionText.c0c554e65c" });
			return {
				text: buildReflectionFallbackText(params.conversation),
				usedFallback: true,
				promptHash,
				error: errMsg,
			};
		}
		// Guard text here so the remaining reflection capture path works with normalized inputs.
		return {
			text: buildReflectionFallbackText(params.conversation),
			usedFallback: true,
			promptHash,
			error: "generate returned empty text",
		};
	}

	return {
		text: outputs.join("\n\n"),
		usedFallback: false,
		promptHash: sha256Hex(prompts.join("\n\n--- chunk ---\n\n")),
	};
}

// PRD §3 / Step 2.5: v2 storeReflection + extractReflectionSlices removed.
// Production reflections now flow through memory-entry-projector.ts:storeReflectionEntries
// (layered v3) + the §4.2 mapped-memory loop in strategy-hook-runner.ts. v2 helpers
// are deleted, not deprecated — typecheck on this file is the oracle that proves
// nothing in src/ still depends on the v2 path.

// Filesystem output mirrors stored reflections into workspace-readable logs.

/** Validates daily log file before it enters the reflection capture policy boundary. */
export async function ensureDailyLogFile(dailyPath: string, dateStr: string): Promise<void> {
	const temporaryPath = `${dailyPath}.${randomUUID()}.tmp`;
	try {
		await memoryFileWrite(() => writeFile(temporaryPath, `# ${dateStr}\n\n`, { encoding: "utf-8", flag: "wx" }));
		try {
			await link(temporaryPath, dailyPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	} finally {
		await unlink(temporaryPath).catch(error => {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		});
	}
}

export type WriteReflectionFsParams = {
	workspaceDir: string;
	reflectionText: string;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
	toolErrorSignals: ReflectionErrorSignal[];
	nowTs: number;
};

/**
 * Persists reflection to filesystem through the single reflection capture policy write path.
 */
export async function writeReflectionToFilesystem(
	params: WriteReflectionFsParams,
): Promise<string> {
	const date = new Date(params.nowTs);
	const dateStr = date.toISOString().split("T")[0] ?? "";
	const timeHms = date.toISOString().split("T")[1]?.split(".")[0] ?? "";
	const timeCompact = timeHms.replace(/:/g, "");

	const header = [
		`# Reflection: ${dateStr} ${timeHms} UTC`,
		"",
		`- Session Key: ${params.sessionKey}`,
		`- Session ID: ${params.sessionId}`,
		`- Command: ${params.command}`,
		`- Error Signatures: ${params.toolErrorSignals.length ? params.toolErrorSignals.map((s) => s.signatureHash).join(", ") : "(none)"}`,
		"",
	].join("\n");
	// Compute the normalized body once so later reflection capture checks use one value.
	const body = `${header}${params.reflectionText.trim()}\n`;

	// Compute the normalized out dir once so later reflection capture checks use one value.
	const outDir = join(params.workspaceDir, "memory", "reflections", dateStr);
	checkMemoryOperation();
	await mkdir(outDir, { recursive: true });

	// Compute the normalized agent token once so later reflection capture checks use one value.
	const agentToken = sanitizeFileToken(params.agentId, "agent");
	const sessionToken = sanitizeFileToken(params.sessionId, "session");

	// Iterate deterministically so reflection capture output order remains stable.
	for (let attempt = 0; attempt < REFLECTION_MAX_FILENAME_ATTEMPTS; attempt++) {
		const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 8)}`;
		// Compute the normalized file name once so later reflection capture checks use one value.
		const fileName = `${timeCompact}-${agentToken}-${sessionToken}${suffix}.md`;
		// Compute the normalized rel path once so later reflection capture checks use one value.
		const relPath = join("memory", "reflections", dateStr, fileName);
		// Compute the normalized abs path once so later reflection capture checks use one value.
		const absPath = join(params.workspaceDir, relPath);
		// Isolate the reflection capture operation that can fail because of runtime I/O or input shape.
		try {
			await memoryFileWrite(() => writeFile(absPath, body, { encoding: "utf-8", flag: "wx" }));
			// Link each generated reflection from the daily workspace summary.
			const dailyPath = join(params.workspaceDir, "memory", `${dateStr}.md`);
			await ensureDailyLogFile(dailyPath, dateStr);
			await memoryFileWrite(() => appendFile(
				dailyPath,
				`- [${timeHms} UTC] Reflection generated: \`${relPath}\`\n`,
				"utf-8",
			));
			return relPath;
		} catch (err: unknown) {
			// Only EEXIST is retryable during unique filename allocation.
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code: string }).code === "EEXIST"
			)
				continue;
			// Surface this invalid reflection capture state as an explicit typed failure.
			throw err;
		}
	}
	// Surface this invalid reflection capture state as an explicit typed failure.
	throw new Error(`Failed to allocate unique reflection file for ${dateStr} ${timeCompact}`);
}

// PRD §3 / Step 2.5: v2 parseSectionBullets + extractReflectionSlices removed
// from this module. The slice/section helpers live in markdown-slice-parser.ts and
// are used by the layered v3 store + the §4.2 mapped-memory loop.
