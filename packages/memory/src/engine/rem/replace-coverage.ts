import { z } from "zod";

import { buildReplaceEligibleClauses } from "./replace-clause-verdict.js";

export type ReplaceCoverageClass = "current-fact" | "retired-fact" | "event-fact";
export type ReplaceCoverageStatus = "covered" | "uncovered" | "undetermined";

export interface ReplaceCoverageAtom {
	clauseIndex: number;
	class: ReplaceCoverageClass;
	status: ReplaceCoverageStatus;
}

// What a deleted gate saw. Owner ruling 2026-08-11: a condition nobody can justify as a refusal
// becomes an observation, and an observation is written down rather than acted on — so the next
// reader can count how often each condition occurred on real data and decide from that, which is the
// evidence the deleted gates never produced in four months of refusing.
//
// Owner ruling 2026-08-13: the count is of conditions DETECTED, not of conditions that let a close
// through, so observations ride on a REFUSE as well. They were carried only on an `allow` until
// today, which meant a condition that co-occurred with a refusal was seen and then discarded — and
// "did this ever protect anything" is a question about how often the condition occurred, never about
// what the pair's outcome happened to be. Widening it costs the refusal statistics nothing:
// `topRefusalReasons` and `parseFailureCount` both filter `outcome === "refused"` before reading a
// reason (`rem-batch-executor.ts:427-433`) and these are journalled as `no-action`.
export interface ReplaceCoverageObservation {
	code: string;
	detail?: string;
}

export type ReplaceCoverageDecision =
	| {
			decision: "allow";
			atoms: ReplaceCoverageAtom[];
			observations?: ReplaceCoverageObservation[];
			// Older clauses that no atom certified as covered. Deleting the accounting refusal means a
			// model that returns an empty or short atom list no longer stops the close — so the clauses
			// it never mentioned would leave the current facet unannounced, which is the one outcome
			// the deletion was not allowed to produce. The caller carries these into the surviving row
			// before closing; an empty array is the ordinary case and means the model accounted for
			// every clause. Owner ruling 2026-08-11.
			uncertifiedClauses?: string[];
	  }
	| {
			decision: "refuse";
			reason: string;
			detail?: string;
			atoms: ReplaceCoverageAtom[];
			observations?: ReplaceCoverageObservation[];
	  };

/** Why the surviving row would stop answering a counting question once the close lands. */
export type RemReplaceCarrierFault =
	| "carrier_missing"
	| "carrier_inactive"
	| "carrier_superseded"
	| "carrier_not_on_current_facet"
	| "carrier_out_of_aggregation_scope";

export type RemReplaceCarrierState =
	| { retained: true }
	| { retained: false; fault: RemReplaceCarrierFault };

/**
 * 40-rem-replace-prd.md:566 defines retrievable as "still returned by the paths that ANSWER a
 * counting question" AFTER the close. Whether the surviving row still carries the event is
 * already decided upstream, by the coverage model that is shown both texts and whose per-atom
 * `status` this file gates on. What only the store knows is whether that carrier itself is still
 * on the aggregation path once this close lands — a row already parked, already closed by an
 * earlier pair in the same batch, demoted to the history facet, or filtered out by the
 * aggregation query's own scope and category predicates.
 */
export interface RemReplaceCarrierPort {
	carrierState(): Promise<RemReplaceCarrierState>;
}

const replaceCoverageSchema = z
	.object({
		atoms: z.array(
			z
				.object({
					clause_index: z.number().int().nonnegative(),
					class: z.enum(["current-fact", "retired-fact", "event-fact"]),
					status: z.enum(["covered", "uncovered", "undetermined"]),
				})
				.strict(),
		),
	})
	.strict();

export function renderReplaceCoveragePrompt(input: {
	older: string;
	newer: string;
	retiringClauseIndices: readonly number[];
}): string {
	const olderClauses = buildReplaceEligibleClauses(input.older, input.newer).filter(
		(clause) => clause.origin === "older",
	);
	return [
		"Classify whether every older-memory clause remains covered after replacement.",
		'Return JSON only: {"atoms":[{"clause_index":0,"class":"current-fact|retired-fact|event-fact","status":"covered|uncovered|undetermined"}]}.',
		"Return exactly one atom for each older clause. Prefer undetermined over guessing.",
		"Covered means the newer memory carries the older clause's information, including an updated value for the same fact, so closing the older row loses nothing.",
		"Uncovered means closing the older row would lose information that the newer memory does not carry.",
		"Class describes what kind of assertion the older clause makes, independently of Retiring older-clause indices. Those indices do not determine class or status and do not excuse information loss; evaluate every older clause.",
		`Older clauses: ${JSON.stringify(olderClauses)}`,
		`Newer memory: ${JSON.stringify(input.newer)}`,
		`Retiring older-clause indices: ${JSON.stringify(input.retiringClauseIndices)}`,
	].join("\n\n");
}

export function parseReplaceCoverageAtoms(value: unknown): ReplaceCoverageAtom[] | undefined {
	const parsed = replaceCoverageSchema.safeParse(value);
	if (!parsed.success) return undefined;
	return parsed.data.atoms.map((atom) => ({
		clauseIndex: atom.clause_index,
		class: atom.class,
		status: atom.status,
	}));
}

/** Validates model-classified coverage against the code-owned older-clause reference set. */
/**
 * Every refusal raised after the observation list exists carries what was seen up to that point.
 * Owner ruling 2026-08-13: the count is of conditions detected. Refusing on one condition while
 * silently dropping another the same pair exhibited is how a deletion stays unmeasurable.
 */
function refuseWith(
	reason: string,
	atoms: ReplaceCoverageAtom[],
	observations: readonly ReplaceCoverageObservation[],
	detail?: string,
): ReplaceCoverageDecision {
	return {
		decision: "refuse",
		reason,
		atoms,
		...(detail === undefined ? {} : { detail }),
		...(observations.length === 0 ? {} : { observations: [...observations] }),
	};
}

export function decideReplaceCoverage(input: {
	older: string;
	newer: string;
	retiringClauseIndices: readonly number[];
	atoms: readonly ReplaceCoverageAtom[];
	carrier?: RemReplaceCarrierPort;
	rawCandidateEvidence?: string;
}): ReplaceCoverageDecision | Promise<ReplaceCoverageDecision> {
	const atoms = input.atoms.map((atom) => ({ ...atom }));
	if (input.older.trim().length === 0) {
		return { decision: "refuse", reason: "empty_older_clause_set", atoms };
	}
	const olderClauses = buildReplaceEligibleClauses(input.older, input.newer).filter(
		(clause) => clause.origin === "older",
	);
	if (olderClauses.length === 0) {
		return { decision: "refuse", reason: "empty_older_clause_set", atoms };
	}
	const observations: ReplaceCoverageObservation[] = [];
	// DELETED as a refusal, owner ruling 2026-08-11 — `incomplete_clause_accounting`. It refused the
	// close whenever the model's atom list did not enumerate every older clause exactly once. That is
	// a statement about the model's bookkeeping, not about whether the rewrite loses a fact, and the
	// facts themselves are still checked one atom at a time below. Out-of-range indices need no gate:
	// every reader of `clauseIndex` already guards the lookup.
	if (
		atoms.length !== olderClauses.length ||
		new Set(atoms.map((atom) => atom.clauseIndex)).size !== atoms.length ||
		atoms.some((atom) => atom.clauseIndex < 0 || atom.clauseIndex >= olderClauses.length)
	) {
		observations.push({
			code: "incomplete_clause_accounting",
			detail: `atoms=${atoms.length} clauses=${olderClauses.length}`,
		});
	}
	const retiring = new Set(input.retiringClauseIndices);
	for (const atom of atoms) {
		if (atom.status !== "covered") {
			return refuseWith(`atom_${atom.status}`, atoms, observations);
		}
		// DELETED as a refusal, owner ruling 2026-08-11 — `retiring_side_mismatch`. Two model calls
		// disagreeing about which clause retires is a prompt or model problem to be counted, not a
		// reason to abandon a close the clause stage already named a retiring set for.
		if (atom.class === "retired-fact" && !retiring.has(atom.clauseIndex)) {
			observations.push({
				code: "retiring_side_mismatch",
				detail: `clause_index=${atom.clauseIndex}`,
			});
		}
		if (atom.class === "retired-fact" && input.rawCandidateEvidence !== undefined) {
			const clause = olderClauses[atom.clauseIndex];
			if (clause !== undefined && !input.rawCandidateEvidence.includes(clause.value)) {
				atom.status = "undetermined";
				return refuseWith("retired_fact_not_in_evidence", atoms, observations);
			}
		}
	}
	// Every non-retiring older clause with no `covered` atom against it. Reached only on the allow
	// path: any atom that says `uncovered` or `undetermined` has already refused above, and a clause
	// explicitly selected for retirement must not be resurrected on the survivor.
	const certified = new Set(
		atoms.filter((atom) => atom.status === "covered").map((atom) => atom.clauseIndex),
	);
	const uncertifiedClauses = olderClauses
		.map((clause, index) =>
			certified.has(index) || retiring.has(index) ? undefined : clause.value,
		)
		.filter((value): value is string => value !== undefined);
	const carriesEvent = atoms.some((atom) => atom.class === "event-fact");
	if (carriesEvent) {
		if (input.carrier === undefined) {
			return refuseWith("event_retrievability_port_missing", atoms, observations);
		}
		return decideEventFacts(input.carrier, atoms, observations, uncertifiedClauses);
	}
	return {
		decision: "allow",
		atoms,
		...(observations.length === 0 ? {} : { observations }),
		...(uncertifiedClauses.length === 0 ? {} : { uncertifiedClauses }),
	};
}

async function decideEventFacts(
	carrier: RemReplaceCarrierPort,
	atoms: ReplaceCoverageAtom[],
	observations: readonly ReplaceCoverageObservation[],
	uncertifiedClauses: readonly string[],
): Promise<ReplaceCoverageDecision> {
	const state = await carrier.carrierState();
	if (!state.retained) {
		return refuseWith("event_not_retrievable", atoms, observations, state.fault);
	}
	return {
		decision: "allow",
		atoms,
		...(observations.length === 0 ? {} : { observations: [...observations] }),
		...(uncertifiedClauses.length === 0 ? {} : { uncertifiedClauses: [...uncertifiedClauses] }),
	};
}
