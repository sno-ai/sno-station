/** @file event-payload-builder.ts
 * @purpose Persists reflection events that describe analysis, retries, and outcomes.
 * @boundary SQLite schema rows, reflection hooks, and audit-style diagnostics.
 * @see strategy-hook-runner.ts, memory-entry-projector.ts, schema.ts.
 */

/**
 * Reflection event payload builder.
 */

import { createHash } from "node:crypto";

export const REFLECTION_SCHEMA_VERSION = 4;

export type ReflectionErrorSignalLike = {
	signatureHash: string;
};

export interface ReflectionEventMetadata {
	type: "memory-reflection-event";
	reflectionVersion: 4;
	kind: "episodic";
	memory_category: "episodic";
	stage: "reflect-store";
	eventId: string;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
	storedAt: number;
	asserted_at: number;
	event_at: string;
	usedFallback: boolean;
	errorSignals: string[];
	sourceReflectionPath?: string;
}

export interface ReflectionEventPayload {
	kind: "episodic-reflection";
	text: string;
	metadata: ReflectionEventMetadata;
}

export interface BuildReflectionEventPayloadParams {
	eventId?: string;
	scope: string;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
	toolErrorSignals: ReflectionErrorSignalLike[];
	runAt: number;
	usedFallback: boolean;
	sourceReflectionPath?: string;
}

interface ReflectionEventIdentity {
	runAt: number;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
}

function normalizeRunAt(runAt: number): number {
	if (!Number.isFinite(runAt)) return Date.now();
	return Math.max(0, Math.floor(runAt));
}

function formatReflectionEventDate(runAt: number): string {
	return new Date(runAt)
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
}

function hashReflectionEventIdentity(identity: ReflectionEventIdentity): string {
	return createHash("sha1")
		.update(
			`${identity.runAt}|${identity.sessionKey}|${identity.sessionId}|${identity.agentId}|${identity.command}`,
		)
		.digest("hex")
		.slice(0, 8);
}

function eventIdentityFromParams(
	params: BuildReflectionEventPayloadParams,
): ReflectionEventIdentity {
	return {
		runAt: params.runAt,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		command: params.command,
	};
}

function collectErrorSignalHashes(signals: ReflectionErrorSignalLike[]): string[] {
	return signals.map((signal) => signal.signatureHash);
}

/** Creates a deterministic event id from run time, session, agent, and command. */
export function createReflectionEventId(params: {
	runAt: number;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
}): string {
	const identity = { ...params, runAt: normalizeRunAt(params.runAt) };
	return `refl-${formatReflectionEventDate(identity.runAt)}-${hashReflectionEventIdentity(identity)}`;
}

function buildReflectionEventMetadata(
	params: BuildReflectionEventPayloadParams,
	eventId: string,
): ReflectionEventMetadata {
	return {
		type: "memory-reflection-event",
		reflectionVersion: REFLECTION_SCHEMA_VERSION,
		kind: "episodic",
		memory_category: "episodic",
		stage: "reflect-store",
		eventId,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		command: params.command,
		storedAt: params.runAt,
		asserted_at: params.runAt,
		event_at: new Date(params.runAt).toISOString(),
		usedFallback: params.usedFallback,
		errorSignals: collectErrorSignalHashes(params.toolErrorSignals),
		...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
	};
}

function renderReflectionEventText(
	params: BuildReflectionEventPayloadParams,
	eventId: string,
): string {
	return [
		`reflection-event · ${params.scope}`,
		`eventId=${eventId}`,
		`session=${params.sessionId}`,
		`agent=${params.agentId}`,
		`command=${params.command}`,
		`usedFallback=${params.usedFallback ? "true" : "false"}`,
	].join("\n");
}

/**
 * Assembles reflection event payload from validated inputs for deterministic reflection event
 * persistence.
 */
export function buildReflectionEventPayload(
	params: BuildReflectionEventPayloadParams,
): ReflectionEventPayload {
	const eventId = params.eventId || createReflectionEventId(eventIdentityFromParams(params));
	const metadata = buildReflectionEventMetadata(params, eventId);
	const text = renderReflectionEventText(params, eventId);

	return { kind: "episodic-reflection", text, metadata };
}
