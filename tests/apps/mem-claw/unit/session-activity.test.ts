import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRuntimeHooks } from "../../../../apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

type Handler = (event: unknown, context: unknown) => Promise<unknown>;
let root: string;
let handlers: Map<string, Handler>;
const context = { sessionId: "session-a", sessionKey: "agent:main:session-a" };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "claw-activity-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	writeSettingsFixture(root, { recall: { auto: false } });
	handlers = new Map();
	const api = { config: {}, registerHook: () => {}, on: (name: string, handler: Handler) => handlers.set(name, handler) };
	const connection = { ready: async () => { throw new Error("memory offline"); } };
	const observe = { startObserveSession: async () => {}, finalizeObserveSession: async () => {} };
	registerRuntimeHooks(api as never, { sessionStrategy: "none" } as never, connection as never, observe as never, {} as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function turn(prompt: string, session = context): Promise<void> {
	await handlers.get("before_prompt_build")?.({ prompt }, session);
	vi.setSystemTime(1_800_000_060_000);
	await handlers.get("agent_end")?.({ success: true, messages: [] }, session);
}
function rows(): Record<string, unknown>[] {
	const path = join(root, "observe", "ledger.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

it("records a human turn even when memory capture is unavailable", async () => {
	await turn("Fix the failing command");
	expect(rows().map(({ agent_id, event_type, lane, ts_ms, payload }) => ({ agent_id, event_type, lane, ts_ms, payload }))).toEqual([{
		agent_id: "openclaw", event_type: "session.activity", lane: "memory", ts_ms: 1_800_000_060_000,
		payload: { harness: "openclaw", window_start_ms: 1_800_000_000_000, window_end_ms: 1_800_000_060_000,
			active_ms: 60_000, team_driven_ms: 0, runs_over_12h: 0, longest_run_ms: 60_000, human_messages: 1 },
	}]);
});
it("counts the whole forty-minute turn as working time", async () => {
	await handlers.get("before_prompt_build")?.({ prompt: "Fix the failing command" }, context);
	vi.setSystemTime(1_800_002_400_000);
	await handlers.get("agent_end")?.({ success: true, messages: [] }, context);
	expect(rows().map(row => row.payload)).toEqual([{
		harness: "openclaw", window_start_ms: 1_800_000_000_000, window_end_ms: 1_800_002_400_000,
		active_ms: 2400000, team_driven_ms: 0, runs_over_12h: 0, longest_run_ms: 2400000, human_messages: 1,
	}]);
});
it.each([
	["typed by the mail transport, not by the owner", "agent:main:session-a"],
	["Run the assigned task", "agent:main:sno-oneshot-task"],
])("counts agent input %s", async (prompt, sessionKey) => {
	await turn(prompt, { ...context, sessionKey });
	expect(rows().map(row => row.payload)).toEqual([{
		harness: "openclaw", window_start_ms: 1_800_000_000_000, window_end_ms: 1_800_000_060_000,
		active_ms: 60_000, team_driven_ms: 60_000, runs_over_12h: 0, longest_run_ms: 60_000, human_messages: 0,
	}]);
});
it("continues the turn after a ledger write fails", async () => {
	let diagnostic = "";
	vi.spyOn(process.stderr, "write").mockImplementation(chunk => { diagnostic += String(chunk); return true; });
	mkdirSync(join(root, "observe", "ledger.jsonl"), { recursive: true });
	await expect(turn("Fix the command")).resolves.toBeUndefined();
	expect(diagnostic).toContain("session-activity failed; no session.activity row for this window; host turn continues");
	expect(diagnostic).toContain('"code":"EISDIR"');
});
