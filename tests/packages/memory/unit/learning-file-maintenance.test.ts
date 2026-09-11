import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	appendSelfImprovementEntry,
	DEFAULT_ERRORS_TEMPLATE,
	DEFAULT_FEATURE_REQUESTS_TEMPLATE,
	DEFAULT_LEARNINGS_TEMPLATE,
	ensureSelfImprovementLearningFiles,
} from "../../../../packages/sno-station-mem/src/engine/operations/learning-file-maintenance";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mem-claw-learning-"));
	tempDirs.push(dir);
	return dir;
}

async function readText(path: string): Promise<string> {
	return readFile(path, "utf-8");
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("self-improvement learning file maintenance", () => {
	it("creates missing learning files from templates without overwriting existing content", async () => {
		const baseDir = await makeTempWorkspace();
		const learningsDir = join(baseDir, ".learnings");

		await ensureSelfImprovementLearningFiles(baseDir);

		expect(await readText(join(learningsDir, "LEARNINGS.md"))).toBe(
			`${DEFAULT_LEARNINGS_TEMPLATE}\n`,
		);
		expect(await readText(join(learningsDir, "ERRORS.md"))).toBe(
			`${DEFAULT_ERRORS_TEMPLATE}\n`,
		);
		expect(await readText(join(learningsDir, "FEATURE_REQUESTS.md"))).toBe(
			`${DEFAULT_FEATURE_REQUESTS_TEMPLATE}\n`,
		);

		await writeFile(
			join(learningsDir, "LEARNINGS.md"),
			"# Existing\n\nKeep me\n",
			"utf-8",
		);
		await ensureSelfImprovementLearningFiles(baseDir);
		expect(await readText(join(learningsDir, "LEARNINGS.md"))).toBe(
			"# Existing\n\nKeep me\n",
		);
	});

	it("appends learning entries with stable id shape, target file, defaults, and metadata", async () => {
		const baseDir = await makeTempWorkspace();
		const result = await appendSelfImprovementEntry({
			baseDir,
			type: "learning",
			summary: "Use the workspace vitest config for plugin tests.",
			details: "The root vitest invocation does not resolve the plugin alias.",
			suggestedAction: "Run through npm workspace exec.",
			category: "best_practice",
			area: "testing",
			priority: "high",
			status: "accepted",
			source: "cleanroom/prompt3",
		});

		expect(result.id).toMatch(/^LRN-\d{8}-001$/);
		expect(result.filePath).toBe(join(baseDir, ".learnings", "LEARNINGS.md"));

		const content = await readText(result.filePath);
		expect(content).toContain(`## [${result.id}] best_practice`);
		expect(content).toContain("**Priority**: high");
		expect(content).toContain("**Status**: accepted");
		expect(content).toContain("**Area**: testing");
		expect(content).toContain(
			"Use the workspace vitest config for plugin tests.",
		);
		expect(content).toContain("- Source: cleanroom/prompt3");
	});

	it("routes error and feature entries to their locked files and prefixes", async () => {
		const baseDir = await makeTempWorkspace();
		const error = await appendSelfImprovementEntry({
			baseDir,
			type: "error",
			summary: "An external adapter typecheck error is outside this refactor.",
		});
		const feature = await appendSelfImprovementEntry({
			baseDir,
			type: "feature",
			summary: "Track cleanroom checkpoints automatically.",
		});

		expect(error.id).toMatch(/^ERR-\d{8}-001$/);
		expect(error.filePath).toBe(join(baseDir, ".learnings", "ERRORS.md"));
		expect(feature.id).toMatch(/^FEAT-\d{8}-001$/);
		expect(feature.filePath).toBe(
			join(baseDir, ".learnings", "FEATURE_REQUESTS.md"),
		);
	});

	it("serializes concurrent appends so ids remain unique and sequential per file", async () => {
		const baseDir = await makeTempWorkspace();
		const summaries = Array.from(
			{ length: 5 },
			(_, index) => `Concurrent entry ${index + 1}`,
		);

		const results = await Promise.all(
			summaries.map((summary) =>
				appendSelfImprovementEntry({
					baseDir,
					type: "learning",
					summary,
				}),
			),
		);

		const ids = results.map((result) => result.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.map((id) => id.slice(-3)).sort()).toEqual([
			"001",
			"002",
			"003",
			"004",
			"005",
		]);

		const content = await readText(join(baseDir, ".learnings", "LEARNINGS.md"));
		for (const summary of summaries) {
			expect(content).toContain(summary);
		}
	});
});
