import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import type { ConsentValue, EventScope, EventType, JsonObject } from "./types.js";

export interface CanonicalHashInput {
	eventId: string;
	eventType: EventType;
	tsEdgeMs: number;
	scope: EventScope;
	chainEpoch: number;
	seq: number;
	consentLevel: ConsentValue;
	redacted: boolean;
	payload: JsonObject;
	prev: string;
}

export function canonicalPreimage(input: CanonicalHashInput): string {
	return [
		"v1",
		input.eventId,
		input.eventType,
		String(input.tsEdgeMs),
		canonicalJson(input.scope),
		String(input.chainEpoch),
		String(input.seq),
		input.consentLevel,
		input.redacted ? "1" : "0",
		canonicalJson(input.payload),
		input.prev,
	].join("\n");
}

export function computeSelfHash(input: CanonicalHashInput): string {
	return sha256Hex(canonicalPreimage(input));
}
