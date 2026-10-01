import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const replayDir = resolve(repoRoot, "packages/memory/fixtures/historical-replay");
const fourArmHarnessPath = resolve(replayDir, "four-arm-harness.mjs");

describe("REM historical replay and four-arm harness", () => {
	it("pins row-state replay without claiming historical ranking and exposes all four arms", () => {
		execFileSync(process.execPath, [resolve(replayDir, "build.mjs")], { cwd: repoRoot });
		const replay = JSON.parse(
			readFileSync(resolve(replayDir, "historical-replay-population.json"), "utf8"),
		) as {
			counts: { totalRows: number; verdictOwnedStaleCurrentRows: number };
			limitations: string[];
			rows: unknown[];
		};
		expect(replay.counts.totalRows).toBe(replay.rows.length);
		expect(replay.counts.verdictOwnedStaleCurrentRows).toBe(53);
		expect(replay.limitations.join(" ")).toMatch(/does not reconstruct historical embedding/i);
		const calibration = JSON.parse(
			readFileSync(resolve(replayDir, "calibration-predeclaration.json"), "utf8"),
		) as {
			status: string;
			blockingInput: { missing: string; cause: string; repairAuthority: string };
		};
		expect(calibration.status).toBe("blocked_without_historical_target_pairs");
		expect(calibration.blockingInput.missing).toMatch(/deterministic candidate ordering/i);
		expect(calibration.blockingInput.cause).toMatch(/row-state labels only/i);
		expect(calibration.blockingInput.repairAuthority).toMatch(/separate corpus charter.*owner/i);

	});

	it("refuses to plan a calibration when the historical corpus is absent", () => {
		const result = runHarness([]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/calibration corpus is required/i);
	});

	it("names missing required corpus fields instead of producing a calibration", () => {
		withCorpusFile({ schemaVersion: 1 }, (corpusPath) => {
			const result = runHarness(["--corpus", corpusPath]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/corpusSnapshotSha256/);
			expect(result.stderr).toMatch(/targetPairs/);
		});
	});

	it("accepts a complete pinned corpus and exposes all four arms without claiming a run", () => {
		withCorpusFile(completeCorpus(), (corpusPath) => {
			const result = runHarness(["--corpus", corpusPath]);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			const plan = JSON.parse(result.stdout) as {
				arms: string[];
				corpusSnapshotSha256: string;
				targetPairCount: number;
				runnable: boolean;
				gateReady: boolean;
			};
			expect(plan.arms).toEqual(["control", "update-only", "replace-only", "combined"]);
			expect(plan.corpusSnapshotSha256).toBe("a".repeat(64));
			expect(plan.targetPairCount).toBe(1);
			expect(plan.runnable).toBe(true);
			expect(plan.gateReady).toBe(false);
		});
	});
});

function runHarness(args: string[]) {
	return spawnSync(process.execPath, [fourArmHarnessPath, "--json", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

function withCorpusFile(value: unknown, assertion: (path: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "rem-calibration-corpus-"));
	const path = join(root, "corpus.json");
	try {
		writeFileSync(path, `${JSON.stringify(value)}\n`);
		assertion(path);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

function completeCorpus(): object {
	return {
		schemaVersion: 1,
		corpusSnapshotSha256: "a".repeat(64),
		embeddingSnapshotSha256: "b".repeat(64),
		rankingConfigSha256: "c".repeat(64),
		targetPairs: [
			{
				relationId: "preference-coffee-roast",
				older: {
					rowId: "018f0f95-8e2b-7f7e-9a83-5d6f5f2db371",
					text: "I prefer light-roast coffee.",
					validTime: "2026-06-01T08:00:00.000Z",
				},
				newer: {
					rowId: "018f0f95-8e2b-7f7e-9a83-5d6f5f2db372",
					text: "I now prefer dark-roast coffee.",
					validTime: "2026-07-01T08:00:00.000Z",
				},
				candidateRank: 1,
				similarityScore: 0.91,
			},
		],
	};
}
