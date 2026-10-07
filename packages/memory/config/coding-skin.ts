import { basename } from "node:path";

export { appendObserveLedgerRows, type ObserveLedgerRow }
	from "../src/engine/telemetry/observe-ledger";
export { SKILL_CATEGORIES, skillVersionFor } from "./skill-categories";
export { HOST_MODEL_CALLBACK_HOST, HOST_MODEL_CALLBACK_PATH } from "./skin-defaults";
export {
	activityCursorSchema,
	EMPTY_ACTIVITY_CURSOR,
	foldActivity,
	isAgentText,
	readNewLines,
	type ActivityCursor,
	type ActivityRecord,
	type SessionActivityPayload,
} from "./session-activity";

export const CODING_SKIN_CHILD_DEADLINE_MS = 110_000;
export const CODING_SKIN_WORKER_LIFETIME_MS: number = 9 * 60_000;
export const CODING_SKIN_RETRY_DELAYS_MS = [2_000, 10_000] as const;
export const CODING_SKIN_MAX_ATTEMPTS = 3;
export const CODING_SKIN_IMPORT_INTERVAL_MS = 2_010;
export const CODING_SKIN_CHILD_MAX_BUFFER_BYTES: number = 8 * 1024 * 1024;
export const CODING_SKIN_MANUAL_SESSION_ID = "manual";

export const CODING_SKIN_SESSION_QUERY =
	"standing decisions, open tasks, conventions and known pitfalls for this repository";
export const CODING_SKIN_LEDGER_MAX_CHARS = 12_000;
export const CODING_SKIN_RECALL_SENTENCE_MAX_CHARS = 200;
export const CODING_SKIN_RECALL_ITEM_MAX_CHARS = 240;

export const CODING_SKIN_HOOKS = {
	SessionStart: { eventName: "session_start", subcommand: "session-start", timeout: 15 },
	UserPromptSubmit: { eventName: "user_prompt_submit", subcommand: "user-prompt-submit", timeout: 8 },
	Stop: { eventName: "stop", subcommand: "stop", timeout: 5 },
	SessionEnd: { eventName: "session_end", subcommand: "session-end", timeout: 8 },
	PreToolUse: { eventName: "pre_tool_use", subcommand: "pre-tool-use", timeout: 5 },
	PostToolUse: { eventName: "post_tool_use", subcommand: "post-tool-use", timeout: 8 },
} as const;

export type CodingSkinHookName = keyof typeof CODING_SKIN_HOOKS;

export const CODING_SKIN_MODEL_COMMANDS = ["recall", "get", "remember", "correct"] as const;

export type CodingSkinHarness = "claude" | "codex";

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command an agent hook runs: the `sno` binary that ran setup, then `memory hook <event> --harness <name>`. */
export function codingSkinHookCommand(snoPath: string, subcommand: string, harness: CodingSkinHarness): string {
	return `${shellQuote(snoPath)} memory hook ${subcommand} --harness ${harness}`;
}

/** True for a hook command of that shape, whatever the path to `sno` is. */
export function isCodingSkinHookCommand(command: string, subcommand: string, harness: CodingSkinHarness): boolean {
	const suffix = ` memory hook ${subcommand} --harness ${harness}`;
	const trimmed = command.trim();
	if (!trimmed.endsWith(suffix)) return false;
	const encoded = trimmed.slice(0, -suffix.length);
	const program = encoded.startsWith("'") && encoded.endsWith("'")
		? encoded.slice(1, -1).replaceAll("'\\''", "'") : encoded;
	return basename(program) === "sno";
}
