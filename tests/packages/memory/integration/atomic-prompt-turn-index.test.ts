/** @file atomic-prompt-turn-index.test.ts
 * @purpose Proves every extraction prompt hands the model each turn's index instead of making it count.
 * @boundary The real prompt builders and the real subject-guard transport; the model itself is the only substitute.
 */

import { describe, expect, it } from "vitest";
import type { AtomicExtractionTurn } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { buildAtomicGenericExtractionPrompt } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { numberAtomicTurns } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-replacement-sanitizer";
import { createAtomicSubjectGuardTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-subject-guard";
import type { LlmClient, MemoryLlmRequest } from "../../../../packages/sno-station-mem/src/model/llm-client-types";

/**
 * The exact shape that broke, cut down from Memora session 24: a dictated email with TWO
 * CONSECUTIVE assistant turns at indices 3 and 4. Counting a transcript like this is where the
 * model slipped — it reported turns 4, 6, 8 and 10 for text that lives at 5, 7, 9 and 11,
 * `resolveSpan` looked in an assistant turn, found nothing, and all seven records of the email
 * were parked with a null span. A fixture without the doubled assistant turn cannot go red here.
 */
const TURNS: AtomicExtractionTurn[] = [
	{ role: "user", content: "Hi there! I was hoping you could help me with something." },
	{ role: "assistant", content: "Hello! I'd be happy to help. What's on your mind?" },
	{ role: "user", content: "I need to organize the details for an email I'm drafting." },
	{ role: "assistant", content: "Of course. Let's start with the purpose." },
	{ role: "assistant", content: "What is the email meant to do?" },
	{ role: "user", content: "The email is to outline strategic research priorities." },
	{ role: "assistant", content: "Understood. Who is receiving it?" },
	{ role: "user", content: "The email will be sent to the Non-profit Leadership Team." },
	{ role: "assistant", content: "Got it. What are the key points?" },
	{ role: "user", content: "The key points are the proposed framework and the standards gap." },
	{ role: "assistant", content: "And what should they do next?" },
	{ role: "user", content: "I'd like them to schedule a follow-up discussion." },
	{ role: "assistant", content: "I have everything for the email now." },
	{ role: "user", content: "Thank you so much for your help with this!" },
];

/**
 * Every index the model got wrong before the fix, and the assistant turn each wrong index pointed
 * at. Asserting these by name keeps the test tied to the measured failure rather than to a count.
 */
const USER_TURN_INDEXES = [5, 7, 9, 11] as const;

function captureClient(): { client: LlmClient; prompts: string[] } {
	const prompts: string[] = [];
	// The model is the one thing that cannot run inside a deterministic test, and its answer is
	// irrelevant here: what is being proved is the text sent TO it. Returning null is a supported
	// degraded reply, so the transport takes its ordinary path and no parsing is skipped.
	const client: LlmClient = {
		async completeJson<T>(request: MemoryLlmRequest): Promise<T | null> {
			prompts.push(request.prompt);
			return null;
		},
		async completeText(request: MemoryLlmRequest): Promise<string | null> {
			prompts.push(request.prompt);
			return null;
		},
		getResolvedConfig: () => {
			throw new Error("capture client resolves no preset");
		},
		getLastError: () => null,
		getLastUsage: () => null,
	};
	return { client, prompts };
}

function episodeRecord(): AtomicKeyedRecord {
	return {
		kind: "occurrence",
		category: "episodic",
		claimText: "The user drafted an email to the Non-profit Leadership Team on 2026-06-04.",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: "drafted an email",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: true,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: 7,
			quote: "The email will be sent to the Non-profit Leadership Team.",
			startOffset: 0,
			endOffset: 56,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	} as AtomicKeyedRecord;
}

/** Each turn's index must reach the model paired with that turn's own text, not near it. */
function expectNumberedTranscript(prompt: string): void {
	for (const [index, turn] of TURNS.entries()) {
		// The transcript is rendered as JSON, so an index arrives as data the model copies.
		expect(prompt, `turn ${index} index`).toContain(`"turn_index":${index}`);
		const pair = `"turn_index":${index},"role":"${turn.role}","content":${JSON.stringify(turn.content)}`;
		expect(prompt, `turn ${index} pairing`).toContain(pair);
	}
	for (const index of USER_TURN_INDEXES) {
		expect(TURNS[index]?.role, `turn ${index} is a user turn`).toBe("user");
	}
}

describe("atomic prompt turn index", () => {
	it("stamps each turn with the index the pipeline will read back", () => {
		const numbered = numberAtomicTurns(TURNS);
		expect(numbered).toHaveLength(TURNS.length);
		for (const [index, turn] of numbered.entries()) {
			expect(turn.turn_index).toBe(index);
			expect(turn.role).toBe(TURNS[index]?.role);
			expect(turn.content).toBe(TURNS[index]?.content);
		}
	});

	it("numbers the transcript in the generic extraction prompt", () => {
		expectNumberedTranscript(
			buildAtomicGenericExtractionPrompt(TURNS, "2026-06-04T09:00:00Z", "en"),
		);
	});

	it("numbers the transcript in the missing-durable-half prompt", async () => {
		const { client, prompts } = captureClient();
		const transport = createAtomicSubjectGuardTransport(client);
		const turn = TURNS[7];
		if (turn === undefined) throw new Error("fixture lost its turn 7");
		const result = await transport.repairMissingHalf({
			episode: episodeRecord(),
			turn,
			turns: TURNS,
			locale: "en",
		});
		expect(result).toBeNull();
		expect(prompts).toHaveLength(1);
		expectNumberedTranscript(prompts[0] ?? "");
	});
});
