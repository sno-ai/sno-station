/** @file atomic-subject-guard.test.ts
 * @purpose Proves missing-half repair ordering and the single batched subject guard.
 * @boundary Post-enhancement subject flow with deterministic transports and no real model calls.
 */

import { describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "@/extraction/atomic-profile-keying";
import type {
	AtomicExtractionRecord,
	AtomicExtractionTurn,
} from "@/extraction/atomic-extraction-reply";
import {
	createAtomicSubjectGuardTransport,
	type AtomicSubjectGuardTransport,
	runAtomicSubjectGuard,
} from "@/extraction/atomic-subject-guard";
import { LlmClientTerminalError } from "@/shared/llm-client";
import type {
	LlmClient,
	MemoryLlmRequest,
	ResolvedLlmConfig,
	TokenUsage,
} from "@/shared/llm-client-types";
import { resolveLlmOccasion } from "@/shared/llm-mode-routing";

const TURNS: AtomicExtractionTurn[] = [
	{ role: "user", content: "I moved to Kyoto and now prefer tea." },
	{ role: "user", content: "I still prefer jazz." },
	{ role: "assistant", content: "Noted." },
];

function enhancedRecord(
	turnIndex: number,
	overrides: Partial<AtomicKeyedRecord> = {},
): AtomicKeyedRecord {
	const quote = TURNS[turnIndex]?.content ?? "missing turn";
	return {
		kind: "standing",
		category: "profile",
		claimText: `Profile claim for turn ${turnIndex}.`,
		subject: "user",
		subjectKind: "user",
		attribute: "preference.food",
		value: `value-${turnIndex}`,
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex, quote, startOffset: 0, endOffset: quote.length },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	};
}

function episode(
	turnIndex: number,
	overrides: Partial<AtomicKeyedRecord> = {},
): AtomicKeyedRecord {
	return enhancedRecord(turnIndex, {
		kind: "occurrence",
		category: "episodic",
		claimText: `Episode for turn ${turnIndex}.`,
		attribute: null,
		changesCurrentState: true,
		...overrides,
	});
}

function repairedProfile(
	turnIndex: number,
	overrides: Partial<AtomicExtractionRecord> = {},
): AtomicExtractionRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: `Repaired profile for turn ${turnIndex}.`,
		subject: "user",
		subjectKind: "user",
		attribute: "identity.location",
		value: "Kyoto",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex, quote: TURNS[turnIndex]?.content ?? "missing turn" },
		relations: [],
		singleClaim: true,
		...overrides,
	};
}

type RepairInput = Parameters<AtomicSubjectGuardTransport["repairMissingHalf"]>[0];
type GuardInput = Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0];

class ScriptedSubjectTransport implements AtomicSubjectGuardTransport {
	readonly repairCalls: RepairInput[] = [];
	readonly guardCalls: GuardInput[] = [];

	constructor(
		private readonly repair: (
			input: RepairInput,
		) => AtomicExtractionRecord[] | null | Promise<AtomicExtractionRecord[] | null>,
		private readonly guard: (
			input: GuardInput,
		) => readonly (boolean | null)[] | null | Promise<readonly (boolean | null)[] | null>,
	) {}

	async repairMissingHalf(input: RepairInput): Promise<AtomicExtractionRecord[] | null> {
		this.repairCalls.push(input);
		return this.repair(input);
	}

	async guardUserSubjects(input: GuardInput): Promise<readonly (boolean | null)[] | null> {
		this.guardCalls.push(input);
		return this.guard(input);
	}
}

class RecordingClient implements LlmClient {
	readonly textRequests: MemoryLlmRequest[] = [];
	readonly jsonRequests: MemoryLlmRequest[] = [];

	constructor(
		private readonly textReply: string | null,
		private readonly jsonReply: unknown,
	) {}

	async completeJson<T>(request: MemoryLlmRequest): Promise<T | null> {
		this.jsonRequests.push(request);
		return this.jsonReply as T | null;
	}

	async completeText(request: MemoryLlmRequest): Promise<string | null> {
		this.textRequests.push(request);
		return this.textReply;
	}

	async getResolvedConfig(): Promise<ResolvedLlmConfig> {
		throw new Error("subject transport must not resolve client config");
	}

	getLastError(): null {
		return null;
	}

	getLastUsage(): TokenUsage {
		return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
	}
}

function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "standing",
		claim_text: "The user lives in Kyoto.",
		subject: "user",
		subject_kind: "user",
		attribute: "identity.location",
		value: "Kyoto",
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: false,
		ends_current: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: TURNS[0]?.content },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

describe("atomic subject guard", () => {
	it("finishes one eligible repair before the single guard and includes its profile", async () => {
		const events: string[] = [];
		const transport = new ScriptedSubjectTransport(
			async ({ episode: inputEpisode }) => {
				events.push(`repair-start:${inputEpisode.claimText}`);
				await Promise.resolve();
				events.push(`repair-complete:${inputEpisode.claimText}`);
				return [repairedProfile(0)];
			},
			({ records }) => {
				events.push(`guard:${records.map(({ claimText }) => claimText).join("|")}`);
				return records.map(() => true);
			},
		);
		const pairedEpisode = episode(1);
		const existingProfile = enhancedRecord(1, {
			claimText: "Existing jazz profile.",
			attribute: "preference.music",
			value: "jazz",
		});

		const output = await runAtomicSubjectGuard({
			records: [episode(0), pairedEpisode, existingProfile],
			turns: TURNS,
			transport,
		});

		expect(transport.repairCalls).toHaveLength(1);
		expect(transport.repairCalls[0]?.episode.claimText).toBe("Episode for turn 0.");
		expect(transport.guardCalls).toHaveLength(1);
		expect(transport.guardCalls[0]?.records.map(({ claimText }) => claimText)).toEqual([
			"Existing jazz profile.",
			"Repaired profile for turn 0.",
		]);
		expect(events).toEqual([
			"repair-start:Episode for turn 0.",
			"repair-complete:Episode for turn 0.",
			"guard:Existing jazz profile.|Repaired profile for turn 0.",
		]);
		expect(output.find(({ claimText }) => claimText === "Repaired profile for turn 0.")).toMatchObject({
			lane: "active",
			resplit: true,
		});
	});

	it("skips the guard for third-party, parked, and profile-free inputs", async () => {
		const transport = new ScriptedSubjectTransport(
			() => {
				throw new Error("repair must not run");
			},
			() => {
				throw new Error("guard must not run");
			},
		);
		const thirdParty = enhancedRecord(0, {
			claimText: "Ada lives in London.",
			subject: "entity:ada-lovelace",
			attribute: "identity.location",
			value: "London",
		});
		const parked = enhancedRecord(1, {
			lane: "parked",
			dispositionReason: "compound",
			subject: null,
			attribute: null,
		});
		const noChangeEpisode = episode(0, { changesCurrentState: false });

		const output = await runAtomicSubjectGuard({
			records: [thirdParty, parked, noChangeEpisode],
			turns: TURNS,
			transport,
		});

		expect(transport.repairCalls).toHaveLength(0);
		expect(transport.guardCalls).toHaveLength(0);
		expect(output).toEqual([thirdParty, parked, noChangeEpisode]);
		expect(output[0]).toMatchObject({
			lane: "active",
			subject: "entity:ada-lovelace",
			attribute: "identity.location",
		});
	});
});

describe("atomic subject guard failure behavior", () => {
	it("parks false as rejected and failed or malformed batches as unverified", async () => {
		const selected = [enhancedRecord(0), enhancedRecord(1)];
		const rejecting = new ScriptedSubjectTransport(
			() => null,
			() => [false, true],
		);
		const rejected = await runAtomicSubjectGuard({ records: selected, turns: TURNS, transport: rejecting });
		expect(rejected[0]).toMatchObject({
			lane: "parked",
			dispositionReason: "subject-rejected",
			subject: null,
			attribute: null,
		});
		expect(rejected[1]).toMatchObject({ lane: "active", subject: "user" });

		const failedGuards = [
			new ScriptedSubjectTransport(() => null, () => null),
			new ScriptedSubjectTransport(
				() => null,
				() => {
					throw new Error("ordinary guard failure");
				},
			),
		];
		for (const transport of failedGuards) {
			const output = await runAtomicSubjectGuard({ records: selected, turns: TURNS, transport });
			expect(output).toHaveLength(selected.length);
			for (const item of output) {
				expect(item).toMatchObject({
					lane: "parked",
					dispositionReason: "subject-unverified",
					subject: null,
					attribute: null,
				});
			}
		}

		// A reply that answers for some records and not others parks only the unanswered ones:
		// the whole batch used to go, and with it every statement the model did decide.
		const partial = new ScriptedSubjectTransport(() => null, () => [true, null]);
		const partialOutput = await runAtomicSubjectGuard({ records: selected, turns: TURNS, transport: partial });
		expect(partialOutput[0]).toMatchObject({ lane: "active", subject: "user" });
		expect(partialOutput[1]).toMatchObject({
			lane: "parked",
			dispositionReason: "subject-unverified",
			subject: null,
			attribute: null,
		});
	});

	it("keeps an unanswered episode alone and parks compound repair without another re-split", async () => {
		for (const answer of [null, [], new Error("ordinary repair failure")]) {
			const transport = new ScriptedSubjectTransport(
				() => {
					if (answer instanceof Error) throw answer;
					return answer;
				},
				() => {
					throw new Error("guard must not run without a repaired profile");
				},
			);
			const sourceEpisode = episode(0);
			const output = await runAtomicSubjectGuard({
				records: [sourceEpisode],
				turns: TURNS,
				transport,
			});
			expect(output).toEqual([sourceEpisode]);
			expect(transport.guardCalls).toHaveLength(0);
		}

		const compoundTransport = new ScriptedSubjectTransport(
			() => [repairedProfile(0, { singleClaim: false })],
			() => {
				throw new Error("parked compound must not reach guard");
			},
		);
		const compoundOutput = await runAtomicSubjectGuard({
			records: [episode(0)],
			turns: TURNS,
			transport: compoundTransport,
		});
		expect(compoundTransport.repairCalls).toHaveLength(1);
		expect(compoundTransport.guardCalls).toHaveLength(0);
		expect(compoundOutput).toContainEqual(
			expect.objectContaining({
				claimText: "Repaired profile for turn 0.",
				lane: "parked",
				dispositionReason: "compound",
				subject: null,
				attribute: null,
				resplit: true,
			}),
		);
	});

	it("propagates terminal auth and real cancellation from repair and guard", async () => {
		const terminalErrors = [
			new LlmClientTerminalError("auth", "authentication refused"),
			new LlmClientTerminalError("cancelled", "caller cancelled", false),
		];
		for (const error of terminalErrors) {
			const repairFailure = new ScriptedSubjectTransport(
				() => {
					throw error;
				},
				() => [true],
			);
			await expect(
				runAtomicSubjectGuard({ records: [episode(0)], turns: TURNS, transport: repairFailure }),
			).rejects.toBe(error);

			const guardFailure = new ScriptedSubjectTransport(
				() => null,
				() => {
					throw error;
				},
			);
			await expect(
				runAtomicSubjectGuard({
					records: [enhancedRecord(0)],
					turns: TURNS,
					transport: guardFailure,
				}),
			).rejects.toBe(error);
		}
	});

	it("uses both registered LLM labels and rejects malformed adapter replies", async () => {
		const validClient = new RecordingClient(
			JSON.stringify({ records: [wireRecord()] }),
			{ decisions: [{ record_index: 0, durable_self_statement: true }] },
		);
		const transport = createAtomicSubjectGuardTransport(validClient);
		const repaired = await transport.repairMissingHalf({
			episode: episode(0),
			turn: TURNS[0] as AtomicExtractionTurn,
			turns: TURNS,
		});
		const decisions = await transport.guardUserSubjects({ records: [enhancedRecord(0)] });

		expect(repaired).toEqual([
			expect.objectContaining({ kind: "standing", attribute: "identity.location" }),
		]);
		expect(decisions).toEqual([true]);
		expect(validClient.textRequests).toHaveLength(1);
		expect(validClient.jsonRequests).toHaveLength(1);
		expect(validClient.textRequests[0]).toMatchObject({
			callLabel: "memory-extract-atomic-missing-half",
			adapterSlot: "memory-extract",
			emptyReplyAttempts: 1,
			enableThinking: false,
		});
		expect(validClient.jsonRequests[0]).toMatchObject({
			callLabel: "memory-extract-atomic-subject-guard",
			adapterSlot: "memory-extract",
			emptyReplyAttempts: 1,
			enableThinking: false,
		});
		expect(resolveLlmOccasion("memory-extract", "memory-extract-atomic-missing-half")).toBe(
			"memoryExtract",
		);
		expect(resolveLlmOccasion("memory-extract", "memory-extract-atomic-subject-guard")).toBe(
			"memoryExtract",
		);

		const malformed = createAtomicSubjectGuardTransport(
			new RecordingClient(
				JSON.stringify({ records: [wireRecord({ kind: "lesson" })] }),
				{ decisions: [{ record_index: 1, durable_self_statement: true }] },
			),
		);
		await expect(
			malformed.repairMissingHalf({
				episode: episode(0),
				turn: TURNS[0] as AtomicExtractionTurn,
				turns: TURNS,
			}),
		).resolves.toBeNull();
		// A decision for a record index the batch does not have leaves record 0 undecided, and an
		// undecided record is reported as such rather than the whole reply thrown away.
		await expect(
			malformed.guardUserSubjects({ records: [enhancedRecord(0)] }),
		).resolves.toEqual([null]);
	});
});
