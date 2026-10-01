import { readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file llmix-real-provider.e2e.test.ts
 * @purpose Proves the signed Sno GPU preset loads and the production Sno GPU route answers for real.
 * @boundary Bundled LLMIx registry, Sno production release anchor, and provider transport.
 * @see ../../../../apps/mem-claw/src/shared/llm-client.ts.
 */

import { describe, expect, it } from "vitest";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client.ts";

describe("LLMIx real provider E2E", () => {
	it(
		"loads the signed Sno GPU preset and receives JSON from the real provider",
		{ timeout: 90_000 },
		async () => {
			const client = createLlmClient({
				apiKey: readTestSnoGpuSettings().apiKey,
				preset: "mem_claw/sno_ai_extract",
				timeoutMs: 60_000,
			});

			const resolved = await client.getResolvedConfig();
			expect(resolved).toMatchObject({
				preset: "mem_claw/sno_ai_extract",
				provider: "sno-gpu",
			});

			const result = await client.completeJson<{
				ok: boolean;
				route: string;
				answer: string;
			}>({
				prompt:
					'Return this exact JSON object and no other text: {"ok":true,"route":"llmix-real-sno","answer":"pong"}',
				// The client accepts only table call ids; a test-only id would have to widen the
				// production call table just to be sent.
				callId: "E1",
			});

			if (result === null) {
				throw new Error(client.getLastError() ?? "LLMIx real provider E2E returned null");
			}

			expect(result.ok).toBe(true);
			expect(result.route).toBe("llmix-real-sno");
			expect(result.answer.toLowerCase()).toContain("pong");

			const usage = client.getLastUsage();
			expect(usage?.totalTokens).toBeGreaterThan(0);
		},
	);

});
