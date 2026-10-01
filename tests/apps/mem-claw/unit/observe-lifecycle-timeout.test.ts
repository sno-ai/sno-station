import { afterEach, describe, expect, it, vi } from "vitest";
import { dirname } from "node:path";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, type TestDb } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

const { readMemorySnapshotPayload } = vi.hoisted(() => ({
	readMemorySnapshotPayload: vi.fn(async () => ({
		session_uuid: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f",
		snapshot_reason: "startup",
		total_entries: 0,
		total_bytes: 0,
	})),
}));

vi.mock("../../../../packages/memory/src/engine/observability/memory-snapshot", () => ({
	readMemorySnapshotPayload,
}));

const testDbs: TestDb[] = [];
let previousProfile: string | undefined;

afterEach(() => {
	vi.useRealTimers();
	readMemorySnapshotPayload.mockClear();
	for (const testDb of testDbs.splice(0)) {
		testDb.cleanup();
	}
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

describe("observe lifecycle timeout", () => {
	it("does not let a stuck memory snapshot block session finalization", async () => {
		const testDb = createTestDb();
		testDbs.push(testDb);
		previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = dirname(testDb.dbPath);
		writeSettingsFixture(dirname(testDb.dbPath), { mode: "local-first", store: { path: testDb.dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, capture: { ambient: false, sessionStrategy: "none" }, telemetry: { observe: { enabled: false } } });
		const harness = new OpenClawPluginApiHarness({
			dbPath: testDb.dbPath,
			embedding: { provider: "local-onnx", dimensions: 1024 },
			observe: { enabled: false },
			ambientLearning: false,
			sessionStrategy: "none",
		});
		await memClawPlugin.register(harness);
		readMemorySnapshotPayload.mockImplementationOnce(() => new Promise(() => undefined));
		const agentEnd = harness.getOnHookHandler("agent_end");
		if (!agentEnd) throw new Error("agent_end hook missing");
		const sessionEnd = harness.getOnHookHandler("session_end");
		if (!sessionEnd) throw new Error("session_end hook missing");

		vi.useFakeTimers();
		const agentFinished = (
			agentEnd as unknown as (
				event: { messages: unknown[]; success: boolean; durationMs?: number },
				ctx: { agentId: string; sessionId: string },
			) => Promise<void>
		)(
			{ messages: [], success: false, durationMs: 1 },
			{ agentId: "agent-timeout", sessionId: "session-timeout" },
		);
		await Promise.resolve();
		// must exceed SNO_OBSERVE_FLUSH_TIMEOUT_MS (8_000) in config/index.ts
		await vi.advanceTimersByTimeAsync(8_001);
		await expect(agentFinished).resolves.toBeUndefined();

		const finished = (
			sessionEnd as unknown as (
				event: { sessionId: string; messageCount: number; durationMs?: number },
				ctx: { agentId: string; sessionId: string },
			) => Promise<void>
		)(
			{ sessionId: "session-timeout", messageCount: 0 },
			{ agentId: "agent-timeout", sessionId: "session-timeout" },
		);

		await expect(finished).resolves.toBeUndefined();
		expect(harness.logMessages.warn).toContain("mem-claw observability snapshot timed out");
	});
});
