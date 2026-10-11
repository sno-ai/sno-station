/** @file host-gone-recoverable.test.ts
 * @purpose A model call whose host is gone is marked as retried-later, and the error row it becomes says so.
 * @boundary The real llm client and the real RegisteredAgentPort with no endpoint; the real PluginObservability.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
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

it("records the error row as recoverable only when told so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "host-gone-"));
	try {
		const observability = new PluginObservability(pluginConfigSchema.parse({ embedding: { provider: "local-onnx" }, observe: { enabled: false } }), dir);
		Object.assign(observability, { runtime: { hashRedactedText: (text: string) => `hash:${text}` } });
		const emit = vi.spyOn(observability, "emit").mockResolvedValue();
		await observability.emitError("llm.call:host_transport", "agent-host-seam E10", "session", true);
		await observability.emitError("llm.call:provider_throw", "boom", "session");
		const recoverable = emit.mock.calls.map(([event]) => (event.payload as { recoverable: boolean }).recoverable);
		expect(recoverable).toEqual([true, false]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
