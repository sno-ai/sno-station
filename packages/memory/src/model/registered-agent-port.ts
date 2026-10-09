import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { z } from "zod";
import { ContractError, type DegradedReason } from "../contract/error";
import type { Registration } from "../contract/inputs";
import type { AgentLlmCompletion, AgentLlmPort, AgentLlmRequest } from "./agent-llm-port";
import { classifyLlmFailure, isTerminalLlmFailure } from "./llm-failure";
import { createLogger } from "@snoai/utils/logger";

const CALLBACK_TIMEOUT_MS = 120_000;
const CATEGORIES = ["auth", "credential-expired", "credential-revoked", "exhausted", "throttle", "transport", "unknown"] as const;
const relayedFailureSchema = z.object({ error: z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("cancelled"), reason: z.string() }),
	z.object({ kind: z.literal("error"), category: z.enum(CATEGORIES), message: z.string() }),
]) });

export class RegisteredAgentPort implements AgentLlmPort {
	private readonly failures = new AsyncLocalStorage<Map<string, DegradedReason>>();
	constructor(private readonly model: Registration["model"], private readonly onRefused?: () => void) {}

	async run<T>(operation: () => Promise<T>, failOnRefusal = false): Promise<T> {
		const failures = new Map<string, DegradedReason>();
		return this.failures.run(failures, async () => {
			let result: T;
			try {
				result = await operation();
			} catch (error) {
				const failure = failures.values().next().value;
				if (failure) throw new ContractError(failure);
				throw error;
			}
			const failure = failures.values().next().value;
			if (failOnRefusal && [...failures.values()].includes("no-agent-endpoint")) throw new ContractError("no-agent-endpoint");
			if (failure) createLogger("sno-station-mem:registered-agent-port").warn("Host model failed after operation completed", { failure }, {
				event_name: "memory.host.degraded", file: "packages/memory/src/model/registered-agent-port.ts",
				function: "run", site_id: "memory.host.degraded",
			});
			return result;
		});
	}

	async reachable(): Promise<boolean> {
		if (!this.model) return false;
		const url = new URL(this.model.baseUrl);
		const listening = await new Promise<boolean>(resolve => {
			const socket = connect({ host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
			const done = (open: boolean) => { socket.destroy(); resolve(open); };
			socket.setTimeout(2_000, () => done(false));
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
		});
		if (!listening) this.onRefused?.();
		return listening;
	}

	async complete(request: AgentLlmRequest): Promise<AgentLlmCompletion> {
		const identity = createHash("sha256").update(request.system ?? "").update("\0").update(request.prompt).digest("hex");
		const failures = this.failures.getStore();
		if (!this.model) {
			this.onRefused?.();
			failures?.set(identity, "no-agent-endpoint");
			return { kind: "error", category: "transport", message: "no-agent-endpoint" };
		}
		const deadline = AbortSignal.timeout(request.timeoutMs ?? CALLBACK_TIMEOUT_MS);
		const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
		let fetchCompleted = false;
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
			fetchCompleted = true;
			if (!response.ok) {
				const relayed = await relayedFailure(response);
				if (relayed) {
					failures?.set(identity, relayed.kind === "cancelled" ? "timeout" : isTerminalLlmFailure(relayed.category) ? "no-agent-endpoint" : "engine-failed");
					// A worker whose host child failed answers a typed 503; keep the status so REM counts it as a refusal.
					if (relayed.kind === "error" && response.status === 503) return { ...relayed, message: `registered model HTTP 503: ${relayed.message}` };
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
			if (!signal.aborted && !fetchCompleted) this.onRefused?.();
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
