import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "./files.js";
import { conversationPath } from "./paths.js";
import { gitRoot } from "./scope.js";

/** One Cursor conversation, in the shared format of build-contract.md "Conversation record". */
const recordSchema = z.object({
	conversation_id: z.string().min(1),
	surface: z.enum(["ide", "cli"]),
	project: z.string().nullable(),
	workspace_roots: z.array(z.string()),
	model: z.string(),
	model_at: z.string(),
	transcript_path: z.string().nullable(),
	reach_addr: z.string().nullable(),
	first_seen: z.string(),
	last_event: z.string(),
	ended_at: z.string().nullable(),
});

export type ConversationRecord = z.infer<typeof recordSchema>;

export interface CursorEvent {
	conversation_id: string;
	model?: string | undefined;
	workspace_roots: string[];
	transcript_path: string | null;
}

/** `primary` events (sessionStart, beforeSubmitPrompt) may open a record; `end` is sessionEnd. */
export type EventKind = "primary" | "other" | "end";

/** `cli` when the hook runs under the Cursor CLI (it sets CURSOR_INVOKED_AS), else the IDE. */
export function cursorSurface(env: NodeJS.ProcessEnv): "ide" | "cli" {
	return env["CURSOR_INVOKED_AS"] ? "cli" : "ide";
}

const UNNAMED_MODELS = new Set(["", "default", "auto"]);

/** The record after one event: a named model replaces any model, `default`/`auto` never replaces a named one. */
export function nextRecord(
	previous: ConversationRecord | undefined,
	event: CursorEvent,
	kind: EventKind,
	project: string | null,
	now: string,
	env: NodeJS.ProcessEnv,
): ConversationRecord {
	const base: ConversationRecord = previous ?? {
		conversation_id: event.conversation_id,
		surface: cursorSurface(env),
		project,
		workspace_roots: event.workspace_roots,
		model: "default",
		model_at: now,
		transcript_path: null,
		reach_addr: null,
		first_seen: now,
		last_event: now,
		ended_at: null,
	};
	const model = event.model ?? "";
	return {
		...base,
		project: base.project ?? project,
		workspace_roots: event.workspace_roots.length > 0 ? event.workspace_roots : base.workspace_roots,
		...(UNNAMED_MODELS.has(model) ? {} : { model, model_at: now }),
		transcript_path: event.transcript_path ?? base.transcript_path,
		reach_addr: env["SNO_REACH_ADDR"] || base.reach_addr,
		last_event: now,
		// A resumed conversation is live again.
		ended_at: kind === "end" ? now : kind === "primary" ? null : base.ended_at,
	};
}

async function readRecord(conversationId: string): Promise<ConversationRecord | undefined> {
	try {
		return recordSchema.parse(JSON.parse(await readFile(conversationPath(conversationId), "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes the record for this event and returns it. A conversation first seen on a non-primary event
 * gets no record and returns undefined: subagent conversations never have sessionStart or
 * beforeSubmitPrompt (PRD T1 item 2), so nothing of theirs is captured.
 */
export async function touchConversation(event: CursorEvent, kind: EventKind): Promise<ConversationRecord | undefined> {
	const previous = await readRecord(event.conversation_id);
	if (!previous && kind !== "primary") return undefined;
	const first = event.workspace_roots[0];
	// A conversation first seen without a git root picks one up when a later event brings one.
	const project = previous?.project ?? (first ? await gitRoot(first) : null);
	const record = nextRecord(previous, event, kind, project, new Date().toISOString(), process.env);
	await writeJsonAtomic(conversationPath(event.conversation_id), record);
	return record;
}
