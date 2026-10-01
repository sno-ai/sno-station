/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

beforeAll(async () => {
	await createTestEmbedder();
});

describe("hook session-key fallback regressions", () => {
	let stateDir: string;
	let dbPath: string;
	let dbCleanup: () => void;
	let countMemories: () => number;
	let harness: OpenClawPluginApiHarness;
	let harnesses: OpenClawPluginApiHarness[];
	let prevStateDir: string | undefined;

	function trackHarness(
		nextHarness: OpenClawPluginApiHarness,
	): OpenClawPluginApiHarness {
		harnesses.push(nextHarness);
		return nextHarness;
	}

	beforeEach(async () => {
		prevStateDir = process.env.SNO_PROFILE_DIR;
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-hook-fallback-"));
		process.env.SNO_PROFILE_DIR = stateDir;
		harnesses = [];

		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		dbCleanup = testDb.cleanup;
		process.env.SNO_PROFILE_DIR = stateDir;
		writeSettingsFixture(stateDir, { mode: "local-first", store: { path: dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, capture: { ambient: true, sessionStrategy: "systemSessionMemory", sessionMemory: { enabled: true, messageCount: 4 } }, recall: { auto: true } });
		countMemories = () => {
			const row = testDb.sqlite
				.prepare("SELECT COUNT(*) AS count FROM nodix_memories")
				.get() as { count: number };
			return row.count;
		};

		harness = trackHarness(
			new OpenClawPluginApiHarness(
				{
					embedding: { dimensions: 1024 },
					dbPath,
					ambientLearning: true,
					autoRecall: true,
					sessionStrategy: "systemSessionMemory",
					sessionMemory: {
						enabled: true,
						messageCount: 4,
					},
					// Pin local-first extraction: the agent_end content-hash dedup
					// regression test asserts dedup against deterministic package
					// chunks, which only run under local-first extraction.
					mode: "local-first",
				},
				{ runtimeAgentId: "parsed-agent" },
			),
		);
		await memClawPlugin.register?.(harness);
	});

	afterEach(async () => {
		for (const trackedHarness of [...harnesses].reverse()) {
			await trackedHarness.stopServices?.();
		}
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

	it("before_prompt_build uses the sessionKey fallback agent id for scope resolution", async () => {
		const storeTool = harness.getRegisteredTool("memory_store");
		const beforeStart = harness.getOnHookHandler("before_prompt_build");
		expect(storeTool).toBeDefined();
		expect(beforeStart).toBeDefined();
		if (!storeTool) throw new Error("memory_store tool missing");

			const stored = asClawResult(
				await storeTool.execute("store-agent-scope", {
					content: "Parsed agent prefers Node.js for service runtime work.",
				}),
			);
		expect(stored.isError).not.toBe(true);

		const result = await (
			beforeStart as unknown as (
				event: { prompt: string; messages: unknown[] },
				ctx: { sessionKey: string; agentId?: string },
			) => Promise<{ prependContext?: string } | undefined>
			)(
				{
					prompt: "Parsed agent prefers Node.js for service runtime work.",
					messages: [],
				},
				{ sessionKey: "agent:parsed-agent:test-session-42" },
		);

		expect(result?.prependContext).toContain(
			"Parsed agent prefers Node.js for service runtime work.",
		);

		expect(result?.prependContext).toContain(`[id:${stored.content[0]?.text}]`);
	});

	it("memory_store rejects missing tool identity without writing to the default scope", async () => {
		await harness.stopServices();
		const missingIdentityHarness = trackHarness(
			new OpenClawPluginApiHarness({
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: false,
				autoRecall: false,
				sessionStrategy: "none",
			}),
		);
		await memClawPlugin.register?.(missingIdentityHarness);

		const storeTool = missingIdentityHarness.getRegisteredTool("memory_store");
		expect(storeTool).toBeDefined();
		if (!storeTool) throw new Error("memory_store tool missing");

		const result = asClawResult(
			await storeTool.execute("store-missing-identity", {
				content: "Missing tool identity must not write default-scope memory.",
			}),
		);

		expect(result.isError).toBe(true);
		expect(result.details?.errorCode).toBe("invalid-input");
		expect(result.content[0]?.text).toBe("invalid-input");
		expect(countMemories()).toBe(0);
	});









});
