/** @file reflection-store-payload-builder.ts
 * @purpose Build reflection event, item, and legacy payloads for storage.
 * @boundary Pure payload assembly from parsed reflection text and caller context.
 */

import {
	buildReflectionEventPayload,
	createReflectionEventId,
} from "./event-payload-builder";
import {
	extractInjectableReflectionSliceItems,
	extractInjectableReflectionSlices,
	type ReflectionSlices,
} from "./markdown-slice-parser";
import { buildReflectionItemPayloads } from "./slice-item-payload-builder";
import {
	type BuildReflectionStorePayloadsParams,
	REFLECTION_DERIVE_LOGISTIC_K,
	REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
	type ReflectionStorePayload,
} from "./reflection-entry-projector-types";
import { computeDerivedLineQuality, resolveLegacyDeriveBaseWeight } from "./reflection-line-loader";

export function buildReflectionStorePayloads(params: BuildReflectionStorePayloadsParams): {
	eventId: string;
	slices: ReflectionSlices;
	payloads: ReflectionStorePayload[];
} {
	const slices = extractInjectableReflectionSlices(params.reflectionText);
	const eventId =
		params.eventId ||
		createReflectionEventId({
			runAt: params.runAt,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: params.agentId,
			command: params.command,
		});

	const payloads: ReflectionStorePayload[] = [
		buildReflectionEventPayload({
			eventId,
			scope: params.scope,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: params.agentId,
			command: params.command,
			toolErrorSignals: params.toolErrorSignals,
			runAt: params.runAt,
			usedFallback: params.usedFallback,
			sourceReflectionPath: params.sourceReflectionPath,
		}),
	];

	payloads.push(
		...buildReflectionItemPayloads({
			items: extractInjectableReflectionSliceItems(params.reflectionText),
			eventId,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			runAt: params.runAt,
			usedFallback: params.usedFallback,
			toolErrorSignals: params.toolErrorSignals,
			sourceReflectionPath: params.sourceReflectionPath,
		}),
	);

	if (
		params.writeLegacyCombined === true &&
		(slices.invariants.length > 0 || slices.derived.length > 0)
	) {
		payloads.push(
			buildLegacyCombinedPayload({
				slices,
				scope: params.scope,
				sessionKey: params.sessionKey,
				sessionId: params.sessionId,
				agentId: params.agentId,
				command: params.command,
				toolErrorSignals: params.toolErrorSignals,
				runAt: params.runAt,
				usedFallback: params.usedFallback,
				sourceReflectionPath: params.sourceReflectionPath,
			}),
		);
	}

	return { eventId, slices, payloads };
}

function buildLegacyCombinedPayload(params: {
	slices: ReflectionSlices;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
	scope: string;
	toolErrorSignals: Array<{ signatureHash: string }>;
	runAt: number;
	usedFallback: boolean;
	sourceReflectionPath?: string;
}): ReflectionStorePayload {
	const dateYmd = new Date(params.runAt).toISOString().split("T")[0];
	const deriveQuality = computeDerivedLineQuality(params.slices.derived.length);
	const deriveBaseWeight = params.usedFallback
		? resolveLegacyDeriveBaseWeight({ usedFallback: true })
		: 1;

	return {
		kind: "combined-legacy",
		text: [
			`reflection · ${params.scope} · ${dateYmd}`,
			`Session Reflection (${new Date(params.runAt).toISOString()})`,
			`Session Key: ${params.sessionKey}`,
			`Session ID: ${params.sessionId}`,
			"",
			"Invariants:",
			...(params.slices.invariants.length > 0
				? params.slices.invariants.map((x) => `- ${x}`)
				: ["- (none captured)"]),
			"",
			"Derived:",
			...(params.slices.derived.length > 0
				? params.slices.derived.map((x) => `- ${x}`)
				: ["- (none captured)"]),
		].join("\n"),
		metadata: {
			type: "memory-reflection",
			stage: "reflect-store",
			reflectionVersion: 3,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			agentId: params.agentId,
			command: params.command,
			storedAt: params.runAt,
			invariants: params.slices.invariants,
			derived: params.slices.derived,
			usedFallback: params.usedFallback,
			errorSignals: params.toolErrorSignals.map((s) => s.signatureHash),
			decayModel: "logistic",
			decayMidpointDays: REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
			decayK: REFLECTION_DERIVE_LOGISTIC_K,
			deriveBaseWeight,
			deriveQuality,
			deriveSource: params.usedFallback ? "fallback" : "normal",
			...(params.sourceReflectionPath
				? {
						sourceReflectionPath: params.sourceReflectionPath,
					}
				: {}),
		},
	};
}
