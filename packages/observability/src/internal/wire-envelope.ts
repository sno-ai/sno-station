import { canonicalJson } from "./canonical-json.js";
import type { EventScope, HashChain, JsonObject, WireEnvelope } from "./types.js";

function hashChainJson(hashChain: HashChain): string {
	return `{${[
		`"chain_epoch":${hashChain.chain_epoch}`,
		`"seq":${hashChain.seq}`,
		`"prev":${JSON.stringify(hashChain.prev)}`,
		`"self":${JSON.stringify(hashChain.self)}`,
	].join(",")}}`;
}

export function serializeEnvelope(envelope: WireEnvelope): string {
	return `{${[
		`"event_id":${JSON.stringify(envelope.event_id)}`,
		`"event_type":${JSON.stringify(envelope.event_type)}`,
		`"ts_edge_ms":${envelope.ts_edge_ms}`,
		`"consent_level":${JSON.stringify(envelope.consent_level)}`,
		`"redacted":${envelope.redacted ? "true" : "false"}`,
		`"scope":${canonicalJson(envelope.scope)}`,
		`"hash_chain":${hashChainJson(envelope.hash_chain)}`,
		`"payload":${canonicalJson(envelope.payload)}`,
	].join(",")}}`;
}

export function createEnvelope(input: {
	eventId: string;
	eventType: WireEnvelope["event_type"];
	tsEdgeMs: number;
	consentLevel: WireEnvelope["consent_level"];
	redacted: boolean;
	scope: EventScope;
	hashChain: HashChain;
	payload: JsonObject;
}): WireEnvelope {
	return {
		event_id: input.eventId,
		event_type: input.eventType,
		ts_edge_ms: input.tsEdgeMs,
		consent_level: input.consentLevel,
		redacted: input.redacted,
		scope: input.scope,
		hash_chain: input.hashChain,
		payload: input.payload,
	};
}
