import { readTestModelCalls, readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file 106-atomic-subject-guard-boundary.e2e.test.ts
 * @purpose Proves the live user-subject guard admits the user's own intentions and still refuses the four ways a claim is unsupported.
 * @boundary The real guard transport against the real Sno GPU extract route; no mocks, no fixtures.
 */

import { describe, expect, it } from "vitest";
import { createSignedAtomicMemoryExtractionTransports } from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { assertLiveAgentE2EEnabled } from "./helpers/config";

/**
 * The model answers at temperature 0.7 by policy — greedy decoding degrades it — so one call is
 * not a verdict. Each case is asked three times and judged by majority, and the run prints how
 * often each case changed its mind: a guard that cannot answer the same input the same way twice
 * is itself the finding, and averaging it away would hide that.
 */
const ROUNDS = 3;
const MAJORITY = 2;

interface GuardCase {
	claim: string;
	quote: string;
	want: boolean;
	why: string;
}

/**
 * Every `want: true` row is a real memory the live guard threw away on 2026-09-04, with the quote
 * it was given. All five are the user speaking in the first person about something they intend to
 * do; the guard's own instructions named only STATES, so a model reading them literally rejected
 * an intention. The `want: false` rows are the four ways a claim is genuinely unsupported, and
 * they are here so a fix cannot pass by turning the guard into a rubber stamp.
 */
const CASES: GuardCase[] = [
	{
		claim: "User needs to update research proposal on 2026-06-05.",
		quote: "I actually need to update my research proposal today.",
		want: true,
		why: "first-person intention",
	},
	{
		claim: "User needs to schedule health appointments.",
		quote: "I really need to schedule those health appointments.",
		want: true,
		why: "first-person intention",
	},
	{
		claim: "User needs to visit the university library sometime soon.",
		quote: "I also need to visit the university library sometime soon.",
		want: true,
		why: "first-person intention, almost verbatim",
	},
	{
		claim: "User needs to plan quiet research time for themselves soon.",
		quote: "I need to plan some quiet research time for myself soon.",
		want: true,
		why: "first-person intention, almost verbatim",
	},
	{
		claim: "User is looking forward to exploring options for academic conference attendance.",
		quote: "I'm looking forward to exploring the options.",
		want: true,
		why: "first-person anticipation",
	},
	{
		claim: "User is interested in quantum computing.",
		quote:
			'I was just thinking about how much technology has advanced lately, which made me wonder, what exactly is "quantum computing"?',
		want: false,
		why: "one question about a topic is not an interest",
	},
	{
		claim: 'User likes the book "The Great Gatsby".',
		quote: "I really liked it",
		want: false,
		why: "the quote names nothing on its own",
	},
	{
		claim: "User lives in Shenzhen.",
		quote: "Zhang Wei is our backend engineer and he lives in Shenzhen.",
		want: false,
		why: "another person",
	},
	{
		claim: "User prefers dark roast coffee.",
		quote: "Dark roast is a great choice if you like a bolder cup.",
		want: false,
		why: "the assistant's words",
	},
];

function guardRecord(guardCase: GuardCase, index: number): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: guardCase.claim,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: guardCase.claim,
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: index,
			quote: guardCase.quote,
			startOffset: 0,
			endOffset: guardCase.quote.length,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	} as AtomicKeyedRecord;
}

describe("atomic subject guard boundary", () => {
	it(
		"admits the user's own intentions and refuses unsupported claims",
		async () => {
			assertLiveAgentE2EEnabled();
			const transports = createSignedAtomicMemoryExtractionTransports(
				{
					// rem-enhanced routes memoryExtract to our own GPU, so the factory replaces this
					// preset with the signed extract one; it is required by the type, not by the call.
					preset: "mem_claw/sno_extract_chat",
					apiKey: readTestSnoGpuSettings().apiKey,
					routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: readTestModelCalls() }),
					timeoutMs: 120_000,
				},
				"en",
			);
			const records = CASES.map(guardRecord);
			const rounds: readonly boolean[][] = await Promise.all(
				Array.from({ length: ROUNDS }, async () => {
					const decisions = await transports.subjectGuard.guardUserSubjects({ records });
					if (decisions === null) throw new Error("the guard returned no decisions");
					if (decisions.length !== CASES.length) {
						throw new Error(
							`the guard answered ${decisions.length} of ${CASES.length} records`,
						);
					}
					return [...decisions];
				}),
			);

			const report: string[] = [];
			const wrong: string[] = [];
			for (const [index, guardCase] of CASES.entries()) {
				const answers = rounds.map((round) => round[index] === true);
				const agreeing = answers.filter((answer) => answer === guardCase.want).length;
				const unstable = new Set(answers).size > 1;
				report.push(
					`  ${agreeing >= MAJORITY ? "OK   " : "WRONG"} want=${guardCase.want} ` +
						`agreed ${agreeing}/${ROUNDS}${unstable ? " (UNSTABLE)" : ""} — ${guardCase.why}: ${guardCase.claim}`,
				);
				if (agreeing < MAJORITY) wrong.push(`${guardCase.claim} [${guardCase.why}]`);
			}
			process.stdout.write(`\n##### subject guard boundary\n${report.join("\n")}\n`);
			expect(wrong).toEqual([]);
		},
		300_000,
	);
});
