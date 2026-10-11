/** @file host-gone-deferred.test.ts
 * @purpose A model call whose host is gone is marked as deferred, and the sidecar reports no error row for it.
 * @boundary The real llm client and RegisteredAgentPort with no endpoint; the real MemoryRuntimePool reporting method and PluginObservability.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { withProviderResponses } from "../../../../packages/memory/src/model/llm-provider-transport";
import type { ProviderResponseTrace } from "../../../../packages/memory/src/model/llm-client-types";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";

it("marks a host call that found no agent as host-gone", async () => {
	// A one-shot session has exited; the sidecar still asks it for a model.
	const llm = createLlmClient({
		preset: "mem_claw/sno_ai_extract", apiKey: "", baseURL: "http://127.0.0.1:9",
		routing: { mode: "agent-native", language: "en", modelCalls: defaultSettings().modelCalls },
		agentPort: new RegisteredAgentPort(undefined),
	});
	const responses: ProviderResponseTrace[] = [];
	await withProviderResponses(responses, () => llm.completeText({ callId: "E10", prompt: "p", hostPrompt: "p", timeoutMs: 500, maxTokens: 16 }));
	const failed = responses.find(response => response.destination === "host");
	expect(failed).toMatchObject({ failure: "host_transport", hostGone: true });
});

it("reports no error row for a deferred save, and every other failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "host-gone-"));
	try {
		const observability = new PluginObservability(pluginConfigSchema.parse({ embedding: { provider: "local-onnx" }, observe: { enabled: false } }), dir);
		Object.assign(observability, { runtime: { hashRedactedText: (text: string) => `hash:${text}` } });
		const emit = vi.spyOn(observability, "emit").mockResolvedValue();
		vi.spyOn(observability, "flush").mockResolvedValue(undefined as never);
		const base = { callId: "E10", destination: "host", provider: "agent-host-seam" } as const;
		const responses = [{ ...base, failure: "host_transport", hostGone: true }, { ...base, failure: "host_timeout" }] as ProviderResponseTrace[];
		const scope = { principal: "p", project: "x", session: "s", host: { observeSessionUuid: "session-uuid" } };
		const report = (deferrable: boolean) => (MemoryRuntimePool.prototype as unknown as { emitProviderUsage: (...args: unknown[]) => Promise<void> })
			.emitProviderUsage.call({}, { observability }, scope, responses, deferrable);
		await report(true);
		expect(emit.mock.calls.map(([event]) => (event.payload as { kind: string }).kind)).toEqual(["llm.call:host_timeout"]);
		// Any other call that finds no host is a real failure: nothing retries it.
		emit.mockClear();
		await report(false);
		expect(emit.mock.calls.map(([event]) => (event.payload as { kind: string }).kind)).toEqual(["llm.call:host_transport", "llm.call:host_timeout"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
