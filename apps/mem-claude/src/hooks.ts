import { performance } from "node:perf_hooks";
import { getSnoProfileDir } from "@snoai/observability";
import {
	appendObserveLedgerRows,
	CODING_SKIN_SESSION_QUERY,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { readCaptureSettings, readRecallSettings } from "./settings.js";
import { ContractError } from "@snoai/memory/client";
import { importReceiptExists, importRepository } from "./import.js";
import type { HostEvent, MemoryClient, ScopeCtx } from "@snoai/memory/client";
import { connectMemory, isDegradedConnection } from "./memory-client.js";
import {
	withinDeadline,
} from "./recall.js";
import { hookScope, workspaceRoot } from "./scope.js";
import { reportSessionActivity } from "./session-activity.js";
import { readSkillRuns } from "./skill-runs.js";
import { startWorkerDetached } from "./worker.js";
import {
	appendSpool,
	readLastSession,
	readSession,
	recordDegraded,
	recordInjection,
	recordInvocation,
	recordLookup,
	recordSkip,
	writeLastSession,
	updateSession,
	writeSession,
} from "./session-state.js";

const baseHookSchema = z.object({
	session_id: z.string().min(1),
	cwd: z.string().min(1),
	agent_id: z.string().optional(),
});
const sessionStartSchema = baseHookSchema.extend({ source: z.enum(["startup", "resume", "clear", "compact", "fork"]), transcript_path: z.string().optional() });
const promptSchema = baseHookSchema.extend({ prompt_id: z.string().min(1), prompt: z.string() });
const sessionEndSchema = baseHookSchema.extend({ transcript_path: z.string().optional(), reason: z.string().optional() });
const toolSchema = baseHookSchema.extend({ tool_use_id: z.string().min(1), tool_name: z.string().min(1), tool_input: z.unknown() });
const postToolSchema = toolSchema.extend({ tool_response: z.unknown() });
const stopSchema = baseHookSchema.extend({ prompt_id: z.string().min(1), last_assistant_message: z.string() });

function emptyEnvelope(event: "SessionStart" | "UserPromptSubmit"): string {
	return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: "" } });
}

function closedReason(error: unknown): string {
	if (error instanceof z.ZodError) return "invalid-input";
	if (error instanceof ContractError || error instanceof Error && error.message.startsWith("settings unavailable:")) return error.message;
	if (error instanceof Error && error.name === "TimeoutError") return "timeout";
	return "engine-failed";
}

async function persistSkip(sessionId: string, event: string, reason: string, started: number): Promise<void> {
	const state = await readSession(sessionId);
	recordSkip(state, event, reason);
	recordInvocation(state, event, performance.now() - started);
	await writeSession(state);
}

/** Every user prompt is reported, even one the recall path skips; a failed report is logged, never hidden. */
async function reportPrompt(client: MemoryClient, scope: ScopeCtx, prompt: string): Promise<void> {
	try {
		await client.hostEvent({ kind: "prompt", prompt }, scope);
	} catch (error) {
		console.error(JSON.stringify({ event: "prompt-submit-observe", reason: closedReason(error) }));
	}
}

export async function sessionStart(raw: unknown): Promise<string> {
	const started = performance.now();
	let sessionId: string | undefined;
	try {
		const recall = readRecallSettings();
		const input = sessionStartSchema.parse(raw);
		sessionId = input.session_id;
		if (input.agent_id !== undefined) {
			await persistSkip(input.session_id, "SessionStart", "subagent", started);
			return emptyEnvelope("SessionStart");
		}
		const { project, state } = await withinDeadline((async () => {
			const project = await workspaceRoot(input.cwd);
			const previous = await readLastSession(project);
			// A fresh session ends the previous one as "new"; /clear is sent from SessionEnd.
			if (input.source === "startup" && previous && previous.sessionId !== input.session_id) {
				try {
					const boundaryClient = await withinDeadline(connectMemory(), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
					if (!isDegradedConnection(boundaryClient)) {
						const ended = await withinDeadline(boundaryClient.onSessionEnd([], {
							...hookScope(project, previous.sessionId),
							host: { sessionId: previous.sessionId, workspace: project, sessionFile: previous.transcriptPath, boundary: "new", at: Date.now() },
						}), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
						if (ended.degraded) console.error(JSON.stringify({ event: "session-boundary", reason: ended.error ?? ended.reason }));
					} else console.error(JSON.stringify({ event: "session-boundary", reason: boundaryClient.error ?? boundaryClient.reason }));
				} catch (error) {
					console.error(JSON.stringify({ event: "session-boundary", reason: closedReason(error) }));
				}
			}
			if (input.transcript_path) await writeLastSession(project, input.session_id, input.transcript_path);
			const state = await readSession(input.session_id);
			if (!await importReceiptExists(project)) await importRepository(project);
			return { project, state };
		})(), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
		const client = await withinDeadline(connectMemory(), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
		if (isDegradedConnection(client)) {
			recordDegraded(state, "SessionStart", client.error ?? client.reason);
			recordInvocation(state, "SessionStart", performance.now() - started);
			await writeSession(state);
			return emptyEnvelope("SessionStart");
		}
		const currentBoundary = input.source === "clear" || input.source === "compact" ? "reset" as const : undefined;
		if (currentBoundary) {
			const ended = await withinDeadline(client.onSessionEnd([], {
				...hookScope(project, input.session_id),
				host: { sessionId: input.session_id, workspace: project, boundary: currentBoundary, at: Date.now() },
			}), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
			if (ended.degraded) recordDegraded(state, "SessionStart", ended.error ?? ended.reason);
		}
		if (!recall.auto) return emptyEnvelope("SessionStart");
		recordLookup(state, "SessionStart");
		const recalled = await withinDeadline(
			client.getRecall(CODING_SKIN_SESSION_QUERY, hookScope(project, input.session_id), { source: "auto", injectionPhase: "session-start", limit: recall.sessionStart.limit, maxChars: recall.sessionStart.maxChars }),
			Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)),
		);
		if (recalled.degraded) recordDegraded(state, "SessionStart", recalled.error ?? recalled.reason);
		else if (recalled.unavailable) recordDegraded(state, "SessionStart", recalled.unavailable);
		const text = recalled.degraded ? "" : recalled.contextText;
		recordInjection(state, "SessionStart", recalled.degraded ? 0 : recalled.memoryIds?.length ?? 0, text.length);
		recordInvocation(state, "SessionStart", performance.now() - started);
		await writeSession(state);
		return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) : emptyEnvelope("SessionStart");
	} catch (error) {
		if (sessionId) {
			try {
				const state = await readSession(sessionId);
				recordDegraded(state, "SessionStart", closedReason(error));
				recordInvocation(state, "SessionStart", performance.now() - started);
				await writeSession(state);
			} catch (receiptError) {
				console.error(JSON.stringify({ event: "receipt-write", reason: closedReason(receiptError) }));
			}
		}
		console.error(JSON.stringify({ event: "session-start", reason: closedReason(error) }));
		return emptyEnvelope("SessionStart");
	}
}

export async function userPromptSubmit(raw: unknown): Promise<string> {
	const started = performance.now();
	let sessionId: string | undefined;
	try {
		const recall = readRecallSettings();
		const input = promptSchema.parse(raw);
		sessionId = input.session_id;
		if (input.agent_id !== undefined) {
			await persistSkip(input.session_id, "UserPromptSubmit", "subagent", started);
			return emptyEnvelope("UserPromptSubmit");
		}
		const project = await workspaceRoot(input.cwd);
		const state = await readSession(input.session_id);
		state.prompts[input.prompt_id] = { prompt: input.prompt, at: Date.now() };
		await writeSession(state);
		const client = await withinDeadline(connectMemory(), Math.max(1, recall.prompt.timeoutMs - (performance.now() - started)));
		if (isDegradedConnection(client)) {
			recordDegraded(state, "UserPromptSubmit", client.error ?? client.reason);
			recordInvocation(state, "UserPromptSubmit", performance.now() - started);
			await writeSession(state);
			return emptyEnvelope("UserPromptSubmit");
		}
		await withinDeadline(reportPrompt(client, hookScope(project, input.session_id), input.prompt),
			Math.max(1, recall.prompt.timeoutMs - (performance.now() - started)));
		if (!recall.auto) return emptyEnvelope("UserPromptSubmit");
		recordLookup(state, "UserPromptSubmit");
		const recalled = await withinDeadline(
			client.getRecall(input.prompt, hookScope(project, input.session_id), { source: "auto", injectionPhase: "prompt", limit: recall.prompt.limit, minScore: recall.prompt.minScore, maxChars: recall.prompt.maxChars }),
			Math.max(1, recall.prompt.timeoutMs - (performance.now() - started)),
		);
		if (recalled.degraded) recordDegraded(state, "UserPromptSubmit", recalled.error ?? recalled.reason);
		else if (recalled.unavailable) recordDegraded(state, "UserPromptSubmit", recalled.unavailable);
		const text = recalled.degraded ? "" : recalled.contextText;
		recordInjection(state, "UserPromptSubmit", recalled.degraded ? 0 : recalled.memoryIds?.length ?? 0, text.length);
		recordInvocation(state, "UserPromptSubmit", performance.now() - started);
		await writeSession(state);
		return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) : emptyEnvelope("UserPromptSubmit");
	} catch (error) {
		if (sessionId) {
			try {
				const state = await readSession(sessionId);
				recordDegraded(state, "UserPromptSubmit", closedReason(error));
				recordInvocation(state, "UserPromptSubmit", performance.now() - started);
				await writeSession(state);
			} catch (receiptError) {
				console.error(JSON.stringify({ event: "receipt-write", reason: closedReason(receiptError) }));
			}
		}
		console.error(JSON.stringify({ event: "user-prompt-submit", reason: closedReason(error) }));
		return emptyEnvelope("UserPromptSubmit");
	}
}

export async function stop(raw: unknown): Promise<void> {
	const started = performance.now();
	let sessionId: string | undefined;
	try {
		readRecallSettings();
		const input = stopSchema.parse(raw);
		if (input.agent_id !== undefined) {
			await persistSkip(input.session_id, "Stop", "subagent", started);
			return;
		}
		if (!readCaptureSettings().ambient) return;
		sessionId = input.session_id;
		const project = await workspaceRoot(input.cwd);
		const state = await readSession(input.session_id);
		const prompt = state.prompts[input.prompt_id]?.prompt.trim() ?? "";
		const assistant = input.last_assistant_message.trim();
		if (!prompt || !assistant) {
			recordSkip(state, "Stop", "empty-turn");
		} else {
			await appendSpool({
				sessionId: input.session_id,
				turnId: input.prompt_id,
				project,
				childCwd: project,
				user: prompt,
				assistant,
				at: Date.now(),
			});
			startWorkerDetached();
		}
		recordInvocation(state, "Stop", performance.now() - started);
		await writeSession(state);
	} catch (error) {
		const reason = closedReason(error);
		console.error(JSON.stringify({ event: "stop", reason }));
		if (sessionId) {
			try {
				const state = await readSession(sessionId);
				recordDegraded(state, "Stop", reason);
				recordInvocation(state, "Stop", performance.now() - started);
				await writeSession(state);
			} catch {
				// The hook still exits successfully when even its receipt cannot be written.
			}
		}
	}
}

function stable(value: unknown): string {
	return value === undefined ? "" : JSON.stringify(value);
}

/** Reports one host fact to the sidecar; the hook exits successfully either way, and a failed report is logged. */
async function reportHostEvent(input: { session_id: string; cwd: string }, hook: string, event: HostEvent): Promise<void> {
	const started = performance.now();
	let sessionId: string | undefined;
	try {
		const recall = readRecallSettings();
		sessionId = input.session_id;
		const project = await workspaceRoot(input.cwd);
		const client = await withinDeadline(connectMemory(), Math.max(1, recall.prompt.timeoutMs - (performance.now() - started)));
		if (isDegradedConnection(client)) {
			await updateSession(input.session_id, (state) => {
				recordDegraded(state, hook, client.error ?? client.reason);
				recordInvocation(state, hook, performance.now() - started);
			});
			return;
		}
		await withinDeadline(client.hostEvent(event, hookScope(project, input.session_id)), Math.max(1, recall.prompt.timeoutMs - (performance.now() - started)));
		await updateSession(input.session_id, (state) => recordInvocation(state, hook, performance.now() - started));
	} catch (error) {
		const reason = closedReason(error);
		console.error(JSON.stringify({ event: hook, reason }));
		if (sessionId) {
			try {
				await updateSession(sessionId, (state) => {
					recordDegraded(state, hook, reason);
					recordInvocation(state, hook, performance.now() - started);
				});
			} catch {
				// The hook still exits successfully when even its receipt cannot be written.
			}
		}
	}
}

export async function preToolUse(raw: unknown): Promise<void> {
	try {
		readRecallSettings();
		const input = toolSchema.parse(raw);
		if (input.agent_id !== undefined) return;
		await updateSession(input.session_id, (state) => {
			state.toolStarts[input.tool_use_id] = Date.now();
		});
	} catch (error) {
		console.error(JSON.stringify({ event: "pre-tool-use", reason: closedReason(error) }));
	}
}

/** One tool.call per PostToolUse; latency is measured from the matching PreToolUse, 0 when none was recorded. */
export async function postToolUse(raw: unknown): Promise<void> {
	let input: z.infer<typeof postToolSchema>;
	try {
		readRecallSettings();
		input = postToolSchema.parse(raw);
		if (input.agent_id !== undefined) return;
	} catch (error) {
		console.error(JSON.stringify({ event: "post-tool-use", reason: closedReason(error) }));
		return;
	}
	let latencyMs = 0;
	try {
		await updateSession(input.session_id, (state) => {
			const startedAt = state.toolStarts[input.tool_use_id];
			if (startedAt === undefined) console.error(JSON.stringify({ event: "post-tool-use", reason: "no-pre-tool-use", tool_use_id: input.tool_use_id }));
			else { latencyMs = Math.max(0, Date.now() - startedAt); delete state.toolStarts[input.tool_use_id]; }
		});
	} catch (error) {
		console.error(JSON.stringify({ event: "post-tool-use", reason: closedReason(error) }));
	}
	await reportHostEvent(input, "PostToolUse", {
		kind: "tool", toolName: input.tool_name, decision: "allow", input: stable(input.tool_input), output: stable(input.tool_response), latencyMs,
	});
}

export async function sessionEnd(raw: unknown): Promise<void> {
	const started = performance.now();
	let sessionId: string | undefined;
	try {
		const recall = readRecallSettings();
		const input = sessionEndSchema.parse(raw);
		sessionId = input.session_id;
		if (input.agent_id !== undefined) {
			await persistSkip(input.session_id, "SessionEnd", "subagent", started);
			return;
		}
		const state = await readSession(input.session_id);
		try {
			const rows = await readSkillRuns(input);
			appendObserveLedgerRows(getSnoProfileDir(), rows.slice(state.skillRunsReported));
			state.skillRunsReported = rows.length;
			await writeSession(state);
		} catch (error) {
			console.error(JSON.stringify({
				event: "skill-runs",
				reason: error instanceof Error ? error.message : String(error),
			}));
		}
		try {
			state.activity = await reportSessionActivity(state.activity, input);
			await writeSession(state);
		} catch (error) {
			console.error(JSON.stringify({
				event: "session-activity",
				reason: error instanceof Error ? error.message : String(error),
				impact: "no session.activity row for this session end; the next send covers the same records",
			}));
		}
		const project = await workspaceRoot(input.cwd);
		const client = await withinDeadline(connectMemory(), Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)));
		if (isDegradedConnection(client)) {
			recordDegraded(state, "SessionEnd", client.error ?? client.reason);
			recordInvocation(state, "SessionEnd", performance.now() - started);
			await writeSession(state);
			return;
		}
		const ended = await withinDeadline(
			client.onSessionEnd([], {
				...hookScope(project, input.session_id),
				host: { sessionId: input.session_id, workspace: project,
					...(input.reason === "clear" ? { boundary: "reset" as const,
						...(input.transcript_path ? { sessionFile: input.transcript_path } : {}), at: Date.now() } : {}) },
			}),
			Math.max(1, recall.sessionStart.timeoutMs - (performance.now() - started)),
		);
		if (ended.degraded) recordDegraded(state, "SessionEnd", ended.error ?? ended.reason);
		recordInvocation(state, "SessionEnd", performance.now() - started);
		await writeSession(state);
	} catch (error) {
		const reason = closedReason(error);
		console.error(JSON.stringify({ event: "session-end", reason }));
		if (sessionId) {
			try {
				const state = await readSession(sessionId);
				recordDegraded(state, "SessionEnd", reason);
				recordInvocation(state, "SessionEnd", performance.now() - started);
				await writeSession(state);
			} catch {
				// The hook still exits successfully when even its receipt cannot be written.
			}
		}
	}
}
