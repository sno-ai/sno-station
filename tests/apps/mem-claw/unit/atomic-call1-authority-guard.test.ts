/** @file Guards call 1 as the only worth-keeping authority in the atomic write flow. */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const EXTRACTION_DIR = join(REPO_ROOT, "packages/memory/src/engine/extraction");
const STORAGE_DIR = join(REPO_ROOT, "packages/memory/src/store");
const WRITE_DOOR = "packages/memory/src/store/memory-store-atomic-extraction-write-api.ts";
const ATOMIC_ENTRYPOINT_FILES = [
	"apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts",
	"packages/memory/src/engine/bindings/sno-station-mem-ambient-learning-hook.ts",
	"packages/memory/src/engine/bindings/sno-station-mem-insight-distill-factory.ts",
] as const;
const ATOMIC_REACHED_FILES = [
	"packages/memory/src/engine/extraction/b-profile-extraction.ts",
	"packages/memory/src/engine/extraction/task-lifecycle-route.ts",
] as const;

const ATOMIC_FLOW_FILES = [
	"packages/memory/src/engine/extraction/atomic-profile-keying.ts",
	"packages/memory/src/engine/extraction/atomic-progress-boundary.ts",
	"packages/memory/src/engine/extraction/atomic-extraction-gauntlet.ts",
	"packages/memory/src/engine/extraction/atomic-extraction-reply.ts",
	"packages/memory/src/engine/extraction/atomic-extraction-skill.ts",
	"packages/memory/src/engine/extraction/atomic-generic-extractor.ts",
	"packages/memory/src/engine/extraction/atomic-memory-extraction.ts",
	"packages/memory/src/engine/extraction/atomic-replacement-sanitizer.ts",
	"packages/memory/src/engine/extraction/atomic-subject-guard.ts",
	"packages/memory/src/engine/extraction/atomic-temporal-normalization.ts",
	"packages/memory/src/engine/extraction/atomic-write-projection.ts",
	WRITE_DOOR,
] as const;

// Model call ids from packages/memory/src/model/model-call-table.ts: extraction (E1), its
// enrichment and figure re-ask (E2, E3), compound split (E4), missing half (E5), subject check
// (E6), unresolved-subject re-ask (E7) and the arrival retirement judgement (E10, PRD 150).
const ALLOWED_MODEL_CALL_IDS = new Set(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E10"]);

type SourceUnit = { path: string; source: string };

// Close-on-arrival and the arrival retirement judgement live in the write path by design
// (PRD 150), so superseding, retiring and candidate reads are no longer fenced out of it. What
// stays fenced is the legacy profile writer and the legacy distillation, hash and keyword paths.
const PHASE_FENCE_PATTERNS = [
	{
		rule: "legacy-profile-writer",
		pattern: /\b(?:buildMergePrompt|runProfileSectionUpdate)\s*\(/u,
	},
	{
		rule: "local-distillation-writer",
		pattern: /\b(?:new\s+InsightDistiller|storeCandidate|processExtractedCandidate)\s*\(/u,
	},
	{
		rule: "redirect-on-hash",
		pattern: /\b(?:findByContentHash|readExistingByHash)\s*\(/u,
	},
	{
		rule: "keyword-classification",
		pattern:
			/\b(?:shouldSkipCapture|decideCapture|detectCategoryVote|extractEpisodicLane|extractProfileLane)\s*\(/iu,
	},
] as const;

function executableSource(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
}

function findAuthorityViolations(units: readonly SourceUnit[]): string[] {
	const violations: string[] = [];
	const callIdCounts = new Map<string, number>();
	for (const unit of units) {
		const flat = unit.source.replace(/\s+/gu, " ");
		// A route lookup names the call id to find its destination; it is not a second model call.
		const callSites = unit.source.replace(/resolveLlmRoute\s*\(\s*\{[^}]*\}\s*\)/gu, "");
		for (const match of callSites.matchAll(/callId:\s*["']([^"']+)["']/gu)) {
			const callId = match[1];
			if (callId) callIdCounts.set(callId, (callIdCounts.get(callId) ?? 0) + 1);
			if (callId && !ALLOWED_MODEL_CALL_IDS.has(callId)) {
				violations.push(`worth-model-call:${unit.path}:${callId}`);
			}
		}
		if (
			/(?:llm|client|transport|model)\s*\.\s*\w*(?:worth|notab|keep|valuable)\w*\s*\(/iu.test(
				flat,
			)
		) {
			violations.push(`worth-model-call:${unit.path}`);
		}
		for (const line of unit.source.split("\n")) {
			if (
				/(?:record|candidate|card)/iu.test(line) &&
				/(?:score|confidence|notability|threshold)/iu.test(line) &&
				/(?:<=|>=|<|>)/u.test(line)
			) {
				violations.push(`score-threshold-write-decision:${unit.path}:${line.trim()}`);
			}
		}
		if (
			/\.filter\s*\([^)]*(?:worth|notab|importance|valuable|low[_-]?value)[^)]*\)/iu.test(
				flat,
			) ||
			/if\s*\([^)]*(?:worth|notab|importance|valuable|low[_-]?value)[^)]*\)[^;]{0,160}(?:continue|return\s+(?:null|undefined|\[\]))/iu.test(
				flat,
			)
		) {
			violations.push(`worth-drop-predicate:${unit.path}`);
		}
	}
	for (const callId of ALLOWED_MODEL_CALL_IDS) {
		const count = callIdCounts.get(callId) ?? 0;
		if (count !== 1) violations.push(`model-call-count:${callId}:${count}`);
	}
	return violations;
}

function assertNoAuthorityViolations(units: readonly SourceUnit[]): void {
	const violations = findAuthorityViolations(units);
	if (violations.length > 0) throw new Error(violations.join("\n"));
}

function readAtomicFlow(): SourceUnit[] {
	return ATOMIC_FLOW_FILES.map((path) => ({
		path,
		source: readFileSync(join(REPO_ROOT, path), "utf8"),
	}));
}

function readAtomicPhaseFiles(): SourceUnit[] {
	const extractionFiles = readdirSync(EXTRACTION_DIR)
		.filter((name) => name.startsWith("atomic-") && name.endsWith(".ts"))
		.map((name) => `packages/memory/src/engine/extraction/${name}`);
	const storageFiles = readdirSync(STORAGE_DIR)
		.filter((name) => name.includes("atomic") && name.endsWith(".ts"))
		.map((name) => `packages/memory/src/store/${name}`);
	return [
		...new Set([
			...extractionFiles,
			...storageFiles,
			...ATOMIC_ENTRYPOINT_FILES,
			...ATOMIC_REACHED_FILES,
		]),
	]
		.sort()
		.map((path) => ({ path, source: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

function findPhaseFenceViolations(units: readonly SourceUnit[]): string[] {
	return units.flatMap((unit) =>
		PHASE_FENCE_PATTERNS.flatMap(({ rule, pattern }) =>
			pattern.test(executableSource(unit.source)) ? [`${rule}:${unit.path}`] : [],
		),
	);
}

describe("atomic call-1 authority repository guard", () => {
	it("keeps stored-row lifecycle and read-side decisions out of the atomic phase", () => {
		const files = readAtomicPhaseFiles();
		expect(files.length).toBeGreaterThan(0);
		process.stdout.write(`ATOMIC_PHASE_FENCE_FILES ${files.map(({ path }) => path).join(",")}\n`);
		const violations = findPhaseFenceViolations(files);
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it.each(
		PHASE_FENCE_PATTERNS.map(({ rule }) => ({
			rule,
			source: {
				"legacy-profile-writer": "await runProfileSectionUpdate(params);",
				"local-distillation-writer": "await storeCandidate(candidate);",
				"redirect-on-hash": "return store.findByContentHash(hash);",
				"keyword-classification": "if (shouldSkipCapture(text)) return;",
			}[rule],
		})),
	)("turns the phase fence red for planted $rule logic", ({ rule, source }) => {
		expect(findPhaseFenceViolations([{ path: "planted.ts", source }])).toContain(
			`${rule}:planted.ts`,
		);
	});

	it("does not treat comments or type-only imports as executable phase logic", () => {
		expect(
			findPhaseFenceViolations([
				{
					path: "comment.ts",
					source:
						"import type { InsightDistiller } from './legacy';\n// do not retrieve(row) or supersede(row)",
				},
			]),
		).toEqual([]);
	});

	it("scans every atomic stage through the storage write door and finds no second worth gate", () => {
		const discoveredAtomicStages = readdirSync(EXTRACTION_DIR)
			.filter((name) => name.startsWith("atomic-") && name.endsWith(".ts"))
			.sort();
		const inventoriedAtomicStages = ATOMIC_FLOW_FILES.filter((path) => path !== WRITE_DOOR)
			.map((path) => basename(path))
			.sort();
		expect(inventoriedAtomicStages).toEqual(discoveredAtomicStages);

		const flow = readAtomicFlow();
		expect(flow.map(({ path }) => path)).toContain(WRITE_DOOR);
		expect(() => assertNoAuthorityViolations(flow)).not.toThrow();

		const gauntlet = flow.find(({ path }) => path.endsWith("atomic-extraction-gauntlet.ts"));
		expect(gauntlet).toBeDefined();
		const dispositionDeclaration = gauntlet?.source.match(
			/export type AtomicExtractionDispositionReason\s*=([\s\S]*?);/u,
		)?.[1];
		expect(dispositionDeclaration).toBeDefined();
		expect(
			[...(dispositionDeclaration ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
		).toEqual(["compound", "subject-unverified", "subject-rejected"]);
	});

	it.each([
		{
			name: "a worth-keeping model call",
			rule: "worth-model-call",
			source: `await llm.completeJson({
				callId: "E13",
				prompt: candidate.claimText,
			});`,
		},
		{
			name: "a score and threshold write decision",
			rule: "score-threshold-write-decision",
			source: "if (candidate.notabilityScore >= WRITE_THRESHOLD) cards.push(candidate);",
		},
		{
			name: "a worth predicate that drops a record",
			rule: "worth-drop-predicate",
			source: "for (const record of records) { if (!passesWorthGate(record)) continue; write(record); }",
		},
	])("turns red for $name", ({ rule, source }) => {
		expect(() => assertNoAuthorityViolations([{ path: "planted.ts", source }])).toThrow(rule);
	});

	it("turns red when a second model judgment reuses an allowed call id", () => {
		const flow = readAtomicFlow();
		flow.push({
			path: "planted-duplicate.ts",
			source: 'client.completeText({ callId: "E1" });',
		});
		expect(() => assertNoAuthorityViolations(flow)).toThrow("model-call-count:E1:2");
	});

	it("turns red when the real flow loses an allowed model call site", () => {
		const flow = readAtomicFlow().map((unit) => ({
			...unit,
			source: unit.source.replace(/callId:\s*["']E5["']/gu, ""),
		}));
		expect(() => assertNoAuthorityViolations(flow)).toThrow("model-call-count:E5:0");
	});
});
