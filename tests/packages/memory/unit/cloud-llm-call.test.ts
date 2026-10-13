import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { ObservableLlmClient } from "../../../../packages/memory/src/engine/observability/observable-llm-client";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types";
import type { LlmClient, ProviderResponseTrace } from "../../../../packages/memory/src/model/llm-client-types";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { startMockServer } from "../../observability/fixtures/sno-ai-mock-server.mjs";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

for (const producer of ["observable client", "sidecar provider trace"]) {
	it(`${producer} sends the accepted llm.call payload through the real SDK`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "cloud-llm-call-"));
		vi.stubEnv("SNO_PROFILE_DIR", dir);
		const server = await startMockServer();
		const observability = new PluginObservability(pluginConfigSchema.parse({
			embedding: { provider: "local-onnx" }, observe: { enabled: true, agentId: "codex", baseUrl: server.baseUrl },
		}), dir);
		const sessionUuid = "018f7d0c-fd8b-7ccf-9b9b-0a2ea938ad0d";
		try {
			vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
			if (producer === "observable client") {
				// Only the external model is substituted; telemetry validation, storage and HTTP are real.
				const inner: LlmClient = {
					completeJson: async () => null,
					completeText: async () => "ok",
					getResolvedConfig: async () => ({ preset: "mem_claw/sno_ai_extract", provider: "sno-gpu", model: "qwen3.8-27b-extract" }),
					getLastError: () => null,
					getLastUsage: () => ({ inputTokens: 21, outputTokens: 3, totalTokens: 24 }),
				};
				const client = new ObservableLlmClient(inner, { preset: "mem_claw/sno_ai_extract" }, observability, () => sessionUuid);
				expect(await client.completeText({ callId: "E1", prompt: "extract memory" })).toBe("ok");
				await observability.drain();
				await observability.flush();
			} else {
				const report = (MemoryRuntimePool.prototype as unknown as {
					emitProviderUsage: (entry: { observability: PluginObservability }, scope: unknown, responses: ProviderResponseTrace[]) => Promise<void>;
				}).emitProviderUsage;
				await report.call({}, { observability }, { host: { observeSessionUuid: sessionUuid } }, [{
					callId: "E1", destination: "sno-gpu", provider: "sno-gpu", model: "qwen3.8-27b-extract", durationMs: 0,
					usage: { inputTokens: 21, outputTokens: 3, totalTokens: 24 },
				}]);
			}
			const events = server.calls.filter((call: { url: string }) => call.url === "/api/v1/events").map((call: { body: string }) => JSON.parse(call.body));
			expect(events.map((event: { event_type: string }) => event.event_type)).toEqual(["agent.identify", "llm.call"]);
			expect(events[1]).toMatchObject({ lane: "llm", scope: { agent_id: "codex", session_uuid: sessionUuid } });
			expect(events[1]?.payload).toEqual({
				model: "sno-gpu:qwen3.8-27b-extract", prompt_tokens: 21, completion_tokens: 3, latency_ms: 0,
				cache_read_tokens: 0, cache_write_tokens: 0, token_source: "plugin_internal_paid",
			});
		} finally {
			await observability.shutdown();
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
