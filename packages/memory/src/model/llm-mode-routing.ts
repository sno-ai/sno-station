/** @file llm-mode-routing.ts
 * @purpose Resolve one model call id to its configured destination and transport.
 */
import {
	type LlmRoutingConfig,
	type LlmRoutingConfigInput,
	llmRoutingConfigSchema,
} from "../../config/plugin-config-mode-schema";
import { MODEL_CALLS, modelCallDestination, type ModelCallId } from "./model-call-table";

export type { LlmRoutingConfig };
export type LlmTransport = "chat-completions" | "raw-completions" | "agent-host-seam";
export type LlmParser = "json" | "json-or-single-token-verdict" | "single-token-verdict" | "text";
export type LlmRouteTarget = {
	tier: "agent" | "snoRemMem";
	destination: "host" | "sno-gpu";
	transport: LlmTransport;
	parser: LlmParser;
};
export type LlmRouteOff = { off: true; reason: "mode-local-first" };
export type LlmRouteDecision = LlmRouteTarget | LlmRouteOff;

export function pickLlmRoutingConfig(config: LlmRoutingConfigInput): LlmRoutingConfig {
	return llmRoutingConfigSchema.parse({
		mode: config.mode,
		language: config.language,
	});
}

export function resolveLlmRoute(input: {
	callId: ModelCallId;
	config: LlmRoutingConfigInput;
}): LlmRouteDecision {
	const routing = pickLlmRoutingConfig(input.config);
	const call = MODEL_CALLS[input.callId];
	const destination = modelCallDestination(input.callId, routing.mode);
	if (destination === "off") return { off: true, reason: "mode-local-first" };
	if (destination === "host") {
		return {
			tier: "agent",
			destination,
			transport: call.transport.host,
			parser: call.replyParser.host,
		};
	}
	return {
		tier: "snoRemMem",
		destination,
		transport: call.transport.snoGpu,
		parser: call.replyParser.snoGpu,
	};
}
