import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	buildReflectionEventPayload,
	createReflectionEventId,
	REFLECTION_SCHEMA_VERSION,
} from "@/reflection/event-payload-builder";
import {
	computeReflectionLogistic,
	computeReflectionScore,
	normalizeReflectionLineForAggregation,
	REFLECTION_FALLBACK_SCORE_FACTOR,
} from "@/reflection/line-quality-ranker";
import {
	buildReflectionMappedMetadata,
	getReflectionMappedDecayDefaults,
	type ReflectionMappedKind,
} from "@/reflection/mapped-memory-metadata-builder";
import type {
	ReflectionMappedMemoryItem,
	ReflectionSliceItem,
} from "@/reflection/markdown-slice-parser";
import {
	buildReflectionItemPayloads,
	getReflectionItemDecayDefaults,
	REFLECTION_DERIVED_BASE_WEIGHT,
	REFLECTION_DERIVED_DECAY_K,
	REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
	REFLECTION_DERIVED_QUALITY,
	REFLECTION_INVARIANT_BASE_WEIGHT,
	REFLECTION_INVARIANT_DECAY_K,
	REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
	REFLECTION_INVARIANT_QUALITY,
	type ReflectionItemKind,
} from "@/reflection/slice-item-payload-builder";

const runAt = Date.UTC(2026, 4, 7, 12, 34, 56);
const errorSignals = [{ signatureHash: "sig-b" }, { signatureHash: "sig-a" }];

function expectedReflectionEventId(params: {
	runAt: number;
	sessionKey: string;
	sessionId: string;
	agentId: string;
	command: string;
}): string {
	const datePart = new Date(params.runAt)
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
	const digest = createHash("sha1")
		.update(
			`${params.runAt}|${params.sessionKey}|${params.sessionId}|${params.agentId}|${params.command}`,
		)
		.digest("hex")
		.slice(0, 8);
	return `refl-${datePart}-${digest}`;
}

describe("reflection score and payload builders", () => {
	it("keeps reflection score math, fallback multiplier, and line normalization stable", () => {
		const logistic = computeReflectionLogistic(10, 5, 0.5);
		const expectedLogistic = 1 / (1 + Math.exp(0.5 * (10 - 5)));

		expect(logistic).toBeCloseTo(expectedLogistic, 12);
		expect(
			computeReflectionScore({
				ageDays: 10,
				midpointDays: 5,
				k: 0.5,
				baseWeight: 2,
				quality: 1.7,
				usedFallback: true,
			}),
		).toBeCloseTo(expectedLogistic * 2 * REFLECTION_FALLBACK_SCORE_FACTOR, 12);
		expect(
			normalizeReflectionLineForAggregation("  Durable\tUser\nPreference  "),
		).toBe("durable user preference");
	});

	it("builds deterministic event payload ids, metadata, text lines, and error signal order", () => {
		const identity = {
			runAt,
			sessionKey: "workspace/session",
			sessionId: "session-20260507",
			agentId: "agent-main",
			command: "reflect-store",
		};
		const expectedId = expectedReflectionEventId(identity);

		expect(createReflectionEventId(identity)).toBe(expectedId);

		const payload = buildReflectionEventPayload({
			...identity,
			scope: "session",
			toolErrorSignals: errorSignals,
			usedFallback: true,
			sourceReflectionPath: "/tmp/reflection.md",
		});

		expect(payload).toEqual({
			kind: "episodic-reflection",
			text: [
				"reflection-event · session",
				`eventId=${expectedId}`,
				"session=session-20260507",
				"agent=agent-main",
				"command=reflect-store",
				"usedFallback=true",
			].join("\n"),
			metadata: {
				type: "memory-reflection-event",
				reflectionVersion: REFLECTION_SCHEMA_VERSION,
				kind: "episodic",
				memory_category: "episodic",
				stage: "reflect-store",
				eventId: expectedId,
				sessionKey: "workspace/session",
				sessionId: "session-20260507",
				agentId: "agent-main",
				command: "reflect-store",
				storedAt: runAt,
				asserted_at: runAt,
				event_at: "2026-05-07T12:34:56.000Z",
				usedFallback: true,
				errorSignals: ["sig-b", "sig-a"],
				sourceReflectionPath: "/tmp/reflection.md",
			},
		});
	});

	it("renders invariant and derived item payloads in input order with locked defaults", () => {
		const items: ReflectionSliceItem[] = [
			{
				text: "The user prefers concise status updates.",
				itemKind: "invariant",
				section: "Invariants",
				ordinal: 1,
				groupSize: 2,
			},
			{
				text: "The assistant should verify the baseline before editing.",
				itemKind: "derived",
				section: "Derived",
				ordinal: 2,
				groupSize: 2,
			},
		];

		const payloads = buildReflectionItemPayloads({
			items,
			eventId: "refl-fixed",
			agentId: "agent-main",
			sessionKey: "workspace/session",
			sessionId: "session-20260507",
			runAt,
			usedFallback: false,
			toolErrorSignals: errorSignals,
			sourceReflectionPath: "/tmp/reflection.md",
		});

		expect(payloads.map((payload) => payload.kind)).toEqual([
			"item-invariant",
			"item-derived",
		]);
		expect(payloads.map((payload) => payload.text)).toEqual(
			items.map((item) => item.text),
		);
		expect(payloads[0]?.metadata).toMatchObject({
			type: "memory-reflection-item",
			reflectionVersion: 4,
			stage: "reflect-store",
			eventId: "refl-fixed",
			itemKind: "invariant",
			section: "Invariants",
			ordinal: 1,
			groupSize: 2,
			agentId: "agent-main",
			sessionKey: "workspace/session",
			sessionId: "session-20260507",
			storedAt: runAt,
			usedFallback: false,
			errorSignals: ["sig-b", "sig-a"],
			decayModel: "logistic",
			decayMidpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
			decayK: REFLECTION_INVARIANT_DECAY_K,
			baseWeight: REFLECTION_INVARIANT_BASE_WEIGHT,
			quality: REFLECTION_INVARIANT_QUALITY,
			sourceReflectionPath: "/tmp/reflection.md",
		});
		expect(payloads[1]?.metadata).toMatchObject({
			itemKind: "derived",
			section: "Derived",
			decayMidpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
			decayK: REFLECTION_DERIVED_DECAY_K,
			baseWeight: REFLECTION_DERIVED_BASE_WEIGHT,
			quality: REFLECTION_DERIVED_QUALITY,
		});
	});

	it("keeps item decay defaults and mapped metadata defaults stable", () => {
		const itemDefaults: Record<
			ReflectionItemKind,
			ReturnType<typeof getReflectionItemDecayDefaults>
		> = {
			invariant: {
				midpointDays: 45,
				k: 0.22,
				baseWeight: 1.1,
				quality: 1,
			},
			derived: {
				midpointDays: 7,
				k: 0.65,
				baseWeight: 1,
				quality: 0.95,
			},
		};

		for (const [kind, defaults] of Object.entries(itemDefaults)) {
			expect(
				getReflectionItemDecayDefaults(kind as ReflectionItemKind),
			).toEqual(defaults);
		}

		const mappedDefaults: Record<
			ReflectionMappedKind,
			ReturnType<typeof getReflectionMappedDecayDefaults>
		> = {
			decision: { midpointDays: 45, k: 0.25, baseWeight: 1.1, quality: 1 },
			"user-model": { midpointDays: 21, k: 0.3, baseWeight: 1, quality: 0.95 },
			"agent-model": {
				midpointDays: 10,
				k: 0.35,
				baseWeight: 0.95,
				quality: 0.93,
			},
			lesson: { midpointDays: 7, k: 0.45, baseWeight: 0.9, quality: 0.9 },
		};

		for (const [kind, defaults] of Object.entries(mappedDefaults)) {
			expect(
				getReflectionMappedDecayDefaults(kind as ReflectionMappedKind),
			).toEqual(defaults);
		}

		const mutableDefaults = getReflectionMappedDecayDefaults("lesson");
		mutableDefaults.quality = 0.01;
		expect(getReflectionMappedDecayDefaults("lesson")).toEqual(
			mappedDefaults.lesson,
		);
	});

	it("builds mapped memory metadata fields with optional source path behavior", () => {
		const mappedItem: ReflectionMappedMemoryItem = {
			text: "Use workspace vitest config for plugin tests.",
			category: "lesson",
			heading: "Lessons & pitfalls (symptom / cause / fix / prevention)",
			mappedKind: "lesson",
			ordinal: 3,
			groupSize: 5,
		};

		const withSource = buildReflectionMappedMetadata({
			mappedItem,
			eventId: "refl-fixed",
			agentId: "agent-main",
			sessionKey: "workspace/session",
			sessionId: "session-20260507",
			runAt,
			usedFallback: true,
			toolErrorSignals: errorSignals,
			sourceReflectionPath: "/tmp/reflection.md",
		});

		expect(withSource).toMatchObject({
			type: "memory-reflection-mapped",
			reflectionVersion: 4,
			stage: "reflect-store",
			eventId: "refl-fixed",
			mappedKind: "lesson",
			mappedCategory: "lesson",
			section: "Lessons & pitfalls (symptom / cause / fix / prevention)",
			ordinal: 3,
			groupSize: 5,
			agentId: "agent-main",
			sessionKey: "workspace/session",
			sessionId: "session-20260507",
			storedAt: runAt,
			usedFallback: true,
			errorSignals: ["sig-b", "sig-a"],
			decayModel: "logistic",
			decayMidpointDays: 7,
			decayK: 0.45,
			baseWeight: 0.9,
			quality: 0.9,
			sourceReflectionPath: "/tmp/reflection.md",
		});

		const withoutSource = buildReflectionMappedMetadata({
			...withSourceParams(mappedItem),
			sourceReflectionPath: undefined,
		});
		expect(withoutSource).not.toHaveProperty("sourceReflectionPath");
	});
});

function withSourceParams(mappedItem: ReflectionMappedMemoryItem) {
	return {
		mappedItem,
		eventId: "refl-fixed",
		agentId: "agent-main",
		sessionKey: "workspace/session",
		sessionId: "session-20260507",
		runAt,
		usedFallback: true,
		toolErrorSignals: errorSignals,
	};
}
