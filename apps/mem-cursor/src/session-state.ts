// Adapted from apps/mem-claude/src/session-state.ts: keyed by conversation_id, plus the brief-owed mark,
// IDE prompt/reply pairing by generation_id, the CLI transcript cursor and hook-time activity records.
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ActivityRecord, activityCursorSchema } from "@snoai/memory/coding-skin";
import { z } from "zod";
import { writeJsonAtomic } from "./files.js";
import { sessionPath, spoolDirectory } from "./paths.js";
import { transcriptCursorSchema } from "./transcript.js";

const receiptEventSchema = z.object({
	invocations: z.number().int().nonnegative().default(0),
	lookups: z.number().int().nonnegative().default(0),
	itemsInjected: z.number().int().nonnegative().default(0),
	charsInjected: z.number().int().nonnegative().default(0),
	skips: z.record(z.string(), z.number().int().nonnegative()).default({}),
	degraded: z.record(z.string(), z.number().int().nonnegative()).default({}),
	latencyMs: z.array(z.number().int().nonnegative()).default([]),
});

const activityRecordSchema: z.ZodType<ActivityRecord> = z.object({ ts: z.number(), incoming: z.exactOptional(z.enum(["human", "agent"])) });

const sessionStateSchema = z.object({
	sessionId: z.string().min(1),
	/** Set when the conversation is first seen and at preCompact; cleared when a hook returns the brief. */
	briefOwed: z.boolean().default(true),
	/** IDE: prompt and final reply of each turn, by generation_id, until its stop. */
	prompts: z.record(z.string(), z.object({ prompt: z.string(), at: z.number() })).default({}),
	replies: z.record(z.string(), z.string()).default({}),
	/** IDE: the generation_id of a Reach keep-alive turn, skipped by its stop. */
	keepAliveGeneration: z.string().optional(),
	/** CLI: where transcript capture stopped. */
	transcript: transcriptCursorSchema.optional(),
	/** Where the previous session.activity send stopped. */
	activity: activityCursorSchema.optional(),
	/** Our own hook times since that send; Cursor transcript rows carry no timestamps. */
	activityRecords: z.array(activityRecordSchema).default([]),
	receipt: z.record(z.string(), receiptEventSchema).default({}),
});

export type SessionState = z.infer<typeof sessionStateSchema>;

export async function readSession(sessionId: string): Promise<SessionState> {
	try {
		return sessionStateSchema.parse(JSON.parse(await readFile(sessionPath(sessionId), "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return sessionStateSchema.parse({ sessionId });
		}
		throw error;
	}
}

/** Reads, changes and writes the session file in one short step, so no hook holds it across a sidecar call. */
export async function changeSession(sessionId: string, change: (state: SessionState) => void): Promise<SessionState> {
	const state = await readSession(sessionId);
	change(state);
	await writeJsonAtomic(sessionPath(sessionId), state);
	return state;
}

export function recordInvocation(state: SessionState, event: string, latencyMs: number): void {
	const receipt = state.receipt[event] ?? receiptEventSchema.parse({});
	receipt.invocations += 1;
	receipt.latencyMs.push(Math.max(0, Math.round(latencyMs)));
	state.receipt[event] = receipt;
}

export function recordSkip(state: SessionState, event: string, reason: string): void {
	const receipt = state.receipt[event] ?? receiptEventSchema.parse({});
	receipt.skips[reason] = (receipt.skips[reason] ?? 0) + 1;
	state.receipt[event] = receipt;
}

export function recordDegraded(state: SessionState, event: string, reason: string): void {
	const receipt = state.receipt[event] ?? receiptEventSchema.parse({});
	receipt.degraded[reason] = (receipt.degraded[reason] ?? 0) + 1;
	state.receipt[event] = receipt;
}

export function recordLookup(state: SessionState, event: string): void {
	const receipt = state.receipt[event] ?? receiptEventSchema.parse({});
	receipt.lookups += 1;
	state.receipt[event] = receipt;
}

export function recordInjection(state: SessionState, event: string, items: number, chars: number): void {
	const receipt = state.receipt[event] ?? receiptEventSchema.parse({});
	receipt.itemsInjected += items;
	receipt.charsInjected += chars;
	state.receipt[event] = receipt;
}

export interface SpoolRecord {
	sessionId: string;
	turnId: string;
	project: string;
	user: string;
	assistant: string;
	at: number;
	attempts: number;
	state: "pending" | "failed";
}

export async function appendSpool(record: Omit<SpoolRecord, "attempts" | "state">): Promise<string> {
	const directory = spoolDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${String(record.at).padStart(16, "0")}-${randomUUID()}.json`);
	await writeJsonAtomic(path, { ...record, attempts: 0, state: "pending" });
	return path;
}
