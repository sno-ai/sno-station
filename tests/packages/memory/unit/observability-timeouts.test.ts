import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter.ts";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types.ts";

const tempDirs: string[] = [];
let diagnosticWrites: ReturnType<typeof vi.spyOn>;
beforeEach(() => { diagnosticWrites = vi.spyOn(process.stderr, "write"); });
function hasDiagnostic(event: string, attributes: Record<string, unknown> = {}): boolean {
	return diagnosticWrites.mock.calls.some(([bytes]) => {
		try {
			const row = JSON.parse(String(bytes));
			return row.event_name === event && Object.entries(attributes).every(([key,value]) => row.attributes?.[key] === value);
		} catch { return false; }
	});
}

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("observability timeout bounds", () => {
	it("clears flush timeout timers after a successful flush", async () => {
		vi.useFakeTimers();
		const logger = { warn: vi.fn() };
		const runtime = {
			flush: vi.fn(async () => undefined),
		};
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: false },
			}),
			makeTempDir("mem-claw-observe-flush-"),
			logger,
		);
		Object.assign(observability, { runtime });

		await observability.flush({ timeoutMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);

		expect(hasDiagnostic("sno_station_mem.adapter.sno.observe.flush.timed.out")).toBe(false);
	});

	it("records cost counters synchronously regardless of runtime.emit progress", async () => {
		const logger = { warn: vi.fn() };
		const runtime = {
			emit: vi.fn(async () => undefined),
		};
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: false },
			}),
			makeTempDir("mem-claw-observe-cost-counters-"),
			logger,
		);
		Object.assign(observability, { runtime });

		await observability.emit({
			eventType: "llm.call",
			sessionUuid: "session-1",
			payload: {
				prompt_tokens: 10,
				completion_tokens: 2,
				token_source: "host_agent_paid",
			},
		});
		await observability.emit({
			eventType: "llm.call",
			sessionUuid: "session-1",
			payload: {
				prompt_tokens: 20,
				completion_tokens: 3,
				token_source: "host_agent_paid",
			},
		});

		expect(runtime.emit).toHaveBeenCalledTimes(2);
		expect(observability.aggregator.summaryAndDelete("session-1")).toEqual(
			expect.objectContaining({
				tokens_in: 30,
				tokens_out: 5,
				llm_calls: 2,
				host_agent_prompt_tokens: 30,
				host_agent_completion_tokens: 5,
				plugin_internal_prompt_tokens: 0,
				plugin_internal_completion_tokens: 0,
				local_memory_input_tokens: 0,
				local_memory_output_tokens: 0,
			}),
		);
	});

	it("routes observe event types through their canonical lanes", async () => {
		const runtime = {
			emit: vi.fn(async () => undefined),
		};
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: false },
			}),
			makeTempDir("mem-claw-observe-lane-"),
		);
		Object.assign(observability, { runtime });

		await observability.emit({
			eventType: "llm.call",
			sessionUuid: "session-1",
			payload: {
				model: "openai:gpt-4o",
				prompt_tokens: 10,
				completion_tokens: 2,
				latency_ms: 1,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				token_source: "host_agent_paid",
			},
		});
		await observability.emit({
			eventType: "memory.write",
			sessionUuid: "session-1",
			payload: {
				key_hash:
					"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				byte_len: 10,
				content_tokens: 3,
				tokens_method: "char_approximation",
			},
		});
		await observability.emit({
			eventType: "tool.call",
			sessionUuid: "session-1",
			payload: {
				tool_name: "memory_search",
				decision: "allow",
				input_hash:
					"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				output_hash:
					"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
				latency_ms: 2,
			},
		});

		expect(runtime.emit).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ event_type: "llm.call", lane: "llm" }),
		);
		expect(runtime.emit).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ event_type: "memory.write", lane: "memory" }),
		);
		await observability.emit({
			eventType: "permission.request",
			sessionUuid: "session-1",
			payload: {
				kind: "shell",
				decision: "deny",
				target_hash:
					"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			},
		});

		expect(runtime.emit).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ event_type: "tool.call", lane: "skill" }),
		);
		expect(runtime.emit).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ event_type: "permission.request", lane: "security" }),
		);
	});

	it("keeps emitting after a background task hangs: no cooldown, no queue cap, no circuit", async () => {
		vi.useFakeTimers();
		const observability = new PluginObservability(
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx" },
				observe: { enabled: false },
			}),
			makeTempDir("mem-claw-observe-no-block-"),
			{ warn: vi.fn() },
		);
		const completed = vi.fn();

		for (let i = 0; i < 60; i++) {
			observability.trackBestEffort("hung", () => new Promise(() => undefined));
		}
		await vi.advanceTimersByTimeAsync(5_000);
		observability.trackBestEffort("hung", completed);
		observability.trackBestEffort("other", completed);
		await Promise.resolve();

		expect(hasDiagnostic("observability.background.timed_out", { action: "hung" })).toBe(true);
		expect(hasDiagnostic("observability.background.rejected")).toBe(false);
		expect(hasDiagnostic("observability.background.paused")).toBe(false);
		expect(completed).toHaveBeenCalledTimes(2);
	});
});
