/** @file memory-kind-policy.ts
 * @purpose Per-kind write policy, dedupe policy, and writer authority lookups.
 * @boundary Pure lookups only — no I/O, no side effects.
 */

import type { MemoryCategory } from "./types";

export type WritePolicy = "append-only" | "mutation-native" | "derived-only";

export type DedupePolicy =
	| { mode: "none" }
	| { mode: "signature"; field: "anti_pattern_signature" };

export type WriterAuthority = "extraction" | "profile-writer" | "offline-family";

const WRITE_POLICY: Record<MemoryCategory, WritePolicy> = {
	episodic: "append-only",
	lesson: "append-only",
	profile: "mutation-native",
	persona: "mutation-native",
	summary: "derived-only",
	state: "mutation-native",
};

const DEDUPE_POLICY: Record<MemoryCategory, DedupePolicy> = {
	episodic: { mode: "none" },
	lesson: { mode: "signature", field: "anti_pattern_signature" },
	profile: { mode: "none" },
	persona: { mode: "none" },
	summary: { mode: "none" },
	state: { mode: "none" },
};

const ALLOWED_WRITERS: Record<MemoryCategory, readonly WriterAuthority[]> = {
	episodic: ["extraction", "offline-family"],
	lesson: ["offline-family"],
	profile: ["profile-writer", "offline-family"],
	persona: ["offline-family"],
	summary: ["offline-family"],
	state: ["extraction", "offline-family"],
};

export function isAppendOnly(kind: MemoryCategory): boolean {
	return WRITE_POLICY[kind] === "append-only";
}

export function isMutationNative(kind: MemoryCategory): boolean {
	return WRITE_POLICY[kind] === "mutation-native";
}

export function isDerivedOnly(kind: MemoryCategory): boolean {
	return WRITE_POLICY[kind] === "derived-only";
}

export function writePolicy(kind: MemoryCategory): WritePolicy {
	return WRITE_POLICY[kind];
}

export function dedupePolicy(kind: MemoryCategory): DedupePolicy {
	return DEDUPE_POLICY[kind];
}

export function allowedWriters(kind: MemoryCategory): readonly WriterAuthority[] {
	return ALLOWED_WRITERS[kind];
}

export function canExtractorWrite(kind: MemoryCategory): boolean {
	return ALLOWED_WRITERS[kind].includes("extraction");
}

export function canProfileWriterWrite(kind: MemoryCategory): boolean {
	return ALLOWED_WRITERS[kind].includes("profile-writer");
}

export function canToolWrite(kind: MemoryCategory): boolean {
	const writers = ALLOWED_WRITERS[kind];
	return writers.includes("extraction");
}

export function canTrustedWrite(kind: MemoryCategory): boolean {
	const writers = ALLOWED_WRITERS[kind];
	return writers.includes("extraction") || writers.includes("profile-writer");
}

export function canOfflineFamilyWrite(kind: MemoryCategory): boolean {
	return ALLOWED_WRITERS[kind].includes("offline-family");
}
