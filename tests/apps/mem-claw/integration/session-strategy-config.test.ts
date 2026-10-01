import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb } from "../helpers/test-db.ts";

describe("session strategy hook routing", () => {
	const originalProfile = process.env.SNO_PROFILE_DIR;
	let root: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;

	afterEach(async () => {
		await harness?.stopServices?.();
		cleanup?.();
		if (originalProfile === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = originalProfile;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it.each(["systemSessionMemory", "none"] as const)(
		"registers before_reset when sessionStrategy is %s",
		async (sessionStrategy) => {
			const database = createTestDb();
			cleanup = database.cleanup;
			root = mkdtempSync(join(tmpdir(), "mem-claw-session-strategy-"));
			process.env.SNO_PROFILE_DIR = root;
			writeSettingsFixture(root, {
				mode: "local-first",
				store: { path: database.dbPath, encryptionKey: database.encryptionKey },
				embedding: { cacheDir: "" },
				capture: { sessionStrategy },
			});
			harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "session-strategy-agent" });
			await memClawPlugin.register?.(harness);
			expect(harness.getOnHookHandler("before_reset")).toBeDefined();
		},
	);
});
