import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostAggregator } from "../../../../packages/memory/src/engine/observability/cost-aggregator.ts";
import { ObservableLlmClient } from "../../../../packages/memory/src/engine/observability/observable-llm-client.ts";
import {
	readInstalledPackageVersion,
	readNamedPackageVersion,
	readSnoStationCoreWorkspaceVersion,
} from "../../../../packages/memory/src/engine/observability/version-metadata.ts";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerRuntimeHooks } from "../../../../apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts";
import {
	createLlmClient,
	type LlmClient,
} from "../../../../packages/memory/src/model/llm-client.ts";
import { pickLlmRoutingConfig } from "../../../../packages/memory/src/model/llm-mode-routing.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";

/**
 * The local ranker, stated explicitly. Nothing in this file exercises the remote
 * reranker, and a mode that resolves to the cross-encoder is refused without its key
 * (owner ruling 2026-08-30), so the fixture names the ranker it has always used.
 */
const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;
const modelCalls = JSON.parse(readFileSync(new URL("../../../../packages/memory/settings.default.json", import.meta.url), "utf8")).modelCalls;

type HookHandler = (...args: unknown[]) => unknown;

const tempDirs: string[] = [];
const originalCwd = cwd();

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	chdir(originalCwd);
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("observe token sources and version metadata", () => {
	it("keeps paid LLM tokens separate from local memory tokens", () => {
		const aggregator = new CostAggregator();
		const sessionUuid = "019df6f3-eccc-73b5-a182-58c23cf121ea";

		aggregator.start(sessionUuid);
		aggregator.record("llm.call", sessionUuid, {
			prompt_tokens: 100,
			completion_tokens: 20,
			token_source: "host_agent_paid",
		});
		aggregator.record("llm.call", sessionUuid, {
			prompt_tokens: 7,
			completion_tokens: 3,
			token_source: "plugin_internal_paid",
		});
		aggregator.record("memory.write", sessionUuid, { content_tokens: 50 });
		aggregator.record("memory.read", sessionUuid, {
			query_tokens: 8,
			result_tokens: 30,
		});

		expect(aggregator.summaryAndDelete(sessionUuid)).toEqual(
			expect.objectContaining({
				tokens_in: 107,
				tokens_out: 23,
				host_agent_prompt_tokens: 100,
				host_agent_completion_tokens: 20,
				plugin_internal_prompt_tokens: 7,
				plugin_internal_completion_tokens: 3,
				local_memory_input_tokens: 58,
				local_memory_output_tokens: 30,
				llm_calls: 2,
				memory_writes: 1,
				memory_reads: 1,
			}),
		);
	});

	it("emits plugin internal LLM usage from provider-reported values", async () => {
		const tasks: Promise<unknown>[] = [];
		const inner = makeLlmClient({
			inputTokens: 17,
			outputTokens: 0,
			totalTokens: 17,
		});
			const emit = vi.fn(async () => undefined);
		const observability = {
			emit,
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract" },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await client.completeJson({
			prompt: "extract memory",
			callId: "E1",
		});
		await Promise.all(tasks);

		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "llm.call",
				payload: expect.objectContaining({
					prompt_tokens: 17,
					completion_tokens: 0,
					token_source: "plugin_internal_paid",
				}),
			}),
		);
	});

	it("falls back to local token counting when provider usage is unavailable", async () => {
		const tasks: Promise<unknown>[] = [];
		const inner = makeLlmClient(null);
			const emit = vi.fn(
				async (_event: {
					payload?: { prompt_tokens?: number; completion_tokens?: number };
				}) => undefined,
			);
		const observability = {
			emit,
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract" },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await client.completeJson({
			prompt: "extract memory",
			callId: "E1",
		});
		await Promise.all(tasks);

		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					prompt_tokens: expect.any(Number),
					completion_tokens: expect.any(Number),
					token_source: "plugin_internal_paid",
				}),
			}),
		);
	});

	it("does not emit paid LLM telemetry for a routed-off request", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const observability = {
			emit,
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const routing = pickLlmRoutingConfig({ ...pluginConfigSchema.parse({ mode: "local-first" }), modelCalls });
		const inner = createLlmClient({ preset: "mem_claw/sno_ai_extract", routing });
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract", routing },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await expect(
			client.completeJson({
				prompt: "extract memory",
				callId: "E1",
			}),
		).resolves.toBeNull();
		await Promise.all(tasks);

		expect(emit).not.toHaveBeenCalled();
	});

	it("does not emit plugin-paid telemetry for a host-seam request", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const observability = {
			emit,
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const routing = pickLlmRoutingConfig(
			{ ...pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "agent-native",
			}), modelCalls },
		);
		const inner = createLlmClient({
			preset: "mem_claw/sno_ai_extract",
			routing,
			agentPort: {
				async complete() {
					return { kind: "ok", text: "host reflection" };
				},
			},
		});
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract", routing },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await expect(
			client.completeText({
				prompt: "summarize session",
				callId: "R1",
			}),
		).resolves.toBe("host reflection");
		await Promise.all(tasks);

		expect(emit).not.toHaveBeenCalled();
	});

	it("falls back to local token counting when provider reports only total tokens", async () => {
		const tasks: Promise<unknown>[] = [];
		const inner = makeLlmClient({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 44,
		});
			const emit = vi.fn(
				async (_event: {
					payload?: { prompt_tokens?: number; completion_tokens?: number };
				}) => undefined,
			);
		const observability = {
			emit,
			emitError: vi.fn(async () => undefined),
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract" },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await client.completeJson({
			prompt: "extract memory",
			callId: "E1",
		});
		await Promise.all(tasks);

		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					prompt_tokens: expect.any(Number),
					completion_tokens: expect.any(Number),
					token_source: "plugin_internal_paid",
				}),
			}),
		);
			const payload = emit.mock.calls[0]?.[0]?.payload;
		expect(
			(payload?.prompt_tokens ?? 0) + (payload?.completion_tokens ?? 0),
		).toBeGreaterThan(0);
	});

	it("uses VERSION.yaml instead of stale package-local versions", () => {
		const root = makeTempDir("claw-version-root-");
		const nested = join(root, "apps", "mem-claw");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(root, "VERSION.yaml"), "version: 0.9.82\n");
		writeFileSync(
			join(nested, "package.json"),
			JSON.stringify({ version: "0.9.74" }),
		);

		chdir(nested);

		expect(readSnoStationCoreWorkspaceVersion({})).toBe("0.9.82");
	});

	it("reads the plugin's own manifest and the host's manifest for agent.identify versions", () => {
		const memoryManifest = JSON.parse(readFileSync(
			join(cwd(), "..", "..", "packages", "memory", "package.json"), "utf8",
		)) as { version: string };
		expect(readInstalledPackageVersion()).toBe(memoryManifest.version);

		// The gateway's entry file lives under node_modules/openclaw/dist; resolve a real file there.
		const hostEntry = createRequire(import.meta.url).resolve("openclaw/plugin-sdk/core");
		const hostRoot = hostEntry.slice(0, hostEntry.indexOf("/node_modules/openclaw/") + "/node_modules/openclaw".length);
		const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8")) as { version: string };
		expect(readNamedPackageVersion(dirname(hostEntry), "openclaw")).toBe(hostManifest.version);
		expect(readNamedPackageVersion(dirname(hostEntry), "not-a-package")).toBeUndefined();
	});

	it("emits an error instead of an empty llm.call when the inner client returns nothing", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const emitError = vi.fn(async () => undefined);
		const observability = {
			emit,
			emitError,
			trackBestEffort: (_label: string, task: () => Promise<void>) => {
				tasks.push(task());
			},
		};
		const inner = makeLlmClient(null);
		inner.completeJson = async <T>(): Promise<T | null> => null;
		const client = new ObservableLlmClient(
			inner,
			{ preset: "mem_claw/sno_ai_extract" },
			observability as never,
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);

		await client.completeJson({ prompt: "extract memory", callId: "E1" });
		await Promise.all(tasks);

		expect(emit).not.toHaveBeenCalled();
		expect(emitError).toHaveBeenCalledWith(
			"llm.call:usage_missing",
			expect.anything(),
			"019df6f3-eccc-73b5-a182-58c23cf121ea",
		);
	});

	it("measures host llm.call latency from llm_input and passes cache tokens through", async () => {
		vi.useFakeTimers();
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				emitError: vi.fn(async () => undefined),
				trackBestEffort: (_label: string, task: () => Promise<void>) => { tasks.push(task()); },
			},
			lookupActiveObserveSession: () => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		});
		const llmInput = handlers.get("llm_input");
		const llmOutput = handlers.get("llm_output");
		if (!llmInput || !llmOutput) throw new Error("llm hooks were not registered");

		await llmInput({ runId: "run-1", provider: "openai", model: "gpt-4o", prompt: "hi", historyMessages: [], imagesCount: 0 }, { sessionId: "s" });
		vi.advanceTimersByTime(1_235);
		await llmOutput(
			{ runId: "run-1", provider: "openai", model: "gpt-4o", usage: { input: 6402, output: 241, cacheRead: 5000, cacheWrite: 12 } },
			{ sessionId: "s" },
		);
		await Promise.all(tasks);

		expect(emit).toHaveBeenCalledWith(expect.objectContaining({
			eventType: "llm.call",
			payload: expect.objectContaining({
				latency_ms: 1_235,
				cache_read_tokens: 5000,
				cache_write_tokens: 12,
			}),
		}));
		const emitted = emit.mock.calls.at(0) as unknown as [{ payload: { latency_ms: number } }] | undefined;
		const latency = emitted?.[0].payload.latency_ms;
		expect(Number.isInteger(latency)).toBe(true);
	});

	it("emits an error instead of an empty host llm.call when the host reports no usage or model", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const emitError = vi.fn(async () => undefined);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				emitError,
				trackBestEffort: (_label: string, task: () => Promise<void>) => { tasks.push(task()); },
			},
			lookupActiveObserveSession: () => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		await llmOutput({ runId: "run-2", provider: "", model: "", usage: { input: 0, output: 0 } }, { sessionId: "s" });
		await llmOutput({ runId: "run-3", provider: "openai", model: "gpt-4o" }, { sessionId: "s" });
		await Promise.all(tasks);

		expect(emit).not.toHaveBeenCalled();
		expect(emitError).toHaveBeenCalledTimes(2);
		expect(emitError).toHaveBeenCalledWith("llm.call:usage_missing", expect.stringContaining("run-2"), "019df6f3-eccc-73b5-a182-58c23cf121ea");
	});

	it("emits host-agent llm_output usage without taking over the hook result", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const lookupActiveObserveSession = vi.fn(
			() => "019df6f3-eccc-73b5-a182-58c23cf121ea",
		);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				trackBestEffort: (_label: string, task: () => Promise<void>) => {
					tasks.push(task());
				},
			},
			lookupActiveObserveSession,
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		const result = await llmOutput(
			{
				provider: "openai",
				model: "gpt-4o",
				usage: { input_tokens: 12, completion_tokens: 4 },
			},
			{ sessionId: "openclaw-session" },
		);
		await Promise.all(tasks);

		expect(result).toBeUndefined();
		expect(lookupActiveObserveSession).toHaveBeenCalledWith({
			sessionId: "openclaw-session",
		});
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "llm.call",
				payload: expect.objectContaining({
					model: "openai:gpt-4o",
					prompt_tokens: 12,
					completion_tokens: 4,
					token_source: "host_agent_paid",
				}),
			}),
		);
	});

	it("uses event session identity for llm_output only when ctx lacks one", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const lookupActiveObserveSession = vi.fn(
			(ctx: { sessionId?: string }) =>
				ctx.sessionId === "event-session"
					? "019df6f3-eccc-73b5-a182-58c23cf121ea"
					: undefined,
		);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				trackBestEffort: (_label: string, task: () => Promise<void>) => {
					tasks.push(task());
				},
			} as never,
			lookupActiveObserveSession,
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		await llmOutput(
			{
				provider: "openai",
				model: "gpt-4o",
				sessionId: "event-session",
				usage: { input_tokens: 12, completion_tokens: 4 },
			},
			{},
		);
		await Promise.all(tasks);

		expect(lookupActiveObserveSession).toHaveBeenCalledWith({
			sessionId: "event-session",
		});
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "llm.call",
				payload: expect.objectContaining({
					prompt_tokens: 12,
					completion_tokens: 4,
					token_source: "host_agent_paid",
				}),
			}),
		);
	});

	it("does not emit host usage for inactive event-derived session identity", async () => {
		const emit = vi.fn(async () => undefined);
		const trackBestEffort = vi.fn((_label: string, task: () => Promise<void>) =>
			task(),
		);
		const lookupActiveObserveSession = vi.fn(() => undefined);
		const handlers = registerRuntimeHookTest({
			observability: { emit, trackBestEffort } as never,
			lookupActiveObserveSession,
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		await llmOutput(
			{
				provider: "openai",
				model: "gpt-4o",
				sessionId: "stale-event-session",
				usage: { input_tokens: 12, completion_tokens: 4 },
			},
			{},
		);

		expect(lookupActiveObserveSession).toHaveBeenCalledWith({
			sessionId: "stale-event-session",
		});
		expect(trackBestEffort).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it("keeps ctx session identity authoritative over conflicting llm_output event identity", async () => {
		const tasks: Promise<unknown>[] = [];
		const emit = vi.fn(async () => undefined);
		const lookupActiveObserveSession = vi.fn(
			(ctx: { sessionId?: string }) =>
				ctx.sessionId === "ctx-session"
					? "019df6f3-eccc-73b5-a182-58c23cf121ea"
					: undefined,
		);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				trackBestEffort: (_label: string, task: () => Promise<void>) => {
					tasks.push(task());
				},
			} as never,
			lookupActiveObserveSession,
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		await llmOutput(
			{
				provider: "openai",
				model: "gpt-4o",
				sessionId: "event-session",
				usage: { input_tokens: 12, completion_tokens: 4 },
			},
			{ sessionId: "ctx-session" },
		);
		await Promise.all(tasks);

		expect(lookupActiveObserveSession).toHaveBeenCalledWith({
			sessionId: "ctx-session",
		});
		expect(lookupActiveObserveSession).not.toHaveBeenCalledWith({
			sessionId: "event-session",
		});
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "llm.call",
				payload: expect.objectContaining({
					token_source: "host_agent_paid",
				}),
			}),
		);
	});

	it("does not create or reopen observe sessions from llm_output hooks alone", async () => {
		const emit = vi.fn(async () => undefined);
		const startObserveSession = vi.fn(async () => undefined);
		const handlers = registerRuntimeHookTest({
			observability: {
				emit,
				trackBestEffort: vi.fn((_label: string, task: () => Promise<void>) => task()),
			},
			startObserveSession,
			lookupActiveObserveSession: vi.fn(() => undefined),
		});
		const llmOutput = handlers.get("llm_output");
		if (!llmOutput) throw new Error("llm_output hook was not registered");

		await llmOutput(
			{
				provider: "openai",
				model: "gpt-4o",
				usage: { input_tokens: 12, completion_tokens: 4 },
			},
			{ sessionId: "already-finalized-session" },
		);

		expect(startObserveSession).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it("finalizes agent_end observe session when duration is unavailable", async () => {
		const finalizeObserveSession = vi.fn(async () => undefined);
		const handlers = registerRuntimeHookTest({
			startObserveSession: vi.fn(async () => "019df6f3-eccc-73b5-a182-58c23cf121ea"),
			finalizeObserveSession,
		});
		const agentEnd = handlers.get("agent_end");
		if (!agentEnd) throw new Error("agent_end hook was not registered");

		await agentEnd(
			{ messages: [], success: true },
			{ sessionId: "openclaw-session" },
		);

		expect(finalizeObserveSession).toHaveBeenCalledWith(
			{ sessionId: "openclaw-session" },
			undefined,
		);
	});
});

function makeLlmClient(
	usage: ReturnType<LlmClient["getLastUsage"]>,
): LlmClient {
	return {
		async completeJson<T>(): Promise<T | null> {
			return { ok: true } as T;
		},
		async completeText(): Promise<string | null> {
			return "ok";
		},
		async getResolvedConfig() {
			return {
				preset: "mem_claw/sno_ai_extract",
				provider: "sno-gpu",
				model: "sno-extract",
			} as const;
		},
		getLastError: () => null,
		getLastUsage: () => usage,
	};
}

type RuntimeHookOverrides = {
	observability?: unknown;
	connection?: unknown;
	lookupActiveObserveSession?: (ctx: { sessionId?: string; sessionKey?: string }) => string | undefined;
	startObserveSession?: (...args: unknown[]) => Promise<string | undefined>;
	finalizeObserveSession?: (...args: unknown[]) => Promise<void>;
};

function registerRuntimeHookTest(overrides: RuntimeHookOverrides): Map<string, HookHandler> {
	const handlers = new Map<string, HookHandler>();
	const api = {
		logger: { info: vi.fn(), warn: vi.fn() },
		on(name: string, handler: HookHandler) {
			handlers.set(name, handler);
		},
	};
	const config = { sessionStrategy: "none", selfImprovement: { enabled: false } };
	const connection = overrides.connection ?? {
		ready: async () => ({ capture: async () => ({ degraded: false, committed: true }) }),
		scope: async () => ({ principal: "p", project: "global", session: "s", host: {} }),
	};
	const observe = {
		observedApi: api,
		observeSessionUuid: () => undefined,
		runInObserveSession: runObserveOperation,
		lookupActiveObserveSession: overrides.lookupActiveObserveSession ?? vi.fn(() => undefined),
		startObserveSession: overrides.startObserveSession ?? vi.fn(async () => undefined),
		finalizeObserveSession: overrides.finalizeObserveSession ?? vi.fn(async () => undefined),
	};
	const observability = overrides.observability ?? {
		emit: vi.fn(async () => undefined),
		trackBestEffort: vi.fn((_label: string, task: () => Promise<void>) => task()),
	};
	registerRuntimeHooks(api as never, config as never, connection as never, observe as never, observability as never);
	return handlers;
}

function runObserveOperation<T>(
	_sessionUuid: string,
	operation: () => Promise<T>,
): Promise<T> {
	return operation();
}
