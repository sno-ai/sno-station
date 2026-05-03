import { canonicalJson } from "./canonical-json.js";
import type { EventScope, HashChain, JsonObject, WireEnvelope } from "./types.js";

function hashChainJson(hashChain: HashChain): string {
	return `{${[
		`"prev":${JSON.stringify(hashChain.prev)}`,
		`"self":${JSON.stringify(hashChain.self)}`,
	].join(",")}}`;
}

export function serializeEnvelope(envelope: WireEnvelope): string {
	return `{${[
		`"schema_version":${JSON.stringify(envelope.schema_version)}`,
		`"event_id":${JSON.stringify(envelope.event_id)}`,
		`"event_type":${JSON.stringify(envelope.event_type)}`,
		`"lane":${JSON.stringify(envelope.lane)}`,
		`"ts_edge_ms":${envelope.ts_edge_ms}`,
		`"consent_level":${JSON.stringify(envelope.consent_level)}`,
		`"redacted":${envelope.redacted ? "true" : "false"}`,
		`"chain_epoch":${envelope.chain_epoch}`,
		`"seq":${envelope.seq}`,
		`"scope":${canonicalJson(envelope.scope)}`,
		`"hash_chain":${hashChainJson(envelope.hash_chain)}`,
		`"payload":${canonicalJson(envelope.payload)}`,
	].join(",")}}`;
}

export function createEnvelope(input: {
	eventId: string;
	eventType: WireEnvelope["event_type"];
	lane: WireEnvelope["lane"];
	tsEdgeMs: number;
	consentLevel: WireEnvelope["consent_level"];
	redacted: boolean;
	chainEpoch: number;
	seq: number;
	scope: EventScope;
	hashChain: HashChain;
	payload: JsonObject;
}): WireEnvelope {
	return {
		schema_version: "v1",
		event_id: input.eventId,
		event_type: input.eventType,
		lane: input.lane,
		ts_edge_ms: input.tsEdgeMs,
		consent_level: input.consentLevel,
		redacted: input.redacted,
		chain_epoch: input.chainEpoch,
		seq: input.seq,
		scope: input.scope,
		hash_chain: input.hashChain,
		payload: input.payload,
	};
}
