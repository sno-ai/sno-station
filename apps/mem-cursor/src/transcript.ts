import { readNewLines } from "@snoai/memory/coding-skin";
import { z } from "zod";

/**
 * Where CLI capture stopped in a Cursor transcript: the byte offset read so far, the number of user
 * rows seen (turn ids count them, so a re-read after a failed save repeats the same ids), and the
 * turn still waiting for its end.
 */
export const transcriptCursorSchema = z.object({
	offset: z.number().int().nonnegative(),
	users: z.number().int().nonnegative(),
	pending: z.object({ turnId: z.string(), user: z.string(), assistant: z.string() }).optional(),
});

export type TranscriptCursor = z.infer<typeof transcriptCursorSchema>;

export interface TranscriptTurn {
	turnId: string;
	user: string;
	assistant: string;
}

// Rows seen in IDE 3.23/3.24 and CLI 2026.10.01 transcripts: {"role","message":{"content":[{type:text|tool_use}]}}
// and {"type":"turn_ended","status":"success"|"error"}. A next user row also ends a turn: resumed print runs write no turn_ended.
const rowSchema = z.object({
	type: z.string().optional(),
	status: z.string().optional(),
	role: z.string().optional(),
	message: z.object({ content: z.array(z.unknown()) }).optional(),
});
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

/** The typed text of a user row: what is inside `<user_query>`, else the row without its `<timestamp>`. */
export function userQuery(text: string): string {
	const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
	return (query ? query[1] ?? "" : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
}

/** Folds transcript lines into complete turns; `final` (the conversation ended) completes the turn still open. */
export function foldTranscript(
	cursor: TranscriptCursor,
	lines: readonly string[],
	final: boolean,
): { turns: TranscriptTurn[]; cursor: TranscriptCursor } {
	let { users, pending } = cursor;
	const turns: TranscriptTurn[] = [];
	const finish = (complete: boolean): void => {
		if (pending && complete && pending.user && pending.assistant) turns.push(pending);
		pending = undefined;
	};
	for (const line of lines) {
		let row: z.infer<typeof rowSchema>;
		try { row = rowSchema.parse(JSON.parse(line)); }
		catch {
			console.error(JSON.stringify({ event: "transcript-row", reason: "unparsable", impact: "row skipped" }));
			continue;
		}
		if (row.type === "turn_ended") { finish(row.status === "success"); continue; }
		const text = (row.message?.content ?? []).flatMap(block => {
			const textBlock = textBlockSchema.safeParse(block);
			return textBlock.success ? [textBlock.data.text] : [];
		}).join("\n\n").trim();
		if (row.role === "user") {
			finish(true);
			users += 1;
			pending = { turnId: `u${users}`, user: userQuery(text), assistant: "" };
		} else if (row.role === "assistant" && pending && text) {
			pending = { ...pending, assistant: pending.assistant ? `${pending.assistant}\n\n${text}` : text };
		}
	}
	if (final) finish(true);
	return { turns, cursor: { offset: cursor.offset, users, ...(pending ? { pending } : {}) } };
}

/** Reads the rows after the cursor and returns the turns they complete and the advanced cursor. */
export async function readTurns(
	path: string,
	cursor: TranscriptCursor,
	budgetMs: number,
	final: boolean,
): Promise<{ turns: TranscriptTurn[]; cursor: TranscriptCursor }> {
	const lines: string[] = [];
	const read = await readNewLines(path, cursor.offset, budgetMs, line => lines.push(line));
	const folded = foldTranscript(cursor, lines, final && read.done);
	return { turns: folded.turns, cursor: { ...folded.cursor, offset: read.offset } };
}
