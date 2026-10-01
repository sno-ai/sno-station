/** Independent census/calibration coverage. Direct calls below do not earn production acceptance. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createHash } from "node:crypto";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createRemOwnerNullOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

type ProductExports = Record<string, unknown>;
type Decision = { decision: "allow" | "refuse"; reasonCode: string | null };

async function boundary<T>(name: string): Promise<T> {
	const product = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production census boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

const configuration = createRemOwnerNullOperationalConfiguration();
const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("ACC-37 production edge: release census", () => {
	it("runs both named census boundaries from the rem:guard-census command", () => {
		const packageJson = JSON.parse(
			readFileSync(resolve(repoRoot, "apps/mem-claw/package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		const releaseCommand = packageJson.scripts?.["rem:guard-census"];
		expect(releaseCommand, "missing pre-package rem:guard-census command").toBeTypeOf("string");
		const result = spawnSync("npm", ["run", "rem:guard-census"], {
			cwd: resolve(repoRoot, "packages/memory"),
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output).toContain("discoverRemWritersFromCallGraph");
		expect(output).toContain("validateRemGuardCensus");
		expect(output).toContain("current=24");
	});
});

describe("REM prospective identities", () => {
	it("persists write identity before adjudication", async () => {
		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
		try {
			const stored = await store.store({
				text: "candidate",
				category: "profile",
				projectId: "store-a",
				metadata: '{"section_name":"preferences.general"}',
				trusted: true,
			});
			const row = fixture.runtime.raw.prepare("SELECT write_identity_sha256 FROM nodix_rem_census_rows WHERE row_id=?").get(stored.id) as { write_identity_sha256: string };
			expect(row.write_identity_sha256).toMatch(/^[0-9a-f]{64}$/u);
		} finally { store.close(); fixture.cleanup(); }
	});
	it("rejects a scan-generation pair id as the write identity", async () => {
		const validate = await boundary<(input: Record<string, string>) => Decision>("validateRemProspectiveIdentity");
		expect(validate({ writeIdentitySha256: "generation-a:row-a", candidateSetSha256: "set-a" })).toEqual({ decision: "refuse", reasonCode: "scan_generation_identity" });
	});
	it("keeps write and candidate-set identities as separate persisted fields", async () => {
		const validate = await boundary<(input: Record<string, string>) => Decision>("validateRemProspectiveIdentity");
		expect(validate({ writeIdentitySha256: "a".repeat(64), candidateSetSha256: "b".repeat(64) })).toEqual({ decision: "allow", reasonCode: null });
	});
});

describe("REM artifact-derived replay identity", () => {
	it.each([
		{ firstBytes: "embedder-a", secondBytes: "embedder-b", firstLabel: "same", secondLabel: "same", equal: false },
		{ firstBytes: "embedder-a", secondBytes: "embedder-a", firstLabel: "label-a", secondLabel: "label-b", equal: true },
	] as const)("derives identity from bytes rather than labels", async ({ firstBytes, secondBytes, firstLabel, secondLabel, equal }) => {
		const root = mkdtempSync(join(tmpdir(), "rem-replay-identity-"));
		try {
			const corpusPath = join(root, "corpus.json");
			const embedderPath = join(root, "embedder.bin");
			const toolPath = join(root, "tool.js");
			writeFileSync(corpusPath, "corpus-a");
			writeFileSync(toolPath, "tool-a");
			const derive = await boundary<(input: Record<string, unknown>) => { replayIdentitySha256: string }>("deriveRemReplayArtifactIdentity");
			writeFileSync(embedderPath, firstBytes);
			const first = derive({ corpusPath, embedderPath, toolPath, configuration, callerLabel: firstLabel });
			writeFileSync(embedderPath, secondBytes);
			const second = derive({ corpusPath, embedderPath, toolPath, configuration, callerLabel: secondLabel });
			expect(first.replayIdentitySha256 === second.replayIdentitySha256).toBe(equal);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("carries corpus, embedder, and configuration identity beside every label", async () => {
		const validate = await boundary<(input: Record<string, unknown>) => Decision>("validateRemReplayIdentityTuple");
		expect(validate({ corpusSha256: "a".repeat(64), embedderSha256: "b".repeat(64), configurationSha256: "c".repeat(64) })).toEqual({ decision: "allow", reasonCode: null });
	});
});

const oracleRoot = resolve(import.meta.dirname, "../../../fixtures/rem-census");
const oracleRows = [
	{ label: "reachability", path: "reachability/oracle.json" },
	{ label: "contradiction", path: "contradiction/oracle.json" },
	{ label: "coverageEligibility", path: "coverage-eligibility/oracle.json" },
].flatMap(({ label, path }) =>
	(
		JSON.parse(readFileSync(join(oracleRoot, path), "utf8")) as Array<{
			input: Record<string, unknown>;
			expected: string;
		}>
	).map((row) => ({ label, ...row })),
);

describe("REM independent census labels", () => {
	it.each(oracleRows)("matches the independent $label oracle", async ({ label, input, expected }) => {
		const classify = await boundary<(input: { label: string; observations: Record<string, unknown> }) => string>("classifyRemCensusLabel");
		expect(classify({ label, observations: input })).toBe(expected);
	});
	it("rejects an oracle produced by the product classifier", async () => {
		const validate = await boundary<(input: Record<string, unknown>) => Decision>("validateRemCensusOracleProvenance");
		expect(validate({ authoredBy: "product-classifier", sourcePath: "generated.json" })).toEqual({ decision: "refuse", reasonCode: "self_authored_oracle" });
	});
	it("changes only the label whose own observations changed", async () => {
		const classify = await boundary<(input: Record<string, unknown>) => Record<string, string>>("classifyAllRemCensusLabels");
		const first = classify({ reachability: { neighborEmitted: true, similarityMet: true }, contradiction: { sameFactKey: true, valuesConflict: false }, coverageEligibility: { referenceSetNonEmpty: true, retiringAtomsMatched: true, retrievabilityComputed: true } });
		const second = classify({ reachability: { neighborEmitted: false, similarityMet: true }, contradiction: { sameFactKey: true, valuesConflict: false }, coverageEligibility: { referenceSetNonEmpty: true, retiringAtomsMatched: true, retrievabilityComputed: true } });
		expect({ ...second, reachability: first.reachability }).toEqual(first);
	});
	it("rejects label values swapped between independent columns", async () => {
		const validate = await boundary<(input: Record<string, string>) => Decision>("validateRemCensusLabelTuple");
		expect(validate({ reachability: "yes", contradiction: "reachable", coverageEligibility: "eligible" })).toEqual({ decision: "refuse", reasonCode: "label_enum_mismatch" });
	});
});

describe("REM retained census artifact", () => {
	it.each([
		{ artifact: { pairs: [{ pairId: "pair-a", reachability: "reachable", contradiction: "yes", coverageEligibility: "eligible" }] }, expected: "allow" },
		{ artifact: null, expected: "artifact_missing" },
	] as const)("reads retained labels or reports absence", async ({ artifact, expected }) => {
		const root = mkdtempSync(join(tmpdir(), "rem-retained-census-"));
		try {
			const artifactPath = join(root, "generation-a.json");
			if (artifact !== null) writeFileSync(artifactPath, JSON.stringify(artifact));
			const read = await boundary<(input: { artifactPath: string; generationId: string }) => Decision & { artifactSha256?: string }>("readRetainedRemCensusArtifact");
			const result = read({ artifactPath, generationId: "generation-a" });
			expect(result).toMatchObject({ decision: expected === "allow" ? "allow" : "refuse", reasonCode: expected === "allow" ? null : expected });
			if (artifact !== null) expect(result.artifactSha256).toBe(createHash("sha256").update(readFileSync(artifactPath)).digest("hex"));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("REM capture and replay routes", () => {
	it.each([
		{ producer: "capture", expected: "capture" },
		{ producer: "replay", expected: "replay" },
	] as const)("records the $producer producer route", async ({ producer, expected }) => {
		const root = mkdtempSync(join(tmpdir(), "rem-route-"));
		try {
			const outputPath = join(root, `${producer}.json`);
			const produce = await boundary<(input: { producer: string; outputPath: string }) => void>("produceRemCensusArtifact");
			produce({ producer, outputPath });
			expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ route: expected });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("retains both routes in one complete run", async () => {
		const validate = await boundary<(input: Array<{ route: string }>) => Decision>("validateRemCensusRouteCoverage");
		expect(validate([{ route: "capture" }, { route: "replay" }])).toEqual({ decision: "allow", reasonCode: null });
	});
});

describe("REM generation transitions", () => {
	it.each([
		{ outgoing: "generation-a", incoming: "generation-b", expected: "allow" },
		{ outgoing: "generation-a", incoming: "generation-a", expected: "generation_identity_reused" },
	] as const)("journals distinct actual generations", async ({ outgoing, incoming, expected }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		try {
			const journal = await boundary<(input: Record<string, unknown>) => Decision>("journalRemGenerationTransition");
			const result = journal({ database: fixture.runtime.db, outgoingGenerationId: outgoing, incomingGenerationId: incoming });
			expect(result).toEqual({ decision: expected === "allow" ? "allow" : "refuse", reasonCode: expected === "allow" ? null : expected });
			if (expected === "allow") expect(fixture.runtime.raw.prepare("SELECT outgoing_generation_id,incoming_generation_id FROM nodix_rem_generation_transitions").get()).toEqual({ outgoing_generation_id: outgoing, incoming_generation_id: incoming });
		} finally { fixture.cleanup(); }
	});
});

describe("REM batch accounting", () => {
	it.each([
		{ events: [{ calls: 1, tokens: 20, verdict: "replacement", close: 1, refusal: null }, { calls: 2, tokens: 30, verdict: "keep", close: 0, refusal: "coverage" }], expected: { calls: 3, tokens: 50, pairCount: 2, closeCount: 1, refusalCount: 1 } },
		{ events: [{ calls: 1, tokens: 10, verdict: "replacement" }, { calls: 1, tokens: 10, verdict: "replacement" }, { calls: 1, tokens: 10, verdict: "keep" }], expected: { verdictDistribution: { replacement: 2, keep: 1 } } },
	] as const)("recomputes journal quantities from raw events", async ({ events, expected }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		try {
			const summarize = await boundary<(input: Record<string, unknown>) => void>("summarizeRemBatchEvents");
			summarize({ database: fixture.runtime.db, batchId: "batch-accounting", budgets: { calls: 10, tokens: 100 }, events });
			const persisted = fixture.runtime.raw.prepare("SELECT * FROM nodix_rem_batch_summaries WHERE batch_id='batch-accounting'").get() as Record<string, unknown>;
			expect({ ...persisted, verdictDistribution: JSON.parse(String(persisted.verdict_distribution_json ?? "{}")) }).toMatchObject(expected);
		} finally { fixture.cleanup(); }
	});
});

describe("REM verdict and cap recording", () => {
	it.each([
		{ observed: "invented", auditKind: "SAMPLE", persistedVerdict: null },
		{ observed: "replacement", auditKind: "VERDICT", persistedVerdict: "replacement" },
	] as const)("records $observed without corrupting the verdict enum", async ({ observed, auditKind, persistedVerdict }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		try {
			const record = await boundary<(input: Record<string, unknown>) => void>("recordRemObservedVerdict");
			record({ database: fixture.runtime.db, pairId: `pair-${observed}`, observed });
			expect(fixture.runtime.raw.prepare("SELECT audit_kind,persisted_verdict FROM nodix_rem_verdict_observations WHERE pair_id=?").get(`pair-${observed}`)).toEqual({ audit_kind: auditKind, persisted_verdict: persistedVerdict });
		} finally { fixture.cleanup(); }
	});
	it.each([
		{ total: 10, cap: 10, expected: { preTruncationCount: 10, emittedCount: 10 } },
		{ total: 11, cap: 10, expected: { preTruncationCount: 11, emittedCount: 10 } },
	] as const)("distinguishes exact cap from truncation", async ({ total, cap, expected }) => {
		const fixture = createTestDb(); installRemSchema(fixture.runtime.db);
		try {
			const count = await boundary<(input: Record<string, unknown>) => void>("recordRemCandidateCapCounts");
			count({ database: fixture.runtime.db, generationId: `generation-${total}`, total, cap });
			expect(fixture.runtime.raw.prepare("SELECT pre_truncation_count AS preTruncationCount,emitted_count AS emittedCount FROM nodix_rem_batch_summaries WHERE generation_id=?").get(`generation-${total}`)).toEqual(expected);
		} finally { fixture.cleanup(); }
	});
});

describe("REM calibration reporting", () => {
	it.each([
		{ field: "emittedFraction", expected: 0.5 },
		{ field: "targetRanks", expected: [1, 3] },
		{ field: "adjudicationReachability", expected: [true, false] },
	] as const)("reports independently counted $field", async ({ field, expected }) => {
		const root = mkdtempSync(join(tmpdir(), "rem-calibration-input-"));
		try {
			const retainedArtifactPath = join(root, "retained.json");
			writeFileSync(retainedArtifactPath, JSON.stringify({ pairs: ["a", "b", "c"] }));
			const digest = createHash("sha256").update(readFileSync(retainedArtifactPath)).digest("hex");
			const report = await boundary<(input: Record<string, unknown>) => Record<string, unknown>>("reportRemSimilarityCalibration");
			const result = report({ retainedArtifactPath, emittedPairIds: ["a", "b"], targetPairIds: ["a", "c"], rankedPairIds: ["a", "x", "c"], modelCallBudget: 2 });
			expect(result[field]).toEqual(expected);
			expect(result.consumedArtifactSha256).toBe(digest);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("rejects self-reported quantities without an independent count", async () => {
		const validate = await boundary<(input: Record<string, unknown>) => Decision>("validateRemCalibrationCrossCheck");
		expect(validate({ reported: { emittedFraction: 1 }, independent: null })).toEqual({ decision: "refuse", reasonCode: "independent_count_missing" });
	});
});

describe("REM owner-null calibration declaration", () => {
	it("refuses the combined declaration on the fixed first unset key", async () => {
		const declare = await boundary<(input: { configuration: Record<string, unknown> }) => Decision>("declareRemCalibrationThreshold");
		expect(declare({ configuration })).toEqual({ decision: "refuse", reasonCode: "calibration.minimumPublishableScoreEffect" });
	});
	it.each([
		"minimumPublishableScoreEffect",
		"minimumTargetCount",
		"minimumTargetPercent",
	] as const)("preserves the explicit null state for $field", async (field) => {
		const parse = await boundary<(input: Record<string, unknown>) => Record<string, unknown>>("parseRemOperationalConfiguration");
		const parsed = parse(configuration);
		expect((parsed.calibration as Record<string, unknown>)[field]).toBeNull();
	});
});
