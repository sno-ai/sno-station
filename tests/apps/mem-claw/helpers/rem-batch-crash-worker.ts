/** @file rem-batch-crash-worker.ts
 * @purpose Executes one durable claim, checkpoint, or recovery step in its own process.
 * @boundary Test process driver only; all state transitions use rem-core production APIs.
 */

import {
	createRemRepository,
	installRemSchema,
	type RemOwner,
	type RemVerdictCheckpoint,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import {
	initSqliteRuntimeSync,
	openSqliteDatabase,
} from "../../../../packages/memory/src/store/sqlite-runtime.ts";

const [, , command, dbPath, ...args] = process.argv;
if (!command || !dbPath) {
	throw new Error("usage: rem-batch-crash-worker.ts <command> <db> [...args]");
}

initSqliteRuntimeSync();
const runtime = openSqliteDatabase(dbPath, { fileMustExist: true });
try {
	installRemSchema(runtime.db);
	const repository = createRemRepository(runtime.db);
	if (command === "checkpoint") {
		const [generationId, pairId, detail] = requireArgs(args, 3);
		const checkpoint = detail as RemVerdictCheckpoint;
		const owner = `checkpoint-${pairId}`;
		const claim = repository.claimNextPair({
			generationId,
			invocationId: owner,
			claimedAt: "2026-07-31T08:00:00.000Z",
			holderPid: process.pid,
		});
		if (!claim || claim.pairId !== pairId) throw new Error("checkpoint pair was not claimable");
		repository.recordVerdictCheckpoint({
			generationId,
			pairId,
			invocationId: owner,
			checkpoint,
			recordedAt: "2026-07-31T08:00:00.000Z",
			...(checkpoint === "verdict_recorded" || checkpoint === "action_applied"
				? { verdict: "replacement" }
				: {}),
		});
		writeResult({ checkpoint, owner });
	} else if (command === "resume") {
		const [generationId, pairId, detail] = requireArgs(args, 3);
		const owner = `resume-${process.pid}`;
		const directive = repository.resumeVerdictPair({
			generationId,
			pairId,
			expectedInvocationId: detail,
			invocationId: owner,
			resumedAt: "2026-07-31T08:01:00.000Z",
			holderPid: process.pid,
		});
		if (directive.next === "refused") {
			writeResult({ directive, owner: detail });
		} else {
			const claimToken = directive.claimToken ?? owner;
			if (directive.next === "apply_action") {
				repository.recordVerdictCheckpoint({
					generationId,
					pairId,
					invocationId: claimToken,
					checkpoint: "action_applied",
					recordedAt: "2026-07-31T08:01:01.000Z",
					verdict: directive.verdict,
				});
			}
			const verifyOwner = `verify-${process.pid}`;
			const after = repository.resumeVerdictPair({
				generationId,
				pairId,
				expectedInvocationId: claimToken,
				invocationId: verifyOwner,
				resumedAt: "2026-07-31T08:01:02.000Z",
				holderPid: process.pid,
			});
			writeResult({
				directive,
				after,
				owner: after.next === "refused" ? claimToken : after.claimToken,
				actionsApplied: repository.readVerdictPair(generationId, pairId).actionsApplied,
			});
		}
	} else if (command === "row-claim-hold") {
		const [rowId, contentHash, owner, claimToken, claimTs] = requireArgs(args, 5);
		const result = repository.claimRow({
			rowId,
			contentHash,
			owner: owner as Exclude<RemOwner, "none">,
			claimToken,
			claimTs,
			holderPid: process.pid,
		});
		writeResult({ result, claimToken, holderPid: process.pid });
		await holdProcessOpen();
	} else if (command === "row-claim") {
		const [rowId, contentHash, owner, claimToken, claimTs] = requireArgs(args, 5);
		const result = repository.claimRow({
			rowId,
			contentHash,
			owner: owner as Exclude<RemOwner, "none">,
			claimToken,
			claimTs,
			holderPid: process.pid,
		});
		writeResult({ result });
	} else if (command === "row-recover") {
		const [rowId, contentHash, owner, expectedClaimToken, claimToken, claimTs] = requireArgs(
			args,
			6,
		);
		const recovered = repository.recoverRowClaim({
			rowId,
			contentHash,
			owner: owner as Exclude<RemOwner, "none">,
			expectedClaimToken,
			claimToken,
			claimTs,
			holderPid: process.pid,
		});
		writeResult({ recovered });
	} else if (command === "row-recover-complete") {
		const [rowId, contentHash, owner, expectedClaimToken, claimToken, claimTs] = requireArgs(
			args,
			6,
		);
		const recovered = repository.recoverRowClaim({
			rowId,
			contentHash,
			owner: owner as Exclude<RemOwner, "none">,
			expectedClaimToken,
			claimToken,
			claimTs,
			holderPid: process.pid,
		});
		const completed = recovered.recovered
			? repository.completeRowClaim({
					rowId,
					jobId: "crash-worker",
					jobType: "rem-update",
					contentHash,
					currentContentHash: contentHash,
					owner: owner as Exclude<RemOwner, "none">,
					claimToken,
					completedAt: "2026-07-31T08:02:01.000Z",
				})
			: undefined;
		writeResult({ recovered, completed });
	} else if (command === "pair-attempt-hold") {
		const [generationId, pairId, owner] = requireArgs(args, 3);
		const claim = repository.claimNextPair({
			generationId,
			invocationId: owner,
			claimedAt: "2026-07-31T08:00:00.000Z",
			holderPid: process.pid,
		});
		if (!claim || claim.pairId !== pairId) throw new Error("attempt pair was not claimable");
		const reservation = repository.reserveLlmBudget({
			generationId,
			pairId,
			invocationId: owner,
			stage: "verdict",
			prompt: "A persisted outbound attempt.",
			outputTokenCap: 1,
			countTokens: () => 1,
		});
		writeResult({ reservation, owner, holderPid: process.pid });
		await holdProcessOpen();
	} else if (command === "pair-claim") {
		const [generationId, owner, claimedAt] = requireArgs(args, 3);
		const claim = repository.claimNextPair({
			generationId,
			invocationId: owner,
			claimedAt,
			holderPid: process.pid,
		});
		writeResult({ claim: claim ?? null });
	} else if (command === "pair-recover") {
		const [generationId, pairId, expectedInvocationId] = requireArgs(args, 3);
		const directive = repository.resumeVerdictPair({
			generationId,
			pairId,
			expectedInvocationId,
			invocationId: `recovery-${process.pid}`,
			resumedAt: "2026-07-31T08:05:00.000Z",
			holderPid: process.pid,
		});
		writeResult({ directive });
	} else if (command === "pair-refuse-next") {
		const [generationId, reason] = requireArgs(args, 2);
		const invocationId = `refuse-${process.pid}`;
		const claim = repository.claimNextPair({
			generationId,
			invocationId,
			claimedAt: "2026-07-31T08:05:00.000Z",
			holderPid: process.pid,
		});
		if (!claim) throw new Error("pair was not claimable");
		const refused = repository.refusePair({
			generationId,
			pairId: claim.pairId,
			invocationId,
			reason,
			jobId: "crash-worker",
			jobType: "rem-replace",
		});
		writeResult({ pairId: claim.pairId, refused });
	} else if (command === "pair-reserve-complete-next") {
		const [generationId] = requireArgs(args, 1);
		const invocationId = `budget-${process.pid}`;
		const claim = repository.claimNextPair({
			generationId,
			invocationId,
			claimedAt: "2026-07-31T08:05:00.000Z",
			holderPid: process.pid,
		});
		if (!claim) throw new Error("pair was not claimable");
		const budget = repository.reserveLlmBudget({
			generationId,
			pairId: claim.pairId,
			invocationId,
			stage: "verdict",
			prompt: "One token.",
			outputTokenCap: 0,
			countTokens: () => 1,
		});
		if (budget.status !== "reserved") throw new Error(`budget was ${budget.reason}`);
		repository.completePair({ generationId, pairId: claim.pairId, invocationId });
		writeResult({ pairId: claim.pairId, budget, invocation: repository.readInvocation({ generationId, invocationId }) });
	} else {
		throw new Error(`unsupported command: ${command}`);
	}
} finally {
	runtime.db.close();
}

function requireArgs(values: string[], count: number): string[] {
	if (values.length < count) throw new Error(`expected ${count} command arguments`);
	return values;
}

function writeResult(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function holdProcessOpen(): Promise<never> {
	return new Promise(() => {
		setInterval(() => undefined, 60_000);
	});
}
