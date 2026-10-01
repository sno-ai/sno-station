import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";

const AGENT_ID = "phase93-tool-write-authority";

let testEmbedder: Embedder;

assertLiveAgentE2EEnabled();

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("Agent 1:1 phase 93 tool write authority", () => {
	let cleanupDb: (() => void) | undefined;
	let previousStateDir: string | undefined;
	let stateDir: string | undefined;
	let store: MemoryStore | undefined;

	afterEach(async () => {
		await store?.close();
		store = undefined;
		cleanupDb?.();
		cleanupDb = undefined;
		if (stateDir) {
			rmSync(stateDir, { recursive: true, force: true });
			stateDir = undefined;
		}
		if (previousStateDir === undefined) {
			delete process.env.OPENCLAW_STATE_DIR;
		} else {
			process.env.OPENCLAW_STATE_DIR = previousStateDir;
		}
		previousStateDir = undefined;
	});

	test(
		"rejects persona and summary writes from the agent-facing memory_store tool",
		async () => {
			const testDb = createTestDb();
			cleanupDb = testDb.cleanup;
			stateDir = mkdtempSync(join(tmpdir(), "mem-claw-phase93-"));
			previousStateDir = process.env.OPENCLAW_STATE_DIR;
			process.env.OPENCLAW_STATE_DIR = stateDir;

			const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: AGENT_ID });
			writeSettingsFixture(dirname(testDb.dbPath), { mode: "local-first",
				store: { path: testDb.dbPath, encryptionKey: testDb.encryptionKey },
				embedding: { cacheDir: "" }, capture: { ambient: false }, recall: { auto: false } });
			if (!memClawPlugin.register) throw new Error("mem-claw registration unavailable");
			await memClawPlugin.register(harness);
			store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
			const storeTool = harness.getRegisteredTool("memory_store");
			if (!storeTool) throw new Error("memory_store tool not registered");

			for (const category of ["persona", "summary"]) {
				const result = asClawResult(
					await storeTool.execute(`phase93-${category}`, {
						category,
						content: `This ${category} payload must not be writable by the agent tool.`,
					}),
				);
				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toBe("invalid-input");
			}

			expect((await store.stats()).total).toBe(0);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 120_000),
	);
});
