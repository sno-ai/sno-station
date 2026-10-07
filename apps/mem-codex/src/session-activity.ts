import { glob, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CODING_SKIN_HOOKS,
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

/** A quarter of the Stop hook's timeout, so reading, the ledger write and the rest of the step stay within half of it; a backlog the budget cannot finish is read by the next send. */
const ACTIVITY_READ_BUDGET_MS = CODING_SKIN_HOOKS.Stop.timeout * 1000 / 4;

const metaSchema = z.object({
	type: z.literal("session_meta"),
	payload: z.object({ source: z.unknown() }),
});
const lineSchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	payload: z.object({
		type: z.string().optional(),
		item: z.object({ type: z.string(), content: z.array(z.unknown()).optional() }).optional(),
	}).optional(),
});
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * A Codex session the person opened (session_meta.source "cli" or "vscode") is interactive; one
 * started by `codex exec`, a sub-agent spawn or MCP (source "exec", an object, "mcp") was started
 * by another agent. Seen on the owner's machine with Codex 0.160: "cli", "exec" and sub-agent objects.
 */
async function startedByAgent(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		// The first line holds the session metadata plus the base instructions text; read it whole, however long.
		const parts: Buffer[] = [];
		for (let position = 0; ;) {
			const chunk = Buffer.alloc(65_536);
			const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			const end = chunk.subarray(0, bytesRead).indexOf(10);
			parts.push(chunk.subarray(0, end === -1 ? bytesRead : end));
			if (end !== -1) break;
		}
		const meta = metaSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
		return meta.payload.source !== "cli" && meta.payload.source !== "vscode";
	} finally {
		await file.close();
	}
}

/**
 * Only the UserMessage item of a turn counts as an incoming message: the matching "message" entry
 * with role user also holds the injected AGENTS.md, environment and skill text, and the compacted
 * record re-lists earlier user messages, so neither is read. A Reach ring is a UserMessage too and
 * is told apart by its text (heuristic).
 */
export function codexRecord(line: string, agentStarted: boolean): ActivityRecord | undefined {
	const entry = lineSchema.parse(JSON.parse(line));
	if (entry.timestamp === undefined) return undefined;
	const ts = Date.parse(entry.timestamp);
	if (!Number.isFinite(ts)) throw new Error("invalid-rollout-timestamp");
	const item = entry.payload?.item;
	if (entry.type !== "event_msg" || entry.payload?.type !== "item_completed" || item?.type !== "UserMessage") return { ts };
	const text = (item.content ?? []).flatMap(block => {
		const parsed = textBlockSchema.safeParse(block);
		return parsed.success ? [parsed.data.text] : [];
	}).join("\n");
	return { ts, incoming: agentStarted || isAgentText(text) ? "agent" : "human" };
}

async function findRollout(sessionId: string): Promise<string> {
	const sessions = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "sessions");
	for await (const file of glob("*/*/*/rollout-*.jsonl", { cwd: sessions })) {
		if (file.endsWith(`-${sessionId}.jsonl`)) return join(sessions, file);
	}
	throw new Error("rollout-missing");
}

/** Appends one session.activity row for the rollout records after the cursor, and returns the advanced cursor. Stop does not end the run still open. */
export async function reportSessionActivity(
	cursor: ActivityCursor | undefined,
	input: { session_id: string; cwd: string },
): Promise<ActivityCursor> {
	const from = cursor ?? EMPTY_ACTIVITY_CURSOR;
	const path = from.path ?? await findRollout(input.session_id);
	const agentStarted = await startedByAgent(path);
	const records: ActivityRecord[] = [];
	const read = await readNewLines(path, from.offset, ACTIVITY_READ_BUDGET_MS, line => {
		const record = codexRecord(line, agentStarted);
		if (record) records.push(record);
	});
	const folded = foldActivity({ ...from, offset: read.offset, path }, records, false);
	if (folded.payload) {
		const projectId = input.cwd ? detectProjectId(await workspaceRoot(input.cwd)) : undefined;
		appendObserveLedgerRows(getSnoProfileDir(), [{
			ts_ms: folded.payload.window_end_ms,
			...(projectId === undefined ? {} : { project_id: projectId }),
			event_type: "session.activity",
			lane: "memory",
			payload: { harness: "codex", ...folded.payload },
		}]);
	}
	return folded.cursor;
}
