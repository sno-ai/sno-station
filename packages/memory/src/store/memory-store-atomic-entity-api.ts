/** @file memory-store-atomic-entity-api.ts
 * @purpose Resolves atomic-memory subjects by exact or normalized registry identity.
 * @boundary Read-only resolution; new registrations commit with their introducing cards.
 */

import type { Embedder } from "../engine/extraction/embedding-provider-client";
import {
	type AtomicMemoryEntityResolution,
	MemoryStore,
	type MemoryStoreInternals,
} from "./memory-store-base";
import { stableHash, StorageError } from "./memory-store-shared";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

interface EntityRow {
	entityId: string;
}

export interface AtomicMemoryEntityCandidate extends EntityRow {
	displayName: string;
}

export const ENTITY_IDENTITY_CANDIDATE_LIMIT = 64;

export interface AtomicEntityIdentityJournalDetail {
	project_id: string;
	display_name: string;
	normalized_name: string;
	entity_id?: string;
	merge_id?: string;
	offered_entity_ids: readonly string[];
}

export type AtomicEntityIdentityJournalOutcome = "done" | "failed" | "refused";

export type AtomicEntityIdentityStore = Pick<
	MemoryStoreInternals,
	"sqlite" | "embedder" | "resolveAtomicMemoryEntity"
>;

/** One matching pair of quotes around the whole value — straight and curly, never an apostrophe. */
// Every double quote, and a single quote that is not between two letters (O'Brien keeps its own).
const QUOTE_CHARACTERS = /["“”]|(?<!\p{L})['‘’]|['‘’](?!\p{L})/gu;
const TRAILING_PUNCTUATION = /[.,;:!?。，；：！？]+$/u;

/**
 * The same name reaches this function in different wrappers and must resolve to one entity.
 *
 * Measured 2026-09-04 in the Memora weekly corpus: one email is identified as `The email is to
 * outline strategic research priorities ...` in one session and as `the email titled 'To outline
 * strategic research priorities ....'` in another. The phrase itself is identical once lowercased,
 * but the second arrives inside quotes with the full stop before the closing quote, and
 * `resolveAtomicMemoryEntity` matches exactly or on this normalized form with no fuzzy fallback —
 * so without stripping them the two become two entities and a document's fields never gather.
 */
export function normalizeEntityName(displayName: string): string {
	const base = displayName.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
	// Quotes are never part of a name, wherever they sit: `"Acme Corp Rebrand" project` used to
	// keep its quotes and miss the entity it names.
	let stripped = base.replace(QUOTE_CHARACTERS, "").replace(/\s+/gu, " ").trim();
	stripped = stripped.replace(TRAILING_PUNCTUATION, "").trim();
	// Never empty a non-empty name: an empty normalized name would collide every such entity
	// into one, and resolveAtomicMemoryEntity rejects an empty display name outright.
	return stripped || base;
}

function entitySlug(normalizedName: string): string {
	const stem = normalizedName
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.toLowerCase();
	return `entity:${stem || "unnamed"}-${stableHash(normalizedName).slice(0, 12)}`;
}

function vectorScore(left: Float32Array, right: Float32Array): number {
	let score = 0;
	for (let index = 0; index < left.length; index += 1) {
		score += (left[index] ?? 0) * (right[index] ?? 0);
	}
	return score;
}

export async function listAtomicMemoryEntityCandidates(
	store: AtomicEntityIdentityStore,
	projectId: string,
	displayName: string,
): Promise<AtomicMemoryEntityCandidate[]> {
	const candidates = store.sqlite
		.prepare(`
			SELECT entity_id AS entityId, display_name AS displayName
			FROM nodix_memory_entities
			WHERE project_id = ?
			ORDER BY normalized_name
		`)
		.all(projectId) as AtomicMemoryEntityCandidate[];
	return rankAtomicMemoryEntityCandidates(store.embedder, displayName, candidates);
}

export async function rankAtomicMemoryEntityCandidates<T extends AtomicMemoryEntityCandidate>(
	embedder: Pick<Embedder, "embed" | "embedMany">,
	displayName: string,
	candidates: readonly T[],
): Promise<T[]> {
	if (candidates.length <= ENTITY_IDENTITY_CANDIDATE_LIMIT) return [...candidates];
	const [query, passages] = await Promise.all([
		embedder.embed(displayName),
		embedder.embedMany(
			candidates.map((candidate) => candidate.displayName),
		),
	]);
	return candidates
		.map((candidate, index) => ({
			candidate,
			score:
				passages[index] === undefined
					? Number.NEGATIVE_INFINITY
					: vectorScore(query, passages[index]),
		}))
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.candidate.displayName.localeCompare(right.candidate.displayName),
		)
		.slice(0, ENTITY_IDENTITY_CANDIDATE_LIMIT)
		.map(({ candidate }) => candidate);
}

export function recordAtomicEntityIdentityJournal(
	database: SqliteDatabaseLike,
	input: {
		jobId: string;
		outcome: AtomicEntityIdentityJournalOutcome;
		reason?: string;
		detail: AtomicEntityIdentityJournalDetail;
	},
): void {
	if ((input.outcome === "failed" || input.outcome === "refused") && !input.reason?.trim()) {
		throw new StorageError("failed entity identity journal rows require a reason");
	}
	database
		.prepare(`
			INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, verdicts, actions_applied, reason, detail
			) VALUES (?, 'atomic-extraction', 'entity-identity', ?, 1, ?, ?, ?)
		`)
		.run(
			input.jobId,
			input.outcome,
			input.outcome === "done" ? 1 : 0,
			input.reason ?? null,
			JSON.stringify(input.detail),
		);
}

Object.assign(MemoryStore.prototype, {
	resolveAtomicMemoryEntity(
		this: MemoryStoreInternals,
		projectId: string,
		displayName: string,
	): AtomicMemoryEntityResolution {
		if (!projectId.trim()) throw new StorageError("Atomic entity projectId must not be empty");
		const exactName = displayName.trim();
		if (!exactName) throw new StorageError("Atomic entity displayName must not be empty");
		const exact = this.sqlite
			.prepare(
				"SELECT entity_id AS entityId FROM nodix_memory_entities WHERE project_id = ? AND display_name = ? LIMIT 1",
			)
			.get(projectId, exactName) as EntityRow | undefined;
		if (exact) return { entityId: exact.entityId };
		const normalizedName = normalizeEntityName(exactName);
		const normalized = this.sqlite
			.prepare(
				"SELECT entity_id AS entityId FROM nodix_memory_entities WHERE project_id = ? AND normalized_name = ? LIMIT 1",
			)
			.get(projectId, normalizedName) as EntityRow | undefined;
		if (normalized) return { entityId: normalized.entityId };
		const entityId = entitySlug(normalizedName);
		return {
			entityId,
			registration: { entityId, displayName: exactName, normalizedName },
		};
	},
});
