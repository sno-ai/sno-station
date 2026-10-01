/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * Gate 2 eval for E2 (upstream 1278dfa subagent guard).
 *
 * Asserts the `:subagent:` guard fires at `before_prompt_build`:
 *  - Session key containing `:subagent:` → handler returns early, no retrieval
 *    attempted, audit event `auto_recall / skipped_subagent` recorded.
 *  - Normal agent session → handler proceeds (no skipped_subagent event).
 *
 * Real OpenClawPluginApiHarness + real plugin `register()` + real SQLite +
 * real ONNX embedder. Zero mocks. Verified via appendAuditEntry output in
 * audit.jsonl (observability upgrade shipped in the same E2 catchup wave).
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { untilModelReady } from "../../../packages/memory/integration/fixtures/model-ready.ts";

interface AuditLine {
	event: string;
	hook?: string;
	resultStatus?: string;
	decision?: string;
	details?: Record<string, unknown>;
	timestamp: string;
}

function readAudit(stateDir: string): AuditLine[] {
	const auditPath = join(stateDir, "sno-station-mem", "audit.jsonl");
	if (!existsSync(auditPath)) return [];
	const raw = readFileSync(auditPath, "utf-8").trim();
	if (!raw) return [];
	return raw
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditLine);
}

/** Audit writes are queued; wait for the queue to drain before reading. */
async function waitForAudit(
	stateDir: string,
	predicate: (entries: AuditLine[]) => boolean,
	timeoutMs = 2000,
): Promise<AuditLine[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entries = readAudit(stateDir);
		if (predicate(entries)) return entries;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return readAudit(stateDir);
}

describe("subagent-guard eval (E2 1278dfa)", () => {
	let stateDir: string;
	let dbCleanup: () => void;
	let harness: OpenClawPluginApiHarness;
	const prevStateDir = process.env.SNO_PROFILE_DIR;

	beforeEach(async () => {
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-subagent-eval-"));
		process.env.SNO_PROFILE_DIR = stateDir;

		const testDb = createTestDb();
		dbCleanup = testDb.cleanup;
		process.env.SNO_PROFILE_DIR = stateDir;
		writeSettingsFixture(stateDir, { mode: "local-first", store: { path: testDb.dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, capture: { ambient: false, sessionStrategy: "none" }, recall: { auto: true } });

		harness = new OpenClawPluginApiHarness({
			embedding: { dimensions: 1024 },
			dbPath: testDb.dbPath,
			ambientLearning: false,
			autoRecall: true,
			sessionStrategy: "none",
		});

		await memClawPlugin.register?.(harness);
		await harness.startServices();
		const { port } = JSON.parse(readFileSync(join(stateDir, "station", "sidecar.json"), "utf8")) as { port: number };
		await untilModelReady(async ({ scope, ...recall }) => {
			const response = await fetch(`http://127.0.0.1:${port}/v1/get-recall`, {
				method: "POST", headers: { "x-sno-station-mem-skin": "model-ready-probe" },
				body: JSON.stringify({ ...recall, scope: { ...scope, principal: userInfo().username } }),
			});
			return response.json();
		});
	});

	afterEach(async () => {
		await harness.stopServices?.();
		dbCleanup();
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		if (prevStateDir === undefined) {
			delete process.env.SNO_PROFILE_DIR;
		} else {
			process.env.SNO_PROFILE_DIR = prevStateDir;
		}
	});

	it("session key with ':subagent:' → skipped_subagent audit event, no retrieval side effects", async () => {
		const handler = harness.getOnHookHandler("before_prompt_build");
		expect(handler).toBeDefined();
		if (!handler) throw new Error("handler missing");

		const event = { prompt: "What did we decide about the HNSW index size?" };
		const ctx = {
			agentId: "main",
			sessionKey: "session:main:run-1:subagent:worker-a",
		};
		const result = await (handler as unknown as (
			e: typeof event,
			c: typeof ctx,
		) => Promise<unknown>)(event, ctx);

		expect(result).toBeUndefined();

		const entries = await waitForAudit(stateDir, (es) =>
			es.some((e) => e.decision === "skipped_subagent"),
		);
		const skipped = entries.filter(
			(e) => e.event === "auto_recall" && e.decision === "skipped_subagent",
		);
		expect(skipped.length).toBe(1);
		expect(skipped[0]?.details?.sessionKey).toEqual(ctx.sessionKey);

		const executed = entries.filter(
			(e) => e.event === "auto_recall" && e.decision === "executed",
		);
		expect(executed.length).toBe(0);
	});

	it("normal agent session (no :subagent:) → handler proceeds past guard, no skipped_subagent event", async () => {
		const handler = harness.getOnHookHandler("before_prompt_build");
		if (!handler) throw new Error("handler missing");

		const event = { prompt: "Briefly describe the retriever scoring pipeline." };
		const ctx = {
			agentId: "main",
			sessionKey: "agent:main:openai-user:test-session-42",
		};
		await (handler as unknown as (
			e: typeof event,
			c: typeof ctx,
		) => Promise<unknown>)(event, ctx);

		const entries = await waitForAudit(
			stateDir,
			(es) =>
				es.some(
					(e) => e.event === "auto_recall" && e.decision !== "skipped_subagent",
				),
			1500,
		);

		const skipped = entries.filter(
			(e) => e.event === "auto_recall" && e.decision === "skipped_subagent",
		);
		expect(skipped.length).toBe(0);

		const nonSubagentRecall = entries.filter(
			(e) =>
				e.event === "auto_recall" &&
				(e.decision === "executed" || e.decision === "executed_empty"),
		);
		expect(nonSubagentRecall.length).toBeGreaterThan(0);
	});
});
