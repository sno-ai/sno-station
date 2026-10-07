import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ActivityCursor,
	type ActivityRecord,
	appendObserveLedgerRows,
	EMPTY_ACTIVITY_CURSOR,
	foldActivity,
	isAgentText,
	readNewLines,
} from "@snoai/memory/coding-skin";
import { detectProjectId, getSnoProfileDir } from "@snoai/observability";
import { z } from "zod";
import { workspaceRoot } from "./scope.js";

/** A hook has seconds; a backlog the budget cannot finish is read by the next send. */
const ACTIVITY_READ_BUDGET_MS = 4_000;

const entrySchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	isMeta: z.boolean().optional(),
	isSidechain: z.boolean().optional(),
	isCompactSummary: z.boolean().optional(),
	entrypoint: z.string().optional(),
	origin: z.object({ kind: z.string() }).optional(),
	message: z.object({ content: z.union([z.string(), z.array(z.unknown())]).optional() }).optional(),
});
const toolResultSchema = z.object({ type: z.literal("tool_result") });
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * Who sent a user entry, from Claude Code 2.1.x transcripts on the owner's machine. Heuristics:
 * an entry the person typed has origin.kind "human" (older entries have no origin and count as
 * typed), but Reach rings and seat starts are typed into the terminal too and are told apart by
 * their text; a session whose entrypoint is "sdk-*" was started by a program, so every prompt in
 * it comes from another agent; a "<teammate-message" (wrapped as "Another Claude session sent a message:") is another
 * Claude session's message. Skill text (isMeta), the compaction or resume summary, local command
 * output, "!" shell commands and their output, the interrupt marker and
 * background-task notices other than a heartbeat tick change nothing.
 */
function incomingOf(entry: z.infer<typeof entrySchema>): ActivityRecord["incoming"] {
	if (entry.type !== "user" || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return undefined;
	const content = entry.message?.content;
	const blocks = Array.isArray(content) ? content : [];
	if (blocks.some(block => toolResultSchema.safeParse(block).success)) return undefined;
	const text = (typeof content === "string" ? content : blocks.flatMap(block => {
		const parsed = textBlockSchema.safeParse(block);
		return parsed.success ? [parsed.data.text] : [];
	}).join("\n")).trimStart();
	if (text.startsWith("<task-notification>")) return isAgentText(text) ? "agent" : undefined;
	if (text.startsWith("<teammate-message") || text.startsWith("Another Claude session sent a message:")) return "agent";
	if (["<local-command-", "<bash-", "[Request interrupted by user"].some(prefix => text.startsWith(prefix))) return undefined;
	if (isAgentText(text) || entry.entrypoint?.startsWith("sdk")) return "agent";
	if (entry.origin !== undefined && entry.origin.kind !== "human") return undefined;
	return "human";
}

export function claudeRecord(line: string): ActivityRecord | undefined {
	const entry = entrySchema.parse(JSON.parse(line));
	if (entry.timestamp === undefined) return undefined;
	const ts = Date.parse(entry.timestamp);
	if (!Number.isFinite(ts)) throw new Error("invalid-transcript-timestamp");
	const incoming = incomingOf(entry);
	return incoming === undefined ? { ts } : { ts, incoming };
}

/** Appends one session.activity row for the transcript records after the cursor, and returns the advanced cursor. SessionEnd closes the run still open. */
export async function reportSessionActivity(
	cursor: ActivityCursor | undefined,
	input: { session_id: string; cwd: string; transcript_path?: string | undefined },
): Promise<ActivityCursor> {
	const from = cursor ?? EMPTY_ACTIVITY_CURSOR;
	const transcriptPath = input.transcript_path ?? join(
		process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
		"projects",
		input.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${input.session_id}.jsonl`,
	);
	const records: ActivityRecord[] = [];
	const read = await readNewLines(transcriptPath, from.offset, ACTIVITY_READ_BUDGET_MS, line => {
		const record = claudeRecord(line);
		if (record) records.push(record);
	});
	// A backlog left unread means the session is not over as far as this send can tell.
	const folded = foldActivity({ ...from, offset: read.offset }, records, read.done);
	if (folded.payload) {
		const projectId = input.cwd ? detectProjectId(await workspaceRoot(input.cwd)) : undefined;
		appendObserveLedgerRows(getSnoProfileDir(), [{
			ts_ms: folded.payload.window_end_ms,
			...(projectId === undefined ? {} : { project_id: projectId }),
			event_type: "session.activity",
			lane: "memory",
			payload: { harness: "claude-code", ...folded.payload },
		}]);
	}
	return folded.cursor;
}
