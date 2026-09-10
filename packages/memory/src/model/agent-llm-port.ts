/** @file agent-llm-port.ts
 * @purpose Universal call surface for borrowing the host agent's LLM (the agent-host-seam transport).
 * @boundary Types and result contracts only; host bindings live in plugin/, dispatch in llm-client.ts.
 */

/**
 * One completion request against the host agent's configured model. The
 * binding absorbs its transport's limitations (OAuth, cancellation shape,
 * unsupported knobs) — callers never branch on host specifics.
 */
export type AgentLlmRequest = {
	/** System prompt; the binding places it wherever its transport expects. */
	system?: string;
	/** User prompt content. */
	prompt: string;
	/** Best-effort output bound; stripped when the transport rejects it. */
	maxTokens?: number;
	/** Overrides the host binding's default-off reasoning mode for this request. */
	enableThinking?: boolean;
	/** Deadline; the binding MUST terminate the underlying request. */
	timeoutMs?: number;
	/** Cooperative cancellation; the binding MUST honor it. */
	signal?: AbortSignal;
};

/**
 * Typed completion result. Cancellation and errors are values, not thrown:
 * a cancelled call must never be readable as "the model found nothing"
 * (the SnoStationMem seam resolves aborted calls with a normal-shaped empty
 * response, which is exactly the trap this shape exists to close).
 */
export type AgentLlmCompletion =
	| { kind: "ok"; text: string }
	| { kind: "cancelled"; reason: string }
	| {
			kind: "error";
			/**
			 * auth: generic credential rejection. credential-expired and
			 * credential-revoked preserve actionable OAuth states. exhausted:
			 * the subscription has reached a hard usage limit. throttle:
			 * transient rate limit. transport: the seam is unavailable.
			 * unknown: everything else.
			 */
			category:
				| "auth"
				| "credential-expired"
				| "credential-revoked"
				| "exhausted"
				| "throttle"
				| "transport"
				| "unknown";
			message: string;
	  };

export interface AgentLlmPort {
	complete(request: AgentLlmRequest): Promise<AgentLlmCompletion>;
}
