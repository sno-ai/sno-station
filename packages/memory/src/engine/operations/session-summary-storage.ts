/** @file session-summary-storage.ts
 * @purpose Reads session files for reflection and reset discovery.
 * @boundary Read-only session file helpers.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_SESSION_MESSAGE_COUNT } from "../../../config/index";
import { createLogger } from "@snoai/utils/logger";
const diagnosticLog = createLogger("sno-station-mem:session-summary-storage");

export {
	type ReflectionSessionSearchParams,
	resolveReflectionSessionSearchDirs,
} from "./session-reflection-discovery";

/** Implements sort file names by mtime desc as the local session summary storage operation. */
export async function sortFileNamesByMtimeDesc(
	dir: string,
	fileNames: string[],
): Promise<string[]> {
	// Execute the prepared statement after all dynamic values have been normalized.
	const candidates = await Promise.all(
		fileNames.map(async (name) => {
			// Isolate the session memory operation that can fail because of runtime I/O or input shape.
			try {
				const st = await stat(join(dir, name));
				return { name, mtimeMs: st.mtimeMs };
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					diagnosticLog.warn("Session file metadata unavailable", { error },
						{ event_name: "memory.session.file.stat.failed", file: "packages/sno-station-mem/src/engine/operations/session-summary-storage.ts", function: "sortFileNamesByMtimeDesc", site_id: "memory.session.file.stat.failed" });
				}
				// Exclude files that disappear between listing and stat.
				return null;
			}
		}),
	);
	return candidates
		.filter((x): x is { name: string; mtimeMs: number } => x !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
		.map((x) => x.name);
}

/** Implements sanitize file token as the local session summary storage operation. */
export function sanitizeFileToken(value: string, fallback: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return normalized || fallback;
}

/** Extracts text content from raw inputs while tolerating partial data. */
export function extractTextContent(content: unknown): string | null {
	// Guard content here so the remaining session memory path works with normalized inputs.
	if (typeof content === "string") {
		return content;
	}
	// Handle the absent-value case explicitly before the happy path depends on it.
	if (!Array.isArray(content)) {
		return null;
	}
	const parts: string[] = [];
	// Iterate deterministically so session memory output order remains stable.
	for (const item of content) {
		// Guard this branch early so the remaining session memory path works with normalized inputs.
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		// Guard record.text here so the remaining session memory path works with normalized inputs.
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

function parseSessionMessageLine(line: string, diagnostics?: { malformed_count: number }): string | undefined {
	if (!line.trim()) return undefined;
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (parsed.type !== "message") return undefined;
		const message = parsed.message;
		if (!message || typeof message !== "object") return undefined;
		const msg = message as Record<string, unknown>;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") return undefined;
		const text = extractTextContent(msg.content);
		if (!text) return undefined;
		if (text.startsWith("/") || text.includes("<relevant-memories>")) return undefined;
		return `${role}: ${text}`;
	} catch {
		if (diagnostics) diagnostics.malformed_count += 1;
		return undefined;
	}
}

function pushBoundedMessage(messages: string[], message: string, maxMessages: number): void {
	messages.push(message);
	if (messages.length > maxMessages) {
		messages.splice(0, messages.length - maxMessages);
	}
}

/**
 * Reads session messages and applies session summary storage fallback behavior for missing data.
 */
export async function readSessionMessages(
	filePath: string,
	messageCount: number = DEFAULT_SESSION_MESSAGE_COUNT,
): Promise<string | null> {
	const maxMessages =
		Number.isFinite(messageCount) && messageCount > 0
			? Math.floor(messageCount)
			: DEFAULT_SESSION_MESSAGE_COUNT;
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const diagnostics = { malformed_count: 0 };
	try {
		const messages: string[] = [];
		for await (const line of lines) {
			const message = parseSessionMessageLine(line, diagnostics);
			if (message) pushBoundedMessage(messages, message, maxMessages);
		}

		// Treat the empty collection as a first-class outcome instead of widening behavior.
		if (messages.length === 0) return null;
		return messages.join("\n");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Session summary input unavailable", { error, outcome: "partial" },
				{ event_name: "memory.session.read.failed", file: "packages/sno-station-mem/src/engine/operations/session-summary-storage.ts", function: "readSessionMessages", site_id: "memory.session.read.failed" });
		}
		// Missing or unreadable session file means no session summary input.
		return null;
	} finally {
		if (diagnostics.malformed_count > 0) diagnosticLog.warn("Session summary input contains invalid rows", diagnostics,
			{ event_name: "memory.session.rows.invalid", file: "packages/sno-station-mem/src/engine/operations/session-summary-storage.ts", function: "readSessionMessages", site_id: "memory.session.rows.invalid" });
		lines.close();
		stream.destroy();
	}
}

/**
 * Reads session content with reset fallback and applies session summary storage fallback behavior
 * for missing data.
 */
export async function readSessionContentWithResetFallback(
	sessionFilePath: string,
	messageCount: number = DEFAULT_SESSION_MESSAGE_COUNT,
): Promise<string | null> {
	const primary = await readSessionMessages(sessionFilePath, messageCount);
	if (primary) {
		return primary;
	}

	try {
		const dir = dirname(sessionFilePath);
		const sessionFileName = basename(sessionFilePath);
		if (sessionFileName.includes("-topic-")) return null;
		const resetPrefix = `${sessionFileName}.reset.`;
		const files = await readdir(dir);
		const resetCandidates = await sortFileNamesByMtimeDesc(
			dir,
			files.filter((name) => name.startsWith(resetPrefix)),
		);
		if (resetCandidates.length > 0) {
			const latest = resetCandidates[0];
			if (latest) {
				return await readSessionMessages(join(dir, latest), messageCount);
			}
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Session reset fallback unavailable", { error },
				{ event_name: "memory.session.reset.discovery.failed", file: "packages/sno-station-mem/src/engine/operations/session-summary-storage.ts", function: "readSessionContentWithResetFallback", site_id: "memory.session.reset.discovery.failed" });
		}
		// Inaccessible reset directory means no fallback session is available.
		return null;
	}

	return null;
}

/** Implements strip reset suffix as the local session summary storage operation. */
export function stripResetSuffix(fileName: string): string {
	const resetIndex = fileName.indexOf(".reset.");
	if (resetIndex === -1) return fileName;
	return fileName.slice(0, resetIndex);
}

/** Implements find previous session file as the local session summary storage operation. */
export async function findPreviousSessionFile(
	sessionsDir: string,
	currentSessionFile?: string,
	sessionId?: string,
): Promise<string | undefined> {
	try {
		const files = await readdir(sessionsDir);
		const fileSet = new Set(files);
		const currentBaseName = currentSessionFile ? basename(currentSessionFile) : undefined;
		const isCurrentFile = (name: string) => currentBaseName !== undefined && name === currentBaseName;

		const baseFromReset = currentBaseName?.includes(".reset.")
			? stripResetSuffix(currentBaseName)
			: undefined;
		if (baseFromReset && fileSet.has(baseFromReset) && !isCurrentFile(baseFromReset)) {
			return join(sessionsDir, baseFromReset);
		}

		if (sessionId?.trim()) {
			const canonical = `${sessionId.trim()}.jsonl`;
			if (fileSet.has(canonical) && !isCurrentFile(canonical)) {
				return join(sessionsDir, canonical);
			}
			const topics = await sortFileNamesByMtimeDesc(
				sessionsDir,
				files.filter(
						(name) =>
							name.startsWith(`${sessionId.trim()}-topic-`) &&
							name.endsWith(".jsonl") &&
							!name.includes(".reset.") &&
							!isCurrentFile(name),
					),
			);
			const latestTopic = topics[0];
			if (latestTopic) {
				return join(sessionsDir, latestTopic);
			}
		}

	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Previous session discovery failed", { error },
				{ event_name: "memory.session.previous.discovery.failed", file: "packages/sno-station-mem/src/engine/operations/session-summary-storage.ts", function: "findPreviousSessionFile", site_id: "memory.session.previous.discovery.failed" });
		}
		// Missing or inaccessible session directory means no previous session.
		return undefined;
	}

	return undefined;
}
