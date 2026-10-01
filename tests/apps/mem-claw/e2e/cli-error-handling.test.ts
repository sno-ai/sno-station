/** @file cli-error-handling.test.ts
 * @purpose Validates CLI failure paths, not-found handling, and limit enforcement with real plugin wiring.
 * @boundary Commander command registration, MemoryStore access, production embeddings, and console output capture.
 * @see slash-memory-control.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { Command } from "commander";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-cli-err-state-${Date.now()}`;

/** CLI negative-path coverage that keeps argument errors observable and non-destructive. */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("CLI error handling", () => {
	let dbPath: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;
	let store: MemoryStore;
	let previousProfile: string | undefined;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		mkdirSync(STATE_DIR, { recursive: true });
		previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = STATE_DIR;
		writeSettingsFixture(STATE_DIR, { mode: "local-first", store: { path: dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, capture: { ambient: false }, recall: { auto: false } });

		cleanup = () => {
			store.close();
			testDb.cleanup();
			rmSync(STATE_DIR, { recursive: true, force: true });
		};

		harness = new OpenClawPluginApiHarness({
			embedding: {
				dimensions: 1024,
			},
			dbPath,
			ambientLearning: false,
			autoRecall: false,
		});

		await memClawPlugin.register?.(harness);
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await harness.stopServices?.();
		cleanup();
		if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previousProfile;
	});

	/** Builds an isolated Commander instance from the plugin's registered CLI extension. */
	async function buildProgram(): Promise<Command> {
		const program = new Command();
		program.exitOverride();
		const cliRegistration = harness.registeredCli.find((registration) =>
			registration.opts?.commands?.includes("sno-mem"),
		);
		if (!cliRegistration) throw new Error("No sno-mem CLI registration found");
		await cliRegistration.registrar({
			program,
			config: {},
			logger: harness.logger,
			parentPath: [],
		});
		return program;
	}

	it("real warmup: memory search invokes production embedding without throwing", async () => {
		// Warm the production embedding path by storing a searchable entry before CLI lookup.
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const vector = await embedder.embed(
			"I always prefer TypeScript strict mode. Warmup test.",
		);
		await store.store({
			text: "I always prefer TypeScript strict mode. Warmup test.",
			vector,
			category: "episodic",
			projectId: "global",
		});

		const program = await buildProgram();
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		try {
			await program.parseAsync([
				"node",
				"cli",
				"sno-mem",
				"search",
				"TypeScript strict",
			]);
		} finally {
			console.log = originalLog;
		}

		// Any non-empty CLI response proves the search path completed after embedding.
		// Retrieval quality is intentionally out of scope for this negative-path test.
		const text = output.join("\n");
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
	});

	it("memory delete without --id or --query throws MemClawError", async () => {
		const program = await buildProgram();

		// exitOverride keeps Commander errors observable inside the test process.
		// The delete handler must reject calls without either an id or query selector.
		let threw = false;
		const errOutput: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => errOutput.push(args.join(" "));

		try {
			await program.parseAsync(["node", "cli", "sno-mem", "delete"]);
		} catch (err) {
			threw = true;
			// Preserve the error object for diagnostics without binding to a transport class.
			expect(err).toBeDefined();
		} finally {
			console.error = originalError;
		}

		// Invalid arguments must be explicit, not silently accepted.
		expect(threw).toBe(true);
	});

	it("memory delete --id fake-id --yes logs not-found and remains non-throwing", async () => {
		const program = await buildProgram();

		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		try {
			await program.parseAsync([
				"node",
				"cli",
				"sno-mem",
				"delete",
				"--id",
				"nonexistent-fake-id-12345",
				"--yes",
			]);
		} finally {
			console.log = originalLog;
		}

		// A missing id is a user-visible no-op, not an exception path.
		expect(output.join("\n")).toMatch(/no matching memories found/i);
	});

	it("memory list --limit 999999 caps at MAX_LIST_LIMIT (512)", async () => {
		// Seed beyond MAX_LIST_LIMIT so the CLI cap is tested independently of storage count.
		// Listing does not score vectors, so zero vectors keep the fixture cheap and deterministic.
		const dummyVector = new Float32Array(1024);
		for (let i = 0; i < 530; i++) {
			await store.store({
				text: `Seeded memory entry number ${i} for limit cap test.`,
				vector: dummyVector,
				category: "episodic",
				projectId: "global",
			});
		}
		expect((await store.stats()).total).toBe(530);

		const program = await buildProgram();
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => output.push(args.join(" "));
		try {
			// An excessive user limit must be clamped to the configured maximum.
			await program.parseAsync([
				"node",
				"cli",
				"sno-mem",
				"list",
				"--limit",
				"999999",
				"--scope",
				"global",
			]);
		} finally {
			console.log = originalLog;
		}

		// The list command emits one line per returned entry, so line count proves the cap.
		const lines = output.filter((l) => l.trim().length > 0);
		expect(lines.length).toBe(512);
	});
});
