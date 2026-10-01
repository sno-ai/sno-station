/** @file memory-store-relation-api.ts
 * @purpose Normalizes persisted relation predicates and reads project-scoped relation walks.
 * @boundary Mechanical relation vocabulary and storage reads only; no extraction judgment.
 */

import relationDictionaryResource from "../../config/relation-dictionary.json" with {
	type: "json",
};
import {
	type MemoryRelation,
	type MemoryRelationPredicate,
	type MemoryRelationWalkInput,
	MemoryStore,
	type MemoryStoreInternals,
} from "./memory-store-base";

interface RelationDictionaryResource {
	relations: Array<{ type: string; ratified: boolean }>;
}

const ratifiedPredicates = new Set(
	(relationDictionaryResource as RelationDictionaryResource).relations
		.filter(({ ratified }) => ratified)
		.map(({ type }) => type),
);

export function normalizeMemoryRelationPredicate(predicate: string): MemoryRelationPredicate {
	return ratifiedPredicates.has(predicate) ? (predicate as MemoryRelationPredicate) : "MENTIONS";
}

Object.assign(MemoryStore.prototype, {
	walkMemoryRelations(
		this: MemoryStoreInternals,
		input: MemoryRelationWalkInput,
	): MemoryRelation[] {
		const endpointColumn = input.direction === "incoming" ? "relation.object" : "relation.subject";
		const mentionClause = input.includeMentions ? "" : " AND relation.predicate <> 'MENTIONS'";
		const rows = this.sqlite
			.prepare(`
				SELECT
					relation.source_card_id AS sourceCardId,
					source.project_id AS projectId,
					relation.subject,
					relation.predicate,
					relation.object,
					relation.created_at AS createdAt
				FROM nodix_memory_relations relation
				JOIN nodix_memories source ON source.id = relation.source_card_id
				WHERE source.project_id = ? AND source.lane = 'active'
					AND ${endpointColumn} = ?${mentionClause}
				ORDER BY relation.source_card_id, relation.subject, relation.predicate, relation.object
			`)
			.all(input.projectId, input.node) as MemoryRelation[];
		return rows.filter((row) => this.isMemoryOnFactSurface(row.sourceCardId));
	},
});
