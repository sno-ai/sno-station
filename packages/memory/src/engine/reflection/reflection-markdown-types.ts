/** @file reflection-markdown-types.ts
 * @purpose Owns reflection markdown parser data contracts and locked headings.
 * @boundary Shared parser types and section heading literals only.
 */

import type { MemoryCategory } from "../shared/types";

export interface ReflectionSlices {
	invariants: string[];
	derived: string[];
}

export interface ReflectionMappedMemory {
	text: string;
	category: MemoryCategory;
	heading: string;
}

export type ReflectionMappedKind = "user-model" | "agent-model" | "lesson" | "decision";

export interface ReflectionMappedMemoryItem extends ReflectionMappedMemory {
	mappedKind: ReflectionMappedKind;
	ordinal: number;
	groupSize: number;
}

export interface ReflectionSliceItem {
	text: string;
	itemKind: "invariant" | "derived";
	section: "Invariants" | "Derived";
	ordinal: number;
	groupSize: number;
}

export interface ReflectionGovernanceEntry {
	priority?: string;
	status?: string;
	area?: string;
	summary: string;
	details?: string;
	suggestedAction?: string;
}

// Parser-locked section headings (machine contract).
//
// Reflection markdown is parsed against these EXACT English heading strings.
// Every locale reflection prompt bundle must emit the same headings so the
// layered store and mapped-memory loop receive rows consistently.
export const PARSER_HEADINGS = {
	context: "Context",
	decisionsDurable: "Decisions (durable)",
	invariants: "Invariants",
	invariantsAndReflections: "Invariants & Reflections",
	derived: "Derived",
	openLoops: "Open loops / next actions",
	userModelDeltas: "User model deltas (about the human)",
	agentModelDeltas: "Agent model deltas (about the assistant/system)",
	lessonsAndPitfalls: "Lessons & pitfalls (symptom / cause / fix / prevention)",
	learningGovernance: "Learning governance candidates (.learnings / promotion / skill extraction)",
} as const;
