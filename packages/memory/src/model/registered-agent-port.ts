import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ContractError, type DegradedReason } from "../contract/error";
import type { Registration } from "../contract/inputs";
import type { AgentLlmCompletion, AgentLlmPort, AgentLlmRequest } from "./agent-llm-port";
import { classifyLlmFailure, isTerminalLlmFailure } from "./llm-failure";

const CALLBACK_TIMEOUT_MS = 120_000;
const CATEGORIES = ["auth", "credential-expired", "credential-revoked", "exhausted", "throttle", "transport", "unknown"] as const;
const relayedFailureSchema = z.object({ error: z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("cancelled"), reason: z.string() }),
	z.object({ kind: z.literal("error"), category: z.enum(CATEGORIES), message: z.string() }),
]) });

export class RegisteredAgentPort implements AgentLlmPort {
	private readonly failures = new AsyncLocalStorage<Map<string, DegradedReason>>();
	constructor(private readonly model: Registration["model"]) {}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const failures = new Map<string, DegradedReason>();
		return this.failures.run(failures, async () => {
			try {
				const result = await operation();
				// A completed call only surfaces a refusal the engine cannot degrade past; throttle,
				// transient transport errors and deadlines were already handled by the llm-client.
				const failure = failures.values().next().value;
				if (failure === "no-agent-endpoint") throw new ContractError(failure);
				return result;
			} catch (error) {
				const failure = failures.values().next().value;
				if (failure) throw new ContractError(failure);
				throw error;
			}
		});
	}

	async complete(request: AgentLlmRequest): Promise<AgentLlmCompletion> {
		const identity = createHash("sha256").update(request.system ?? "").update("\0").update(request.prompt).digest("hex");
		const failures = this.failures.getStore();
		if (!this.model) {
			failures?.set(identity, "no-agent-endpoint");
			return { kind: "error", category: "transport", message: "no-agent-endpoint" };
		}
		const deadline = AbortSignal.timeout(request.timeoutMs ?? CALLBACK_TIMEOUT_MS);
		const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
		try {
			const url = this.model.baseUrl.endsWith("/chat/completions") ? this.model.baseUrl : `${this.model.baseUrl.replace(/\/$/, "")}/chat/completions`;
			const response = await fetch(url, {
				method: "POST", signal,
				headers: { "content-type": "application/json", Authorization: `Bearer ${this.model.credential}` },
				body: JSON.stringify({ model: this.model.model, stream: false,
					messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }],
					...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
					...(request.enableThinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: request.enableThinking } }),
				}),
			});
			if (!response.ok) {
				const relayed = await relayedFailure(response);
				if (relayed) {
					failures?.set(identity, relayed.kind === "cancelled" ? "timeout" : isTerminalLlmFailure(relayed.category) ? "no-agent-endpoint" : "engine-failed");
					return relayed;
				}
				const failure = classifyLlmFailure({ status: response.status });
				failures?.set(identity, failure.endpointRefused ? "no-agent-endpoint" : "engine-failed");
				return { kind: "error", category: failure.category, message: `registered model HTTP ${response.status}` };
			}
			const body: unknown = await response.json();
			const text = completionText(body);
			if (text === undefined) {
				failures?.set(identity, "engine-failed");
				return { kind: "error", category: "transport", message: "registered model response is invalid" };
			}
			// A successful retry clears only the failed request with the same prompt.
			failures?.delete(identity);
			return { kind: "ok", text };
		} catch {
			failures?.set(identity, signal.aborted ? "timeout" : "engine-failed");
			return signal.aborted ? { kind: "cancelled", reason: "deadline" }
				: { kind: "error", category: "transport", message: "no-agent-endpoint" };
		}
	}
}

/** A registered callback relays the binding's typed failure in its body; anything else is a plain HTTP failure. */
async function relayedFailure(response: Response): Promise<Exclude<AgentLlmCompletion, { kind: "ok" }> | undefined> {
	try {
		const parsed = relayedFailureSchema.safeParse(await response.json());
		return parsed.success ? parsed.data.error : undefined;
	} catch {
		return undefined;
	}
}

function completionText(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) return undefined;
	const first: unknown = body.choices[0];
	if (!first || typeof first !== "object" || !("message" in first)) return undefined;
	const message = first.message;
	return message && typeof message === "object" && "content" in message && typeof message.content === "string" ? message.content : undefined;
}
