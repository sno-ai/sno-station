/** @file openclaw-agent-llm-binding.ts
 * @purpose OpenClaw binding for the agent-host-seam transport (borrow the host agent's model).
 * @boundary Host SDK access only; the port contract lives in shared/agent-llm-port.ts.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { classifyLlmFailure, readErrorMessage, readErrorStatus } from "@snoai/memory/internal/model/llm-failure";

import type {
	AgentLlmCompletion,
	AgentLlmPort,
	AgentLlmRequest,
} from "@snoai/memory/internal/model/agent-llm-port";

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function categorizeError(error: unknown): AgentLlmCompletion {
	const message = readErrorMessage(error);
	const failure = classifyLlmFailure({ status: readErrorStatus(error), message });
	switch (failure.category) {
		case "credential-revoked":
			return { kind: "error", category: failure.category, message: `host agent credential revoked — re-authenticate the agent (${message.slice(0, 200)})` };
		case "credential-expired":
			return { kind: "error", category: failure.category, message: `host agent credential expired — re-authenticate the agent (${message.slice(0, 200)})` };
		case "auth":
			return { kind: "error", category: failure.category, message: `host agent credential rejected — re-authenticate the agent (${message.slice(0, 200)})` };
		default:
			return { kind: "error", category: failure.category, message: message.slice(0, 300) };
	}
}

export type OpenClawAgentLlmHost = {
	complete: OpenClawPluginApi["runtime"]["llm"]["complete"];
};

/** Builds the agent LLM port from the host's typed completion function. */
export function createOpenClawAgentLlmBinding(host: OpenClawAgentLlmHost): AgentLlmPort {
	return {
		async complete(request: AgentLlmRequest): Promise<AgentLlmCompletion> {
			const abort = new AbortController();
			let cancellationReason = "deadline";
			const abortWithReason = (reason: string, cause?: unknown) => {
				if (abort.signal.aborted) return;
				cancellationReason = reason;
				abort.abort(cause ?? new Error(reason));
			};
			const timers: Array<ReturnType<typeof setTimeout>> = [];
			if (request.timeoutMs !== undefined) {
				timers.push(
					setTimeout(() => abortWithReason("deadline"), request.timeoutMs),
				);
			}
			const forwardAbort = () => {
				abortWithReason("external-signal", request.signal?.reason);
			};
			if (request.signal) {
				if (request.signal.aborted) forwardAbort();
				else request.signal.addEventListener("abort", forwardAbort, { once: true });
			}
			const cleanupAbort = () => {
				for (const timer of timers) clearTimeout(timer);
				request.signal?.removeEventListener("abort", forwardAbort);
			};

			try {
				const result = await awaitWithAbort(
					host.complete({
						messages: [{ role: "user", content: request.prompt }],
						...(request.system ? { systemPrompt: request.system } : {}),
						...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
						reasoning: request.enableThinking ? "medium" : "off",
						signal: abort.signal,
					}),
					abort.signal,
				);
				const text = result.text.trim();
				if (!text) {
					return { kind: "error", category: "unknown", message: "empty completion from host seam" };
				}
				return { kind: "ok", text };
			} catch (error) {
				if (abort.signal.aborted) {
					return { kind: "cancelled", reason: cancellationReason };
				}
				return categorizeError(error);
			} finally {
				cleanupAbort();
			}
		},
	};
}
