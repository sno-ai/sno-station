import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "./files.js";
import { appStateRoot, sessionPath, spoolDirectory } from "./paths.js";

const lastSessionSchema = z.object({ sessionId: z.string().min(1), transcriptPath: z.string().min(1) });

function lastSessionPath(project: string): string {
	return join(appStateRoot(), "last-session", `${createHash("sha256").update(project).digest("hex")}.json`);
}

export async function readLastSession(project: string): Promise<z.infer<typeof lastSessionSchema> | undefined> {
	try {
		return lastSessionSchema.parse(JSON.parse(await readFile(lastSessionPath(project), "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeLastSession(project: string, sessionId: string, transcriptPath: string): Promise<void> {
	await writeJsonAtomic(lastSessionPath(project), { sessionId, transcriptPath });
}

const receiptEventSchema = z.object({
	invocations: z.number().int().nonnegative().default(0),
	lookups: z.number().int().nonnegative().default(0),
	itemsInjected: z.number().int().nonnegative().default(0),
	charsInjected: z.number().int().nonnegative().default(0),
	skips: z.record(z.string(), z.number().int().nonnegative()).default({}),
	degraded: z.record(z.string(), z.number().int().nonnegative()).default({}),
	resets: z.number().int().nonnegative().default(0),
	latencyMs: z.array(z.number().int().nonnegative()).default([]),
});

const sessionStateSchema = z.object({
	sessionId: z.string().min(1),
	skillRunsReported: z.number().int().nonnegative().default(0),
	prompts: z.record(z.string(), z.object({ prompt: z.string(), at: z.number() })).default({}),
	receipt: z.record(z.string(), receiptEventSchema).default({}),
	/** PreToolUse arrival time by tool_use_id, consumed by PostToolUse to measure the call. */
	toolStarts: z.record(z.string(), z.number()).default({}),
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

export async function writeSession(state: SessionState): Promise<void> {
	await writeJsonAtomic(sessionPath(state.sessionId), state);
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
	childCwd: string;
	user: string;
	assistant?: string;
	kind?: "turn" | "import";
	importReceipt?: { path: string; file: string };
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
