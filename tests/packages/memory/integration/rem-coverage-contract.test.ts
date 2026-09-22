/** Independent coverage logic plus production-entry journal acceptance. */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildRemUpdateReferenceSet,
	installRemSchema,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import {
	startQcg17ScriptedInvalidResponseFixture,
	type Qcg17ScriptedInvalidResponseFixture,
} from "../../../apps/mem-claw/helpers/rem-qcg17-scripted-invalid-response-fixture.ts";
import {
	seedProductionMemory,
	startRemProductionEntryFixture,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";

type ProductExports = Record<string, unknown>;
const scriptedFixtures: Qcg17ScriptedInvalidResponseFixture[] = [];

afterEach(async () => {
	for (const fixture of scriptedFixtures.splice(0)) await fixture.close();
});

interface CoverageAtom {
	atomId: string;
	kind: "structured-member" | "structured-field" | "anchor" | "clause";
	sourceTextSha256: string;
	startByte: number;
	endByte: number;
	text: string;
}

interface ClauseGateResult {
	decision: "allow" | "refuse";
	reason: string | null;
	arms: Record<string, "pass" | "fail" | "owner-unset">;
}

type CoverageBuildResult =
	| { outcome: "accept"; atoms: CoverageAtom[] }
	| { outcome: "refuse"; reason: string };

const atomCases = [
	{ id: "atom-shape", source: "On 2026-08-08, the user chose the quiet library desk." },
	{ id: "utf8-byte-span", source: "用户在 2026-08-08 选择安静的图书馆座位。" },
	{ id: "structured-array-and-object", source: '[{"seat":"window","noise":"quiet"},"tea"]' },
	{ id: "prose-anchors-and-clauses", source: 'On 2026-08-08, Larry said "quiet desk". Budget: 42.' },
] as const;

const clauseGateCases = [
	{ id: "non-owner-arms-valid", artifact: {}, expectedArm: "goldSet", expectedStatus: "pass" },
	{ id: "gold-set-digest-tampered", artifact: { measuredGoldSetSha256: "f".repeat(64) }, expectedArm: "goldSet", expectedStatus: "fail" },
	{ id: "confidence-unmet", artifact: { confidenceSatisfied: false }, expectedArm: "confidence", expectedStatus: "fail" },
	{ id: "declaration-after-result", artifact: { declarationSequence: 3, firstScoredSequence: 2 }, expectedArm: "chronology", expectedStatus: "fail" },
	{ id: "measurement-missing", artifact: { measurementPresent: false }, expectedArm: "measurement", expectedStatus: "fail" },
	{ id: "artifact-digest-tampered", artifact: { artifactDigestMatches: false }, expectedArm: "artifactDigest", expectedStatus: "fail" },
] as const;

describe("REM coverage API atoms", () => {
	it.each(atomCases)("$id exposes exhaustive UTF-8-bound atoms without close", ({ source }) => {
		const units = buildRemUpdateReferenceSet({ source, tier: "prose", locale: "en" });
		expect(units.length).toBeGreaterThan(0);
		for (const unit of units) {
			const atom = unit as unknown as Partial<CoverageAtom>;
			expect(atom.atomId).toMatch(/^atom:/u);
			expect(atom.kind).toMatch(/^(structured-member|structured-field|anchor|clause)$/u);
			expect(atom.sourceTextSha256).toBe(createHash("sha256").update(source).digest("hex"));
			expect(Buffer.from(source).subarray(atom.startByte, atom.endByte).toString("utf8")).toBe(
				atom.text,
			);
		}
	});

	it("refuses empty prose instead of returning an empty reference set", () => {
		expect(() =>
			buildRemUpdateReferenceSet({ source: "", tier: "prose", locale: "en" }),
		).toThrow(/empty|parse|reference/i);
	});
});

describe("REM measured clause gate (coverage only; frozen function)", () => {
	it.each(clauseGateCases)("$id validates its independent arm but the owner-null gate refuses", async ({ artifact, expectedArm, expectedStatus }) => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["validateRemClauseCoverageArtifacts"];
		expect(candidate, "missing production clause artifact validator validateRemClauseCoverageArtifacts").toBeTypeOf(
			"function",
		);
		const evaluate = candidate as (input: Record<string, unknown>) => Promise<ClauseGateResult>;
		const result = await evaluate({
			accuracyFloor: null,
			expectedGoldSetSha256: "e".repeat(64),
			measuredGoldSetSha256: "e".repeat(64),
			confidenceSatisfied: true,
			declarationSequence: 1,
			firstScoredSequence: 2,
			measurementPresent: true,
			artifactDigestMatches: true,
			...artifact,
		});
		expect(result.arms[expectedArm]).toBe(expectedStatus);
		expect(result.arms["accuracyFloor"]).toBe("owner-unset");
		expect(result.decision).toBe("refuse");
		expect(result.reason).toBe("coverage.accuracyFloor");
	});

	it("refuses measured accuracy below the configured floor", async () => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["validateRemClauseCoverageArtifacts"];
		expect(candidate).toBeTypeOf("function");
		const evaluate = candidate as (input: Record<string, unknown>) => Promise<ClauseGateResult>;
		const result = await evaluate({
			accuracyFloor: 0.9,
			measuredAccuracy: 0.899,
			expectedGoldSetSha256: "e".repeat(64),
			measuredGoldSetSha256: "e".repeat(64),
			confidenceSatisfied: true,
			declarationSequence: 1,
			firstScoredSequence: 2,
			measurementPresent: true,
			artifactDigestMatches: true,
		});

		expect(result).toMatchObject({
			decision: "refuse",
			reason: "coverage.accuracyFloor",
			arms: { accuracyFloor: "fail" },
		});
	});

	it("allows measured accuracy equal to the configured floor", async () => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["validateRemClauseCoverageArtifacts"];
		expect(candidate).toBeTypeOf("function");
		const evaluate = candidate as (input: Record<string, unknown>) => Promise<ClauseGateResult>;
		const result = await evaluate({
			accuracyFloor: 0.9,
			measuredAccuracy: 0.9,
			expectedGoldSetSha256: "e".repeat(64),
			measuredGoldSetSha256: "e".repeat(64),
			confidenceSatisfied: true,
			declarationSequence: 1,
			firstScoredSequence: 2,
			measurementPresent: true,
			artifactDigestMatches: true,
		});

		expect(result).toMatchObject({
			decision: "allow",
			reason: null,
			arms: { accuracyFloor: "pass" },
		});
	});

	it("refuses a missing measured accuracy when the floor is configured", async () => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["validateRemClauseCoverageArtifacts"];
		expect(candidate).toBeTypeOf("function");
		const evaluate = candidate as (input: Record<string, unknown>) => Promise<ClauseGateResult>;
		const result = await evaluate({
			accuracyFloor: 0.9,
			measuredAccuracy: null,
			expectedGoldSetSha256: "e".repeat(64),
			measuredGoldSetSha256: "e".repeat(64),
			confidenceSatisfied: true,
			declarationSequence: 1,
			firstScoredSequence: 2,
			measurementPresent: true,
			artifactDigestMatches: true,
		});

		expect(result).toMatchObject({
			decision: "refuse",
			reason: "coverage.measurementMissing",
		});
	});
});

describe("REM structured reference units (coverage only; frozen function)", () => {
	it.each([
		{ id: "three-array-members", source: '["quiet desk","window seat","tea"]', format: "structured", expected: 3 },
		{ id: "duplicate-anchor-occurrences", source: 'The user chose "quiet desk", then reaffirmed "quiet desk".', format: "prose", expected: 2 },
	] as const)("$id preserves unit identity", async ({ source, format, expected }) => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["buildRemCoverageAtoms"];
		expect(candidate, "missing production coverage atom builder buildRemCoverageAtoms").toBeTypeOf(
			"function",
		);
		const build = candidate as (input: Record<string, unknown>) => CoverageBuildResult;
		const result = build({ source, format });
		expect(result.outcome).toBe("accept");
		if (result.outcome !== "accept") throw new Error(`unexpected refusal: ${result.reason}`);
		expect(result.atoms.filter((atom) => atom.kind !== "clause")).toHaveLength(expected);
	});

	it("refuses a flattened clause list without recoverable unit identity", async () => {
		const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		const candidate = product["buildRemCoverageAtoms"];
		expect(candidate, "missing production coverage atom builder buildRemCoverageAtoms").toBeTypeOf(
			"function",
		);
		const build = candidate as (input: Record<string, unknown>) => CoverageBuildResult;
		const result = build({
			source: "quiet desk | window seat | tea",
			format: "flattened-clauses",
		});
		expect(result).toEqual({ outcome: "refuse", reason: "unsegmentable_reference_set" });
	});
});

describe("REM non-refusePair refusal journal (logic coverage; production proof follows)", () => {
	it.each([
		{ id: "arbitration-refusal", decision: "refuse", source: "arbitration", reason: "verdict_absent", throughRefusePair: false, expectedRows: 1 },
		{ id: "coverage-refusal", decision: "refuse", source: "coverage", reason: "verdict_evidence_mismatch", throughRefusePair: false, expectedRows: 1 },
		{ id: "allowed-arbitration", decision: "allow", source: "arbitration", reason: null, throughRefusePair: false, expectedRows: 0 },
		{ id: "allowed-coverage", decision: "allow", source: "coverage", reason: null, throughRefusePair: false, expectedRows: 0 },
		{ id: "sibling-refusal", decision: "refuse", source: "coverage", reason: "sibling_refuse_pair", throughRefusePair: true, expectedRows: 0 },
	] as const)("$id writes the exact terminal row count", async ({ id, decision, source, reason, throughRefusePair, expectedRows }) => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
			const candidate = product["recordNonRefusePairDecision"];
			expect(
				candidate,
				"missing production non-refusePair journal boundary recordNonRefusePairDecision",
			).toBeTypeOf("function");
			const record = candidate as (input: Record<string, unknown>) => Promise<void>;
			await record({
				database: fixture.runtime.db,
				attemptIdentity: `attempt-${id}`,
				decision,
				operation: "rem-replace",
				reason,
				source,
				throughRefusePair,
				waveId: `wave-${id}`,
			});
			const row = fixture.runtime.raw
				.prepare("SELECT count(*) AS count FROM nodix_rem_journal WHERE attempt_id = ?")
				.get(`attempt-${id}`) as { count: number };
			expect(row.count).toBe(expectedRows);
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses an attempt identity reused with a different source or reason", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
			const record = product["recordNonRefusePairDecision"] as (
				input: Record<string, unknown>,
			) => Promise<void>;
			const first = {
				database: fixture.runtime.db,
				attemptIdentity: "attempt-conflict",
				decision: "refuse",
				operation: "rem-replace",
				reason: "verdict_absent",
				source: "arbitration",
				throughRefusePair: false,
				waveId: "wave-conflict",
			};
			await record(first);
			await expect(
				record({ ...first, reason: "coverage_missing", source: "coverage" }),
			).rejects.toThrow("attempt_decision_conflict");
			expect(
				fixture.runtime.raw
					.prepare("SELECT count(*) AS count FROM nodix_rem_journal WHERE attempt_id = ?")
					.get(first.attemptIdentity),
			).toEqual({ count: 1 });
		} finally {
			fixture.cleanup();
		}
	});
});

describe("ACC-37 production edge: live journal outcomes", () => {
	it("uses the live response port and journals one external refusal", { timeout: 30_000 }, async () => {
		const marker = "REM_REACHABILITY_SCRIPTED_INVALID_RESPONSE_ONLY";
		// The real verdict route, not ccproxy: this fixture serves `/verdict/v1/completions`, which
		// takes a `prompt` and returns `choices[0].text`, and ccproxy has no completions endpoint at
		// all — it answers 404, and a converted request 400s with `messages Field required`. So every
		// call this fixture forwarded was guaranteed to fail before it reached a model. Verified
		// 2026-08-12 against both: ccproxy `/completions` -> 404, the Sno GPU verdict route -> 200
		// with `choices[0].text`.
		const responseFixture = await startQcg17ScriptedInvalidResponseFixture({
			invalidPromptMarker: marker,
			upstreamUrl: "https://rt3-llm.sno.ai/verdict/v1/completions",
			// Every attempt at the marked prompt, retries included. This route has no upstream that can
			// answer a forwarded call, so a leaked retry is a guaranteed failure rather than a real
			// second opinion; `forwardedCalls === 0` below is the assertion that holds it to that.
			maxInjectedCalls: Number.MAX_SAFE_INTEGER,
		});
		scriptedFixtures.push(responseFixture);
		const fixture = await startRemProductionEntryFixture({ gpuBaseUrl: responseFixture.url });
		try {
			// The config's own route, unchanged. It is not what this test exercises: the endpoint the
			// wave calls is built from gpuBaseUrl, which is the scripted fixture above.
			expect(fixture.configuration["modelRoute"]).toBe(
				"http://localhost:8070/codex/v1/chat/completions",
			);
			const scope = "persona:production-journal-outcomes";
			seedProductionMemory(fixture.database.sqlite, {
				id: "clremjournalstale0000000001",
				metadata: { section_name: "preferences.journal", topic: "preferences.journal" },
				scope,
				text: `${marker}: The user preferred a standing desk.`,
				timestamp: "2026-08-08T08:00:00.000Z",
			});
			seedProductionMemory(fixture.database.sqlite, {
				id: "clremjournalcurrent0000001",
				metadata: { section_name: "preferences.journal", topic: "preferences.journal" },
				scope,
				text: "The user now prefers a quiet library desk.",
				timestamp: "2026-08-09T08:00:00.000Z",
			});
			const started = await fixture.submit(
				"rem-replace",
				scope,
				"correlation-production-journal",
			);
			const terminal = await fixture.waitForTerminal(productionIdentity(started), 20_000);
			// This corpus is one pair, and its only model call is the scripted invalid one, so every
			// call the wave made failed and it stops on that. It used to expect `journal_only`, which
			// this path cannot reach and does not mean this: that reason fires when the journal holds a
			// row that is neither refused, disabled nor no-action while no write attempt succeeded — an
			// internal-inconsistency alarm, not the ordinary answer to one bad model response. The
			// expectation was unreachable and was masked for months by an upstream that 400d first.
			expect(terminal).toMatchObject({
				error: expect.stringContaining("ordered_wave_stage_failed"),
				state: "failed",
			});
			const observation = responseFixture.observation();
			// The client retries an invalid response, so the marked prompt arrives more than once. The
			// number that has to hold is the second one: NOTHING carrying the marker was forwarded to a
			// live model, which is the whole boundary of the scripted carve-out.
			expect(observation.injectedCalls).toBeGreaterThanOrEqual(1);
			expect(observation.forwardedCalls).toBe(0);
			expect(observation.requestPaths.length).toBeGreaterThan(0);
			expect(new Set(observation.requestPaths)).toEqual(
				new Set(["/verdict/v1/completions"]),
			);
			// What the wave reports when every call it made returned an unparseable answer. It used to
			// assert a transport log line, which stopped describing this path once the fixture answered
			// in the shape the verdict route reads: the call now succeeds at HTTP level and fails on the
			// content, so the cause is the refusal reason, not a pipeline error. The durable rows below
			// are the real proof; this line only checks the fatal message names a cause at all, because
			// it read `unknown` for a cause the loop had already journalled.
			expect(fixture.stderr()).toContain("REM LLM calls all failed: model_response_invalid");
			const rows = fixture.database.sqlite
				.prepare(
					`SELECT job_id, attempt_id, stage, outcome, reason
					 FROM nodix_rem_journal
					 WHERE attempt_id IS NOT NULL AND outcome = 'refused'`,
				)
				.all() as Array<Record<string, unknown>>;
			expect(rows).toEqual([
				expect.objectContaining({
					attempt_id: expect.any(String),
					job_id: expect.any(String),
					outcome: "refused",
					reason: expect.any(String),
					stage: expect.stringMatching(/^(arbitration|coverage)$/u),
				}),
			]);
			process.stdout.write(
				"ACC-37 scripted response integration; paired real E2E: tests/apps/mem-claw/e2e-agent/rem-write-path-reachable.e2e.sh\n",
			);
		} finally {
			await fixture.stop();
		}
	});
});

function productionIdentity(response: Record<string, unknown>): string {
	for (const key of ["waveId", "wave_id", "job_id"]) {
		const value = response[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`production response omitted wave identity: ${JSON.stringify(response)}`);
}
