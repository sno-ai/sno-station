/** Compile-contract RED for ACC-6: an event-fact close is decided by the carrier port. */

import { decideReplaceCoverage } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemReplaceCarrierPort } from "../../../../packages/memory/src/store/rem-sqlite-adapter.ts";
import type { SqliteDatabaseLike } from "../../../../packages/memory/src/store/sqlite-runtime.ts";

declare const database: SqliteDatabaseLike;

const carrier = createRemReplaceCarrierPort({
	database,
	winnerRowId: "row-newer",
	loserRowId: "row-older",
	loserProjectId: "project",
	loserCategory: "episodic",
});

decideReplaceCoverage({
	older: "The conference happened on Tuesday.",
	newer: "The conference happened on Wednesday.",
	retiringClauseIndices: [0],
	atoms: [{ clauseIndex: 0, class: "event-fact", status: "covered" }],
	carrier,
});
