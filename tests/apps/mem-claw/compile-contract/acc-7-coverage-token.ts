/** Compile-contract RED for ACC-7: only a same-pair unforgeable allow token can close,
 * and the token cannot exist without the model coverage decision that earns it.
 * Tightened 2026-08-21 under REQ-21 of 90-rem-update-model-judgment-prd.md: the issuer used
 * to accept a bare `decision: "allow"` literal, so any caller that skipped or lost the model
 * verification could mint a permission and soft-close valid memory.
 */

import {
	createCoverageGatedConflictPort,
	createSnoStationMemRemPorts,
	issueReplaceCoverageAllow,
	type ReplaceCoverageAllowToken,
} from "../../../../packages/memory/src/store/rem-sqlite-adapter.ts";
import type { WriteTextVersionInput } from "../../../../packages/memory/src/engine/rem/index.ts";

type ExpectFalse<Value extends false> = Value;
type PlainObjectIsToken = { readonly pairId: "pair-a" } extends ReplaceCoverageAllowToken<"pair-a">
	? true
	: false;
type OtherPairTokenFits = ReplaceCoverageAllowToken<"pair-a"> extends ReplaceCoverageAllowToken<"pair-b">
	? true
	: false;
// The permission carries the verified decision, so a token shaped from the pair id alone —
// the shape the pre-2026-08-21 issuer accepted — is not a token.
type PairIdAndBrandAlone = {
	readonly coverageDecision: {
		readonly pairId: "pair-a";
		readonly decision: "allow";
		readonly atoms: [];
	};
} extends ReplaceCoverageAllowToken<"pair-a">
	? true
	: false;
type GuardedWriteInput = Parameters<
	ReturnType<typeof createSnoStationMemRemPorts>["conflict"]["writeTextVersion"]
>[0];
type BareWriteInputFits = WriteTextVersionInput extends GuardedWriteInput ? true : false;

type PlainObjectCannotAuthorize = ExpectFalse<PlainObjectIsToken>;
type TokenIsBoundToSamePair = ExpectFalse<OtherPairTokenFits>;
type TokenRequiresItsCoverageDecision = ExpectFalse<PairIdAndBrandAlone>;
type TextWriteRequiresVerification = ExpectFalse<BareWriteInputFits>;

const allow = issueReplaceCoverageAllow({
	pairId: "pair-a" as const,
	// Only the model's own allow result opens the gate; nothing narrower type-checks.
	decision: "allow",
	atoms: [],
	uncertifiedClauses: [],
});
const conflict = createCoverageGatedConflictPort();

void conflict.softClose({
	pairId: "pair-a" as const,
	coverageAllow: allow,
	rowId: "older-row",
	successorId: "newer-row",
	plannedContentHash: "a".repeat(64),
	plannedSuccessorContentHash: "b".repeat(64),
	reason: "same-pair coverage allowed",
	timestamp: "2026-08-08T12:00:00.000Z",
});

export type Acc7CompileAssertions =
	| PlainObjectCannotAuthorize
	| TokenIsBoundToSamePair
	| TokenRequiresItsCoverageDecision
	| TextWriteRequiresVerification;
