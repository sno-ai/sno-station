/** @file openclaw-agent-llm-binding.test.ts
 * @purpose Proves the OpenClaw host seam preserves actionable failure categories end to end.
 * @boundary Production binding and LLM client; only the injected host completion result is doubled.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it } from "vitest";

import { createOpenClawAgentLlmBinding } from "../../../../apps/mem-claw/src/install/openclaw-agent-llm-binding.ts";
import type { AgentLlmPort } from "../../../../packages/memory/src/model/agent-llm-port.ts";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client.ts";
import type { LlmRoutingConfig } from "../../../../packages/memory/src/model/llm-mode-routing.ts";

type HostComplete = OpenClawPluginApi["runtime"]["llm"]["complete"];
type HostCompleteParams = Parameters<HostComplete>[0];
type ExpectedBindingHost = { complete: HostComplete };

const createBinding = createOpenClawAgentLlmBinding as unknown as (
	host: ExpectedBindingHost,
) => AgentLlmPort;

const hostSeam = {
	error: undefined as unknown,
	onRequest: undefined as ((request: HostCompleteParams) => void) | undefined,
	requests: [] as HostCompleteParams[],
	waitForAbort: false,
};

const complete: HostComplete = async (request) => {
	hostSeam.requests.push(request);
	hostSeam.onRequest?.(request);
	if (hostSeam.error !== undefined) throw hostSeam.error;
	if (hostSeam.waitForAbort) {
		return new Promise((_, reject) => {
			const signal = request.signal;
			if (!signal) {
				reject(new Error("expected host completion signal"));
				return;
			}
			const rejectAbort = () => reject(signal.reason ?? new Error("cancelled"));
			if (signal.aborted) rejectAbort();
			else signal.addEventListener("abort", rejectAbort, { once: true });
		});
	}
	return {
		text: "ready",
		provider: "host-provider-test-double",
		model: "host-model-test-double",
		agentId: "main",
		usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 },
		execution: {
			mode: "direct-provider",
			owner: { kind: "provider", id: "host-provider-test-double" },
		},
		audit: { caller: { kind: "plugin", id: "sno-mem-claw" } },
	};
};

const ROUTING: LlmRoutingConfig = { mode: "agent-native", language: "en" };

const CASES = [
	{
		name: "transient 429",
		error: { status: 429, message: "Too Many Requests" },
		reason: "Too Many Requests",
		category: "throttle",
		terminal: false,
	},
	{
		name: "hard subscription exhaustion",
		error: new Error("You've reached your Codex subscription usage limit."),
		reason: "You've reached your Codex subscription usage limit.",
		category: "exhausted",
		terminal: false,
	},
	{
		name: "expired access token",
		error: new Error("expired access token"),
		reason: "expired access token",
		category: "credential-expired",
		terminal: true,
	},
	{
		name: "revoked refresh grant",
		error: new Error("OAuth token refresh failed for openai: invalid_grant (token revoked)"),
		reason: "OAuth token refresh failed for openai: invalid_grant (token revoked)",
		category: "credential-revoked",
		terminal: true,
	},
] as const;

async function waitForHostRequest(started: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("injected host complete was not called")), 1_000);
	});
	try {
		await Promise.race([started, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("OpenClaw agent LLM binding taxonomy", () => {
	beforeEach(() => {
		hostSeam.error = undefined;
		hostSeam.onRequest = undefined;
		hostSeam.requests.length = 0;
		hostSeam.waitForAbort = false;
	});

	it("returns host text through the typed completion surface", async () => {
		const pluginPrompt = `You are a memory reflection assistant. Return concise plain text only. ${"Classify every candidate in the supplied session context. ".repeat(6)}`;
		const binding = createBinding({ complete });
		await expect(
			binding.complete({
				system: "Plugin-owned reflection instructions.",
				prompt: pluginPrompt,
			}),
		).resolves.toEqual({ kind: "ok", text: "ready" });

		expect(hostSeam.requests).toHaveLength(1);
		expect(hostSeam.requests[0]?.messages).toEqual([
			{ role: "user", content: pluginPrompt },
		]);
		expect(hostSeam.requests[0]?.systemPrompt).toBe("Plugin-owned reflection instructions.");
	});

	it("enables host reasoning for date resolution without changing ordinary host calls", async () => {
		const binding = createBinding({ complete });
		const client = createLlmClient({
			preset: "mem_claw/sno_ai_extract",
			agentPort: binding,
			routing: ROUTING,
		});

		await expect(
			client.completeText({
				prompt: "Resolve glorpday against the supplied anchor.",
				callId: "E11",
				enableThinking: true,
			}),
		).resolves.toBe("ready");
		await expect(
			client.completeText({
				prompt: "Summarize this session.",
				callId: "R1",
			}),
		).resolves.toBe("ready");

		expect(hostSeam.requests).toHaveLength(2);
		expect(hostSeam.requests[0]?.reasoning).toBe("medium");
		expect(hostSeam.requests[1]?.reasoning).toBe("off");
	});

	it("returns deadline cancellation when the host call outlives timeoutMs", async () => {
		hostSeam.waitForAbort = true;
		const binding = createBinding({ complete });

		await expect(
			binding.complete({ prompt: "Wait for the deadline.", timeoutMs: 10 }),
		).resolves.toEqual({ kind: "cancelled", reason: "deadline" });
	});

	it("returns external-signal cancellation when the caller aborts", async () => {
		hostSeam.waitForAbort = true;
		const controller = new AbortController();
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		hostSeam.onRequest = markStarted;
		const binding = createBinding({ complete });
		const request = binding.complete({
			prompt: "Wait for caller cancellation.",
			signal: controller.signal,
		});
		await waitForHostRequest(started);
		controller.abort(new Error("caller cancelled"));

		await expect(request).resolves.toEqual({
			kind: "cancelled",
			reason: "external-signal",
		});
	});

	it.each(CASES)(
		"keeps $name distinguishable at the binding and reports expired and revoked credentials to the client as auth",
		async (testCase) => {
			hostSeam.error = testCase.error;
			const binding = createBinding({ complete });
			const completion = await binding.complete({ prompt: "Return JSON." });
			expect(completion).toMatchObject({
				kind: "error",
				category: testCase.category,
				message: expect.stringContaining(testCase.reason),
			});

			const client = createLlmClient({
				preset: "mem_claw/sno_ai_extract",
				agentPort: binding,
				routing: ROUTING,
			});
			const request = client.completeJson({
				prompt: "Return JSON.",
				callId: "P4",
			});
			if (testCase.terminal) {
				await expect(request).rejects.toMatchObject({ category: "auth" });
			} else {
				await expect(request).resolves.toBeNull();
				expect(client.getLastError()).toContain(testCase.category);
			}
		},
	);
});
