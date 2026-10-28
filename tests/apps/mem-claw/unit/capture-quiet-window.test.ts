import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRuntimeHooks } from "../../../../apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

// Extraction is the expensive step behind capture, so a session is captured once it has been quiet for
// thirty minutes or has ended, never after every turn (owner decision, 2026-10-27).
type Handler = (event: unknown, context: unknown) => Promise<unknown>;
type Sent = { kind: "capture" | "end"; session: string; contents: unknown[] };
const QUIET_MS = 30 * 60_000;
let root: string;
let handlers: Map<string, Handler>;
let sent: Sent[];
let history: Record<string, unknown[]>;
let failCaptures: number[];
let captureCalls: number;
const sessionA = { sessionId: "session-a", sessionKey: "agent:main:session-a" };
const sessionB = { sessionId: "session-b", sessionKey: "agent:main:session-b" };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "claw-quiet-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	writeSettingsFixture(root, { recall: { auto: false }, telemetry: { observe: { enabled: false } } });
	handlers = new Map();
	sent = [];
	history = {};
	failCaptures = [];
	captureCalls = 0;
	startGateway();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

/** Registers the plugin's hooks as one gateway process does; calling it again stands for a restarted gateway. */
function startGateway(): void {
	handlers = new Map();
	const api = { config: {}, logger: { info: () => {}, warn: () => {} }, registerHook: () => {}, on: (name: string, handler: Handler) => handlers.set(name, handler) };
	// The sidecar is a separate process; this stand-in only records what reaches its capture and session-end routes.
	const client = {
		capture: async (turn: { messages: { content: unknown }[] }, scope: { session: string }) => {
			captureCalls += 1;
			if (failCaptures.includes(captureCalls)) throw new Error("capture timed out");
			sent.push({ kind: "capture", session: scope.session, contents: turn.messages.map(message => message.content) });
			return { committed: true };
		},
		onSessionEnd: async (messages: { content: unknown }[], scope: { session: string }) => {
			sent.push({ kind: "end", session: scope.session, contents: messages.map(message => message.content) });
			return {};
		},
	};
	const connection = {
		ready: async () => client,
		scope: async (context: { sessionId?: string }) => ({ principal: "lh", project: "/repo", session: context.sessionId ?? "", host: { sessionId: context.sessionId ?? "" } }),
	};
	const observe = { startObserveSession: async () => {}, finalizeObserveSession: async () => {}, lookupActiveObserveSession: () => undefined };
	registerRuntimeHooks(api as never, { sessionStrategy: "none" } as never, connection as never, observe as never, {} as never);
}

// OpenClaw's agent_end carries the whole session snapshot after the run, so each turn's event repeats every earlier turn.
async function turn(session: typeof sessionA, prompt: string, reply: string): Promise<void> {
	const at = Date.now();
	history[session.sessionId] = [...(history[session.sessionId] ?? []),
		{ role: "user", content: prompt, timestamp: at }, { role: "assistant", content: reply, timestamp: at + 1_000 }];
	await handlers.get("agent_end")?.({ success: true, messages: history[session.sessionId] }, session);
}

it("captures a session once, with every turn, after thirty quiet minutes", async () => {
	await turn(sessionA, "Rename the deploy script", "Renamed it to deploy.sh");
	await vi.advanceTimersByTimeAsync(5 * 60_000);
	await turn(sessionA, "Use port 8443 for staging", "Staging now listens on 8443");
	await vi.advanceTimersByTimeAsync(10 * 60_000);
	await turn(sessionA, "Keep logs for 14 days", "Retention set to 14 days");
	expect(sent).toEqual([]);

	await vi.advanceTimersByTimeAsync(QUIET_MS - 1_000);
	expect(sent).toEqual([]);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(sent).toEqual([{ kind: "capture", session: "session-a", contents: [
		"Rename the deploy script", "Renamed it to deploy.sh",
		"Use port 8443 for staging", "Staging now listens on 8443",
		"Keep logs for 14 days", "Retention set to 14 days",
	] }]);

	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent).toHaveLength(1);
});

it("captures pending turns when the session ends, before the session-end report, and not again later", async () => {
	await turn(sessionA, "Pin node to 24", "Pinned in .nvmrc");
	await turn(sessionA, "Drop the old cron job", "Removed it");
	await handlers.get("session_end")?.({ sessionId: "session-a" }, sessionA);
	expect(sent.map(({ kind, session, contents }) => ({ kind, session, count: contents.length }))).toEqual([
		{ kind: "capture", session: "session-a", count: 4 },
		{ kind: "end", session: "session-a", count: 0 },
	]);
	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent).toHaveLength(2);
});

it("captures pending turns before a reset or compaction drops them from the session", async () => {
	await turn(sessionA, "Store backups in the eu bucket", "Switched the bucket");
	expect(sent).toEqual([]);
	await handlers.get("before_reset")?.({ messages: [] }, sessionA);
	await turn(sessionB, "Use tabs in the Makefile", "Converted to tabs");
	await handlers.get("after_compaction")?.({}, sessionB);
	expect(sent.map(({ kind, session, contents }) => ({ kind, session, first: contents[0] }))).toEqual([
		{ kind: "capture", session: "session-a", first: "Store backups in the eu bucket" },
		{ kind: "end", session: "session-a", first: undefined },
		{ kind: "capture", session: "session-b", first: "Use tabs in the Makefile" },
		{ kind: "end", session: "session-b", first: undefined },
	]);
	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent).toHaveLength(4);
});

it("keeps turns whose capture failed at a reset, though the session's later snapshots no longer carry them", async () => {
	await turn(sessionA, "Store backups in the eu bucket", "Switched the bucket");
	failCaptures = [1];
	await handlers.get("before_reset")?.({ messages: [] }, sessionA);
	// After the reset, OpenClaw's snapshots start over without the earlier turns.
	history[sessionA.sessionId] = [];
	await turn(sessionA, "Rotate the backup key monthly", "Scheduled the rotation");
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	expect(sent.filter(entry => entry.kind === "capture").flatMap(capture => capture.contents)).toEqual([
		"Store backups in the eu bucket", "Switched the bucket", "Rotate the backup key monthly", "Scheduled the rotation",
	]);
	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent.filter(entry => entry.kind === "capture")).toHaveLength(1);
});

it("sends held turns once when a failed quiet capture is followed by a snapshot that repeats them", async () => {
	await turn(sessionA, "Pin Node 24 in CI", "Pinned it in the workflow");
	failCaptures = [1];
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	expect(sent).toEqual([]);
	await turn(sessionA, "Cache the pnpm store", "Cached by lockfile hash");
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	expect(sent).toEqual([{ kind: "capture", session: "session-a", contents: [
		"Pin Node 24 in CI", "Pinned it in the workflow", "Cache the pnpm store", "Cached by lockfile hash",
	] }]);
});

it("captures every session with pending turns when the gateway stops", async () => {
	await turn(sessionA, "Prefer pnpm here", "Noted");
	await turn(sessionB, "The API key lives in vault", "Noted");
	expect(sent).toEqual([]);
	await handlers.get("gateway_stop")?.({}, {});
	expect(sent.filter(entry => entry.kind === "capture").map(entry => entry.session).sort()).toEqual(["session-a", "session-b"]);
	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent.filter(entry => entry.kind === "capture")).toHaveLength(2);
});

it("does not capture a failed run", async () => {
	await handlers.get("agent_end")?.({ success: false, messages: [{ role: "user", content: "x", timestamp: Date.now() }] }, sessionA);
	await vi.advanceTimersByTimeAsync(2 * QUIET_MS);
	expect(sent).toEqual([]);
});

// A long session goes out as several captures, each within the sidecar's single-window input (UTF-8 bytes / 3 <= 3,500
// tokens), in order and cut only where a turn starts; a failed capture keeps its turns for the next attempt.
const LONG_TURNS = 12;
function longSession(): string[] {
	return Array.from({ length: LONG_TURNS }, (_, index) => [
		`Turn ${index}: ${"Move the nightly backup to the eu-west bucket and keep thirty days of copies. ".repeat(15)}`,
		`Reply ${index}: ${"Done, the job now writes to eu-west and prunes copies older than thirty days. ".repeat(15)}`,
	]).flat();
}
async function sendLongSession(): Promise<void> {
	const contents = longSession();
	for (let index = 0; index < contents.length; index += 2) await turn(sessionA, contents[index] ?? "", contents[index + 1] ?? "");
}
function estimatedTokens(contents: unknown[]): number {
	return contents.reduce<number>((sum, content) => sum + Buffer.byteLength(String(content)) / 3, 0);
}

it("sends a long pending session as several bounded captures, in order, each starting a turn", async () => {
	await sendLongSession();
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	const captures = sent.filter(entry => entry.kind === "capture");
	expect(captures.length).toBeGreaterThan(1);
	for (const capture of captures) {
		expect(estimatedTokens(capture.contents)).toBeLessThanOrEqual(3_500);
		expect(String(capture.contents[0])).toMatch(/^Turn \d+:/);
	}
	expect(captures.flatMap(capture => capture.contents)).toEqual(longSession());
});

it("keeps the turns of a failed capture and sends them at the next quiet period", async () => {
	await sendLongSession();
	failCaptures = [2];
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	const first = sent.filter(entry => entry.kind === "capture").flatMap(capture => capture.contents);
	expect(first.length).toBeGreaterThan(0);
	expect(first.length).toBeLessThan(longSession().length);
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	expect(sent.filter(entry => entry.kind === "capture").flatMap(capture => capture.contents)).toEqual(longSession());
});

it("captures the turns a killed gateway held inside the quiet window when the next gateway starts", async () => {
	await turn(sessionA, "Pin Node 24 in CI", "Pinned it in the workflow");
	await turn(sessionA, "Cache the pnpm store", "Cached by lockfile hash");
	await vi.advanceTimersByTimeAsync(10 * 60_000);
	expect(sent).toEqual([]);

	// SIGKILL runs no hook and no exit handler: the next process starts with nothing in memory, and a write it cut off
	// leaves a temporary file behind.
	writeFileSync(join(root, "mem-claw", "pending-captures", "cut-off.json.tmp"), "{\"session\":");
	startGateway();
	await handlers.get("gateway_start")?.({}, {});
	expect(sent).toEqual([{ kind: "capture", session: "session-a", contents: [
		"Pin Node 24 in CI", "Pinned it in the workflow", "Cache the pnpm store", "Cached by lockfile hash",
	] }]);
	expect(readdirSync(join(root, "mem-claw", "pending-captures"))).toEqual([]);
});

it("stops sending held turns to extraction after three failed captures, counting across gateway restarts", async () => {
	await turn(sessionA, "Pin Node 24 in CI", "Pinned it in the workflow");
	failCaptures = [1, 2, 3, 4, 5, 6];
	await vi.advanceTimersByTimeAsync(QUIET_MS);
	// The gateway is killed while its retry waits; its timers die with it.
	vi.clearAllTimers();
	startGateway();
	await handlers.get("gateway_start")?.({}, {});
	await vi.advanceTimersByTimeAsync(5 * QUIET_MS);
	expect(captureCalls).toBe(3);
	expect(sent).toEqual([]);
	expect(readdirSync(join(root, "mem-claw", "pending-captures"))).toEqual([]);
});
