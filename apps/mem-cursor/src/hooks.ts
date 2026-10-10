// Cursor-format hooks, adapted from apps/mem-claude/src/hooks.ts. Input is Cursor's hook JSON (no cwd,
// keyed by conversation_id); output is `{"additional_context": …}` or `{}`. Every hook exits 0 and logs failures.
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { MemoryClient, ScopeCtx } from "@snoai/memory/client";
import { ContractError } from "@snoai/memory/client";
import {
	appendObserveLedgerRows,
	CODING_SKIN_CURSOR_HOOKS,
	CODING_SKIN_SESSION_QUERY,
	EMPTY_ACTIVITY_CURSOR,
	foldActivity,
	isAgentText,
	type ObserveLedgerRow,
} from "@snoai/memory/coding-skin";
import { detectProjectId, getSnoProfileDir } from "@snoai/observability";
import { z } from "zod";
import { type ConversationRecord, touchConversation } from "./conversation.js";
import { connectMemory, isDegradedConnection } from "./memory-client.js";
import { withinDeadline } from "./recall.js";
import { hookScope } from "./scope.js";
import {
	appendSpool,
	changeSession,
	readSession,
	recordDegraded,
	recordInjection,
	recordInvocation,
	recordLookup,
	recordSkip,
	type SessionState,
} from "./session-state.js";
import { readCaptureSettings, readRecallSettings } from "./settings.js";
import { readTurns } from "./transcript.js";
import { startWorkerDetached } from "./worker.js";

const baseSchema = z.object({
	conversation_id: z.string().min(1),
	generation_id: z.string().optional(),
	model: z.string().optional(),
	workspace_roots: z.array(z.string()).default([]),
	transcript_path: z.string().nullable().default(null),
});
const promptSchema = baseSchema.extend({ prompt: z.string() });
const responseSchema = baseSchema.extend({ text: z.string() });
const stopSchema = baseSchema.extend({ status: z.string() });

type HookName = keyof typeof CODING_SKIN_CURSOR_HOOKS;

const EMPTY = "{}";

/** First line of Reach's keep-alive followup to an idle IDE seat: not the person's prompt, never captured or counted as work. */
const KEEP_ALIVE_LINE = "[Sno Reach keep-alive]";

function isKeepAlive(prompt: string): boolean {
	return prompt.split("\n", 1)[0]?.trimEnd() === KEEP_ALIVE_LINE;
}

function answer(text: string): string {
	return text ? JSON.stringify({ additional_context: text }) : EMPTY;
}

/** The whole budget of a hook, one second short of the timeout Cursor gives it. */
function hookBudgetMs(hook: HookName): number {
	return CODING_SKIN_CURSOR_HOOKS[hook].timeout * 1000 - 1000;
}

function closedReason(error: unknown): string {
	if (error instanceof z.ZodError) return "invalid-input";
	if (error instanceof ContractError || error instanceof Error && error.message.startsWith("settings unavailable:")) return error.message;
	if (error instanceof Error && error.name === "TimeoutError") return "timeout";
	return "engine-failed";
}

function logFailure(hook: HookName, operation: string, error: unknown, impact: string): void {
	console.error(JSON.stringify({ event: hook, operation, reason: closedReason(error), impact }));
}

/** Records a failed hook in its receipt; a receipt that cannot be written is logged and dropped. */
async function recordFailure(conversationId: string | undefined, hook: HookName, error: unknown, started: number): Promise<void> {
	if (!conversationId) return;
	try {
		await changeSession(conversationId, state => {
			recordDegraded(state, hook, closedReason(error));
			recordInvocation(state, hook, performance.now() - started);
		});
	} catch (receiptError) {
		logFailure(hook, "receipt-write", receiptError, "no receipt for this call");
	}
}

/** The conversation's project; null (logged) outside a git work tree, where nothing is injected or captured. */
function projectOf(record: ConversationRecord, hook: HookName): string | null {
	if (!record.project) console.error(JSON.stringify({ event: hook, reason: "no-git-root", root: record.workspace_roots[0] ?? null, impact: "nothing injected or captured" }));
	return record.project;
}

/** Every user prompt is reported, even one the recall path skips; a failed report is logged, never hidden. */
async function reportPrompt(client: MemoryClient, scope: ScopeCtx, prompt: string): Promise<void> {
	try {
		await client.hostEvent({ kind: "prompt", prompt }, scope);
	} catch (error) {
		logFailure("beforeSubmitPrompt", "prompt-observe", error, "prompt not reported to the sidecar");
	}
}

/**
 * Folds the hook times recorded since the last send into one session.activity row. Cursor transcript rows carry no
 * timestamps (apps/mem-claude/src/session-activity.ts would skip every row), so working time comes from our hooks.
 */
function takeActivity(state: SessionState, project: string, closeRun: boolean): ObserveLedgerRow | undefined {
	const folded = foldActivity(state.activity ?? EMPTY_ACTIVITY_CURSOR, state.activityRecords, closeRun);
	state.activity = folded.cursor;
	state.activityRecords = [];
	if (!folded.payload) return undefined;
	return {
		agent_id: "cursor",
		ts_ms: folded.payload.window_end_ms,
		project_id: detectProjectId(project),
		event_type: "session.activity",
		lane: "memory",
		payload: { harness: "cursor", ...folded.payload },
	};
}

function appendActivity(row: ObserveLedgerRow | undefined, hook: HookName): void {
	if (!row) return;
	try { appendObserveLedgerRows(getSnoProfileDir(), [row]); }
	catch (error) { logFailure(hook, "session-activity", error, "no session.activity row for this send"); }
}

/** Recalls through the sidecar; `delivered` is true when the answer did not degrade, even when it is empty. */
async function recall(
	conversationId: string,
	project: string,
	deadlineMs: number,
	query: string,
	boundary: "reset" | undefined,
	options: Parameters<MemoryClient["getRecall"]>[2],
	beforeRecall?: (client: MemoryClient) => Promise<void>,
): Promise<{ text: string; delivered: boolean; items: number; reason?: string }> {
	const started = performance.now();
	const remaining = (): number => Math.max(1, deadlineMs - (performance.now() - started));
	const client = await withinDeadline(connectMemory(), remaining());
	if (isDegradedConnection(client)) return { text: "", delivered: false, items: 0, reason: client.error ?? client.reason };
	await withinDeadline(beforeRecall?.(client) ?? Promise.resolve(), remaining());
	const ask = () => withinDeadline(client.getRecall(query, hookScope(project, conversationId, boundary), options), remaining());
	let recalled = await ask();
	// A sidecar this hook has just started answers "model-preparing" until its embedding model loads (seconds,
	// measured 2026-10-10); print mode has no later prompt, so the brief waits for it within the hook's budget.
	while (!recalled.degraded && recalled.unavailable === "model-preparing" && remaining() > 1_000) {
		await sleep(500);
		recalled = await ask();
	}
	if (recalled.degraded) return { text: "", delivered: false, items: 0, reason: recalled.error ?? recalled.reason };
	// An unavailable answer is not a delivered brief: the mark stays and the next prompt asks again.
	if (recalled.unavailable) return { text: recalled.contextText, delivered: false, items: recalled.memoryIds?.length ?? 0, reason: recalled.unavailable };
	return { text: recalled.contextText, delivered: true, items: recalled.memoryIds?.length ?? 0 };
}

export async function sessionStart(raw: unknown): Promise<string> {
	const started = performance.now();
	let conversationId: string | undefined;
	try {
		const settings = readRecallSettings();
		const input = baseSchema.parse(raw);
		conversationId = input.conversation_id;
		const record = await touchConversation(input, "primary");
		if (!record) return EMPTY;
		const at = Date.now();
		const project = projectOf(record, "sessionStart");
		if (!project || !settings.auto) {
			await changeSession(input.conversation_id, state => {
				state.activityRecords.push({ ts: at });
				if (!project) recordSkip(state, "sessionStart", "no-git-root");
				recordInvocation(state, "sessionStart", performance.now() - started);
			});
			return EMPTY;
		}
		// Print mode has no prompt event, so the brief must arrive here; connect starts a stopped sidecar.
		const result = await recall(input.conversation_id, project,
			hookBudgetMs("sessionStart") - (performance.now() - started), CODING_SKIN_SESSION_QUERY, undefined,
			{ source: "auto", injectionPhase: "session-start", limit: settings.sessionStart.limit, maxChars: settings.sessionStart.maxChars });
		await changeSession(input.conversation_id, state => {
			state.activityRecords.push({ ts: at });
			recordLookup(state, "sessionStart");
			if (result.delivered) state.briefOwed = false;
			if (result.reason) recordDegraded(state, "sessionStart", result.reason);
			recordInjection(state, "sessionStart", result.items, result.text.length);
			recordInvocation(state, "sessionStart", performance.now() - started);
		});
		return answer(result.text);
	} catch (error) {
		logFailure("sessionStart", "brief", error, "no memory brief at conversation start; the first prompt retries it");
		await recordFailure(conversationId, "sessionStart", error, started);
		return EMPTY;
	}
}

export async function userPromptSubmit(raw: unknown): Promise<string> {
	const started = performance.now();
	let conversationId: string | undefined;
	try {
		const settings = readRecallSettings();
		const input = promptSchema.parse(raw);
		conversationId = input.conversation_id;
		const record = await touchConversation(input, "primary");
		if (!record) return EMPTY;
		const generation = input.generation_id;
		if (isKeepAlive(input.prompt)) {
			await changeSession(input.conversation_id, current => {
				current.keepAliveGeneration = generation;
				recordSkip(current, "beforeSubmitPrompt", "keep-alive");
			});
			return EMPTY;
		}
		const state = await changeSession(input.conversation_id, current => {
			current.activityRecords.push({ ts: Date.now(), incoming: isAgentText(input.prompt) ? "agent" : "human" });
			// Only the IDE pairs prompt and reply here; the CLI reads its turns from the transcript.
			if (generation && record.surface === "ide") current.prompts[generation] = { prompt: input.prompt, at: Date.now() };
		});
		const project = projectOf(record, "beforeSubmitPrompt");
		if (!project || !settings.auto) {
			await changeSession(input.conversation_id, current => {
				if (!project) recordSkip(current, "beforeSubmitPrompt", "no-git-root");
				recordInvocation(current, "beforeSubmitPrompt", performance.now() - started);
			});
			return EMPTY;
		}
		// An owed brief (IDE first chat, failed start, or after compaction) arrives here ahead of the per-prompt block;
		// the reset clears this conversation's injection record in the sidecar so the brief's items can come back.
		const owed = state.briefOwed;
		const result = await recall(input.conversation_id, project,
			owed ? hookBudgetMs("beforeSubmitPrompt") - (performance.now() - started) : settings.prompt.timeoutMs,
			input.prompt, owed ? "reset" : undefined,
			owed
				? { source: "auto", injectionPhase: "first-prompt" }
				: { source: "auto", injectionPhase: "prompt", limit: settings.prompt.limit, minScore: settings.prompt.minScore, maxChars: settings.prompt.maxChars },
			client => reportPrompt(client, hookScope(project, input.conversation_id), input.prompt));
		await changeSession(input.conversation_id, current => {
			recordLookup(current, "beforeSubmitPrompt");
			if (owed && result.delivered) current.briefOwed = false;
			if (result.reason) recordDegraded(current, "beforeSubmitPrompt", result.reason);
			recordInjection(current, "beforeSubmitPrompt", result.items, result.text.length);
			recordInvocation(current, "beforeSubmitPrompt", performance.now() - started);
		});
		return answer(result.text);
	} catch (error) {
		logFailure("beforeSubmitPrompt", "recall", error, "nothing injected for this prompt");
		await recordFailure(conversationId, "beforeSubmitPrompt", error, started);
		return EMPTY;
	}
}

/** IDE: keeps the reply of the turn so `stop` can pair it with its prompt by generation_id. */
export async function afterAgentResponse(raw: unknown): Promise<string> {
	try {
		const input = responseSchema.parse(raw);
		if (!await touchConversation(input, "other")) return EMPTY;
		const generation = input.generation_id;
		if (generation) await changeSession(input.conversation_id, state => { state.replies[generation] = input.text; });
	} catch (error) {
		logFailure("afterAgentResponse", "reply-record", error, "this turn's reply is not captured");
	}
	return EMPTY;
}

/** Only records the model Auto picked: under Auto the prompt events say `default`. */
export async function afterAgentThought(raw: unknown): Promise<string> {
	try {
		await touchConversation(baseSchema.parse(raw), "other");
	} catch (error) {
		logFailure("afterAgentThought", "conversation-record", error, "conversation model not updated");
	}
	return EMPTY;
}

/** CLI: spools each complete transcript turn after the saved cursor; `final` also takes the turn still open. */
async function captureTranscript(record: ConversationRecord, project: string, hook: HookName, final: boolean): Promise<number> {
	if (!record.transcript_path) {
		console.error(JSON.stringify({ event: hook, reason: "no-transcript-path", impact: "nothing captured this time" }));
		return 0;
	}
	const before = (await readSession(record.conversation_id)).transcript ?? { offset: 0, users: 0 };
	const read = await readTurns(record.transcript_path, before, hookBudgetMs(hook) / 4, final);
	const turns = read.turns.filter(turn => !isKeepAlive(turn.user));
	for (const turn of turns) {
		await appendSpool({ sessionId: record.conversation_id, turnId: turn.turnId, project, user: turn.user, assistant: turn.assistant, at: Date.now() });
	}
	await changeSession(record.conversation_id, state => { state.transcript = read.cursor; });
	return turns.length;
}

/** IDE: spools the prompt and reply of a completed turn when capture is on; the turn's stored texts are dropped either way. */
async function captureTurn(record: ConversationRecord, project: string, input: z.infer<typeof stopSchema>, ambient: boolean): Promise<number> {
	const generation = input.generation_id ?? "";
	const state = await readSession(record.conversation_id);
	const prompt = state.prompts[generation]?.prompt.trim() ?? "";
	const reply = state.replies[generation]?.trim() ?? "";
	const captured = ambient && input.status === "completed" && prompt !== "" && reply !== "";
	if (captured) await appendSpool({ sessionId: record.conversation_id, turnId: generation, project, user: prompt, assistant: reply, at: Date.now() });
	await changeSession(record.conversation_id, current => {
		delete current.prompts[generation];
		delete current.replies[generation];
		if (!captured) recordSkip(current, "stop", !ambient ? "capture-off" : input.status === "completed" ? "empty-turn" : `status-${input.status}`);
	});
	return captured ? 1 : 0;
}

export async function stop(raw: unknown): Promise<string> {
	const started = performance.now();
	let conversationId: string | undefined;
	try {
		const input = stopSchema.parse(raw);
		conversationId = input.conversation_id;
		const record = await touchConversation(input, "other");
		const project = record && projectOf(record, "stop");
		if (!record || !project) return EMPTY;
		let row: ObserveLedgerRow | undefined;
		let keepAlive = false;
		await changeSession(input.conversation_id, state => {
			keepAlive = state.keepAliveGeneration !== undefined && state.keepAliveGeneration === input.generation_id;
			if (keepAlive) {
				delete state.keepAliveGeneration;
				delete state.replies[input.generation_id ?? ""];
				recordSkip(state, "stop", "keep-alive");
				return;
			}
			state.activityRecords.push({ ts: Date.now() });
			row = takeActivity(state, project, false);
		});
		appendActivity(row, "stop");
		const ambient = readCaptureSettings().ambient;
		if (!keepAlive && (ambient || record.surface === "ide")) {
			const spooled = record.surface === "ide"
				? await captureTurn(record, project, input, ambient)
				: await captureTranscript(record, project, "stop", false);
			if (spooled > 0) startWorkerDetached();
		}
		await changeSession(input.conversation_id, state => recordInvocation(state, "stop", performance.now() - started));
	} catch (error) {
		logFailure("stop", "capture", error, "this turn is not captured now; a CLI turn is read again at the next stop or sessionEnd");
		await recordFailure(conversationId, "stop", error, started);
	}
	return EMPTY;
}

/** Compaction drops what was injected: the next prompt brings the brief back and resets the injection record. */
export async function preCompact(raw: unknown): Promise<string> {
	try {
		const input = baseSchema.parse(raw);
		if (!await touchConversation(input, "other")) return EMPTY;
		await changeSession(input.conversation_id, state => { state.briefOwed = true; });
	} catch (error) {
		logFailure("preCompact", "brief-mark", error, "the brief does not come back after this compaction");
	}
	return EMPTY;
}

export async function sessionEnd(raw: unknown): Promise<string> {
	const started = performance.now();
	let conversationId: string | undefined;
	try {
		const input = baseSchema.parse(raw);
		conversationId = input.conversation_id;
		const record = await touchConversation(input, "end");
		const project = record && projectOf(record, "sessionEnd");
		if (!record || !project) return EMPTY;
		let row: ObserveLedgerRow | undefined;
		await changeSession(input.conversation_id, state => {
			state.activityRecords.push({ ts: Date.now() });
			row = takeActivity(state, project, true);
		});
		appendActivity(row, "sessionEnd");
		if (record.surface === "cli" && readCaptureSettings().ambient) {
			try {
				if (await captureTranscript(record, project, "sessionEnd", true) > 0) startWorkerDetached();
			} catch (error) {
				logFailure("sessionEnd", "capture", error, "turns after the last stop are not captured");
			}
		}
		const remaining = (): number => Math.max(1, hookBudgetMs("sessionEnd") - (performance.now() - started));
		const client = await withinDeadline(connectMemory(), remaining());
		let degraded: string | undefined;
		if (isDegradedConnection(client)) degraded = client.error ?? client.reason;
		else {
			const ended = await withinDeadline(client.onSessionEnd([], hookScope(project, input.conversation_id)), remaining());
			if (ended.degraded) degraded = ended.error ?? ended.reason;
		}
		await changeSession(input.conversation_id, state => {
			if (degraded) recordDegraded(state, "sessionEnd", degraded);
			recordInvocation(state, "sessionEnd", performance.now() - started);
		});
	} catch (error) {
		logFailure("sessionEnd", "session-end", error, "the sidecar is not told this conversation ended");
		await recordFailure(conversationId, "sessionEnd", error, started);
	}
	return EMPTY;
}
