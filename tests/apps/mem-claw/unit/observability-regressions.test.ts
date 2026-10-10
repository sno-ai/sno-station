import { countTokens } from "@snoai/chunking";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter.ts";
import { readMemorySnapshotPayload } from "../../../../packages/memory/src/engine/observability/memory-snapshot.ts";
import { ObservableLlmClient } from "../../../../packages/memory/src/engine/observability/observable-llm-client.ts";
import { ObservableMemoryStore } from "../../../../packages/memory/src/engine/observability/observable-memory-store.ts";
import type {
	LlmClient,
	MemoryLlmRequest,
	ResolvedLlmConfig,
} from "../../../../packages/memory/src/model/llm-client-types.ts";
import { ObserveSessionRegistry } from "../../../../packages/memory/src/engine/observability/session-registry.ts";
import { withToolObservabilityApi } from "../../../../apps/mem-claw/src/tools/with-tool-observability.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";
import {
	initSqliteRuntime,
	openSqliteDatabase,
} from "../../../../packages/memory/src/store/sqlite-runtime.ts";

const { countEmbeddingTokens, countManyEmbeddingTokens } = vi.hoisted(() => ({
	countEmbeddingTokens: vi.fn(async (text: string) => ({
		count: text.length,
		method: "char_approximation" as const,
	})),
	countManyEmbeddingTokens: vi.fn(async (texts: string[]) => ({
		count: texts.reduce((total, text) => total + text.length, 0),
		method: "char_approximation" as const,
	})),
}));

vi.mock("../../../../packages/memory/src/engine/observability/token-counter", () => ({
	countEmbeddingTokens,
	countManyEmbeddingTokens,
}));

const tempDirs: string[] = [];
let previousHome: string | undefined;

type TestAgentToolResult<T> = {
	content: Array<{ type: "text"; text: string }>;
	details: T;
};

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function deferredEmbedding(): {
	promise: Promise<Float32Array>;
	resolve: (value: Float32Array) => void;
} {
	let resolve: (value: Float32Array) => void = () => undefined;
	const promise = new Promise<Float32Array>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function makeTestVector(): Float32Array {
	const vector = new Float32Array(1024);
	vector[0] = 1;
	return vector;
}

function testHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

beforeEach(() => {
	previousHome = process.env.HOME;
	process.env.HOME = makeTempDir("mem-claw-observability-home-");
	initSqliteRuntime("a".repeat(64));
	countEmbeddingTokens.mockClear();
	countManyEmbeddingTokens.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("observability regressions", () => {
	it("can look up observe sessions without creating a replacement after finalization", () => {
		const registry = new ObserveSessionRegistry();
		const sessionUuid = registry.resolve("runtime-session");

		expect(registry.lookup("runtime-session")).toBe(sessionUuid);

		registry.delete("runtime-session");

		expect(registry.lookup("runtime-session")).toBeUndefined();
	});

	it("does not store a shared observe session mapping for missing runtime session ids", () => {
		const registry = new ObserveSessionRegistry();
		const firstMissingUuid = registry.resolve(undefined);
		const secondMissingUuid = registry.resolve("");

		expect(firstMissingUuid).not.toBe(secondMissingUuid);
		expect(registry.lookup(undefined)).toBeUndefined();
		expect(registry.lookup("")).toBeUndefined();
	});

	it("deletes observe session mappings with the same normalization used for lookup", () => {
		const registry = new ObserveSessionRegistry();
		const trimmedUuid = registry.resolve(" runtime-session ");

		registry.delete("runtime-session");

		expect(registry.lookup("runtime-session")).toBeUndefined();
		expect(trimmedUuid).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
		);
	});

	it("deletes every observe session alias for the same UUID", () => {
		const registry = new ObserveSessionRegistry();
		const sessionUuid = registry.resolve("runtime-session");
		registry.link("gateway-session", sessionUuid);

		registry.deleteSession(sessionUuid);

		expect(registry.lookup("runtime-session")).toBeUndefined();
		expect(registry.lookup("gateway-session")).toBeUndefined();
	});

	it("does not let tool telemetry serialization failures mask a successful tool result", async () => {
		const stateDir = makeTempDir("mem-claw-tool-observe-");
		const result = {
			content: [{ type: "text", text: "ok" }],
			details: { value: 1n },
		} satisfies TestAgentToolResult<{ value: bigint }>;
		let registeredTool: AnyAgentTool | undefined;
		const observability = {
			hashText: testHash,
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => {
				void Promise.resolve()
					.then(task)
					.catch(() => undefined);
			},
		} as unknown as PluginObservability;
		const api = {
			registerTool(tool: AnyAgentTool) {
				registeredTool = tool;
			},
		} as unknown as OpenClawPluginApi;
		const tool: AnyAgentTool = {
			name: "serialize-edge",
			label: "Serialize Edge",
			description: "serialization edge case",
			parameters: { type: "object", properties: {} },
			execute: async () => result,
		};
		const circularParams: Record<string, unknown> = {};
		circularParams.self = circularParams;

		withToolObservabilityApi(
			api,
			observability,
			() => "session-1",
			stateDir,
		).registerTool(tool);

		await expect(
			registeredTool?.execute(
				"call-1",
				circularParams,
				new AbortController().signal,
			),
		).resolves.toBe(result);
		await flushAsyncWork();
		expect(observability.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "tool.call",
				payload: expect.objectContaining({
					input_hash: testHash("[unserializable]"),
					output_hash: testHash("[unserializable]"),
				}),
			}),
		);
	});

	it("does not wait for tool telemetry before returning tool results", async () => {
		vi.useFakeTimers();
		const stateDir = makeTempDir("mem-claw-tool-observe-latency-");
		const result = {
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
		} satisfies TestAgentToolResult<{ ok: boolean }>;
		let registeredTool: AnyAgentTool | undefined;
		let releaseTelemetry: () => void = () => {};
		const telemetryReady = new Promise<void>((resolve) => {
			releaseTelemetry = resolve;
		});
		const tracked: Promise<void>[] = [];
		const observability = {
			hashText: testHash,
			emit: vi.fn(async () => {
				await telemetryReady;
			}),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => {
				tracked.push(
					Promise.resolve()
						.then(task)
						.then(() => undefined),
				);
			},
		} as unknown as PluginObservability;
		const api = {
			registerTool(tool: AnyAgentTool) {
				registeredTool = tool;
			},
		} as unknown as OpenClawPluginApi;
		const tool: AnyAgentTool = {
			name: "slow-telemetry",
			label: "Slow Telemetry",
			description: "telemetry latency edge case",
			parameters: { type: "object", properties: {} },
			execute: async () => result,
		};

		withToolObservabilityApi(
			api,
			observability,
			() => "session-1",
			stateDir,
		).registerTool(tool);
		if (!registeredTool) throw new Error("tool registration failed");

		const returned = Promise.race([
			registeredTool
				.execute("call-1", {}, new AbortController().signal)
				.then((value) => (value === result ? "returned" : "unexpected")),
			new Promise<"blocked">((resolve) => {
				setTimeout(() => resolve("blocked"), 1);
			}),
		]);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1);
		await expect(returned).resolves.toBe("returned");

		releaseTelemetry();
		await Promise.allSettled(tracked);
		expect(observability.emit).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "tool.call" }),
		);
	});

	it.each(["direct", "factory", "context-v2"] as const)("preserves tool execute this binding and emits every tool.call unsampled (%s)", async (kind) => {
		const stateDir = makeTempDir("mem-claw-tool-observe-binding-");
		let registration: unknown;
		const observability = {
			hashText: () => undefined,
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => { void task(); },
		} as unknown as PluginObservability;
		const api = {
			registerTool(tool: unknown) {
				registration = tool;
			},
		} as unknown as OpenClawPluginApi;
		const tool = {
			name: "bound-tool",
			label: "Bound Tool",
			description: "binding edge case",
			parameters: { type: "object", properties: {} },
			marker: "state",
			async execute(
				this: { marker: string; name: string },
			): Promise<TestAgentToolResult<{ marker: string }>> {
				return {
					content: [{ type: "text", text: `${this.name}:${this.marker}` }],
					details: { marker: this.marker },
				};
			},
		};
		// SDK erased execute type forbids a typed `this`; this test verifies runtime binding.
		const typedTool = tool as unknown as AnyAgentTool;

		withToolObservabilityApi(
			api,
			observability,
			() => "session-1",
			stateDir,
		).registerTool(kind === "direct" ? typedTool : kind === "factory" ? () => typedTool : { contextVersion: 2, create: () => typedTool });

		const context = { sessionKey: "session-1" };
		const registeredTool = (kind === "direct" ? registration : kind === "factory"
			? (registration as (ctx: typeof context) => AnyAgentTool)(context)
			: (registration as { create: (ctx: typeof context) => AnyAgentTool }).create(context)) as AnyAgentTool;

		const result = await registeredTool?.execute(
			"call-1",
			{},
			new AbortController().signal,
		);
		const firstContent = result?.content[0];
		expect(firstContent?.type === "text" ? firstContent.text : undefined).toBe(
			"bound-tool:state",
		);
		await flushAsyncWork();
		expect(observability.emit).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "tool.call", payload: expect.objectContaining({ tool_name: "bound-tool" }) }),
		);
	});

	it("counts memory snapshot entries and bytes without token fields", async () => {
		const stateDir = makeTempDir("sno-memory-snapshot-");
		const dbPath = join(stateDir, "memory.sqlite");
		const handle = openSqliteDatabase(dbPath);
		const { db } = handle;
		try {
			db.exec(`
				CREATE TABLE nodix_memories (
					text TEXT NOT NULL,
					timestamp INTEGER NOT NULL
				);
			`);
			db.prepare(
				"INSERT INTO nodix_memories (text, timestamp) VALUES (?, ?)",
			).run("alpha", 100);
			db.prepare(
				"INSERT INTO nodix_memories (text, timestamp) VALUES (?, ?)",
			).run("beta", 200);
		} finally {
			db.close();
		}

		const payload = await readMemorySnapshotPayload(
			dbPath,
			pluginConfigSchema.parse({ embedding: { provider: "local-onnx" } }),
			"01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f",
			"startup",
		);

		expect(countEmbeddingTokens).not.toHaveBeenCalled();
		expect(payload).toEqual({
			session_uuid: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f",
			snapshot_reason: "startup",
			total_entries: 2,
			total_bytes: 9,
			oldest_entry_ts_ms: 100,
			newest_entry_ts_ms: 200,
		});
	});

	it("does not create the memory database when reading an absent snapshot", async () => {
		const stateDir = makeTempDir("sno-memory-snapshot-absent-");
		const dbPath = join(stateDir, "memory.sqlite");

		const payload = await readMemorySnapshotPayload(
			dbPath,
			pluginConfigSchema.parse({ embedding: { provider: "local-onnx" } }),
			"01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f",
			"startup",
		);

		expect(existsSync(dbPath)).toBe(false);
		expect(payload).toEqual({
			session_uuid: "01949f3a-7dc4-7e40-8c5b-2a9b1e7c8d3f",
			snapshot_reason: "startup",
			total_entries: 0,
			total_bytes: 0,
		});
	});

	it("does not emit paid LLM usage for local embeddings", async () => {
		const { ObservableEmbedder } = await import(
			"../../../../packages/memory/src/engine/observability/observable-embedding-provider-client.ts"
		);
		const stateDir = makeTempDir("mem-claw-embed-observe-");
		const observability = {
			enabled: true,
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => {
				void Promise.resolve().then(task);
			},
		} as unknown as PluginObservability;
		const first = deferredEmbedding();
		const second = deferredEmbedding();
		let callIndex = 0;

		class TestObservableEmbedder extends ObservableEmbedder {
			override async warmup(): Promise<void> {
				return undefined;
			}

			protected override async embedDirect(): Promise<Float32Array> {
				callIndex += 1;
				return callIndex === 1 ? first.promise : second.promise;
			}
		}

		const embedder = new TestObservableEmbedder(
			{ provider: "local-onnx", chunking: false },
			stateDir,
			observability,
			() => "session-1",
		);

		const firstEmbedding = embedder.embed("first");
		await Promise.resolve();
		const secondEmbedding = embedder.embed("second");
		await Promise.resolve();

		first.resolve(Float32Array.from([1, 0, 0]));
		second.resolve(Float32Array.from([0, 1, 0]));

		await expect(
			Promise.all([firstEmbedding, secondEmbedding]),
		).resolves.toEqual([
			Float32Array.from([1, 0, 0]),
			Float32Array.from([0, 1, 0]),
		]);
		await flushAsyncWork();

		expect(countManyEmbeddingTokens).not.toHaveBeenCalled();
		expect(observability.emit).not.toHaveBeenCalled();
	});

	it("does not count embedding tokens when observability is disabled", async () => {
		const { ObservableEmbedder } = await import(
			"../../../../packages/memory/src/engine/observability/observable-embedding-provider-client.ts"
		);
		const stateDir = makeTempDir("mem-claw-embed-observe-disabled-");
		const observability = {
			enabled: false,
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: vi.fn(),
		} as unknown as PluginObservability;

		class TestObservableEmbedder extends ObservableEmbedder {
			override async warmup(): Promise<void> {
				return undefined;
			}

			protected override async embedDirect(): Promise<Float32Array> {
				return makeTestVector();
			}
		}

		const embedder = new TestObservableEmbedder(
			{ provider: "local-onnx", chunking: false },
			stateDir,
			observability,
			() => "session-1",
		);

		await expect(embedder.embed("disabled")).resolves.toEqual(makeTestVector());

		expect(countManyEmbeddingTokens).not.toHaveBeenCalled();
		expect(observability.trackBestEffort).not.toHaveBeenCalled();
		expect(observability.emit).not.toHaveBeenCalled();
	});

	it("drains tracked observe work before cost summaries are read", async () => {
		const runtime = {
			emit: vi.fn(async () => undefined),
		};
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: false },
			}),
			makeTempDir("mem-claw-observe-drain-"),
		);
		Object.assign(observability, { runtime });
		observability.aggregator.start("session-1");
		let release: () => void = () => {};
		const usageReady = new Promise<void>((resolve) => {
			release = resolve;
		});
		observability.trackBestEffort("memory.read", async () => {
			await usageReady;
			await observability.emit({
				eventType: "memory.read",
				sessionUuid: "session-1",
				payload: {
					query_hash: testHash("query"),
					query_tokens: 3,
					k: 5,
					hit_count: 1,
					result_tokens: 7,
					latency_ms: 1,
					tokens_method: "char_approximation",
				},
			});
		});

		const drained = observability.drain({ timeoutMs: 1000 });
		release();
		await drained;

		expect(observability.aggregator.summaryAndDelete("session-1")).toEqual(
			expect.objectContaining({
				memory_reads: 1,
				tokens_in: 0,
				tokens_out: 0,
				local_memory_input_tokens: 3,
				local_memory_output_tokens: 7,
			}),
		);
	});

	it("does not wait for memory write token counting before store returns", async () => {
		let releaseTokens: () => void = () => {};
		const tokensReady = new Promise<void>((resolve) => {
			releaseTokens = resolve;
		});
		countEmbeddingTokens.mockImplementationOnce(async () => {
			await tokensReady;
			return { count: 12, method: "char_approximation" as const };
		});

		const tracked: Promise<void>[] = [];
		const observability = {
			enabled: true,
			hashText: testHash,
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => {
				tracked.push(
					Promise.resolve()
						.then(task)
						.then(() => undefined),
				);
			},
		} as unknown as PluginObservability;
		const embedder = {
			dimensions: 1024,
			model: "test-embedder",
			providerKind: "local-onnx",
			warmup: async () => undefined,
			countTokens: (text: string) => countTokens(text),
			embedChunks: vi.fn(async (texts: string[]) =>
				texts.map(() => makeTestVector()),
			),
		} as unknown as Embedder;
		const store = new ObservableMemoryStore(
			{
				dbPath: join(makeTempDir("mem-claw-observe-store-"), "memory.sqlite"),
				embedder,
			},
			observability,
			() => "session-1",
			{ provider: "local-onnx" },
		);

		try {
			let writeSettled = false;
			const write = store
				.store({
					text: "remember delayed token counting",
					category: "episodic",
					projectId: "global",
				})
				.finally(() => {
					writeSettled = true;
				});

			await vi.waitFor(() => expect(countEmbeddingTokens).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(writeSettled).toBe(true));
			await expect(write).resolves.toEqual(
				expect.objectContaining({
					category: "episodic",
					projectId: "global",
				}),
			);

			releaseTokens();
			await Promise.allSettled(tracked);
			expect(observability.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "memory.write",
					scope: { project_id: "global" },
					payload: expect.not.objectContaining({ scope: expect.anything() }),
				}),
			);
		} finally {
			releaseTokens();
			await store.close();
		}
	});

	it("resolves llm config before invoking the inner call so usage is read without an intervening await", async () => {
		// The inner LlmClient stores getLastUsage() in shared per-client state.
		// The wrapper must resolve config BEFORE the inner call so getLastUsage()
		// is read on the immediate synchronous line after the call resolves — no
		// await between them, so an overlapping call can't overwrite usage first.
		// Pre-fix code invoked the inner call first, then awaited getResolvedConfig,
		// opening that window; this asserts the ordering that closes it.
		let innerCallCount = 0;
		let releaseConfig: () => void = () => {};
		const configReady = new Promise<void>((resolve) => {
			releaseConfig = resolve;
		});
		const resolvedConfig: ResolvedLlmConfig = {
			preset: "mem_claw/sno_ai_extract",
			provider: "sno-gpu",
			model: "qwen",
		};
		const inner: LlmClient = {
			async completeJson<T>(_request: MemoryLlmRequest): Promise<T | null> {
				innerCallCount += 1;
				return null;
			},
			async completeText(): Promise<string | null> {
				return null;
			},
			async getResolvedConfig(): Promise<ResolvedLlmConfig> {
				await configReady;
				return resolvedConfig;
			},
			getLastError: () => null,
			getLastUsage: () => ({ inputTokens: 5, outputTokens: 7, totalTokens: 12 }),
		};
		const observability = {
			emit: vi.fn(async () => undefined),
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => void | Promise<void>) => {
				void Promise.resolve().then(task);
			},
		} as unknown as PluginObservability;

		const wrapper = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract" },
			observability,
			() => "session-1",
		);

		const pending = wrapper.completeJson({
			prompt: "hi",
			callId: "E1",
		});
		await flushAsyncWork();
		expect(innerCallCount).toBe(0);

		releaseConfig();
		await pending;
		expect(innerCallCount).toBe(1);
	});
});
