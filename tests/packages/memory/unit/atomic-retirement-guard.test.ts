/** @file atomic-retirement-guard.test.ts
 * @purpose Prevents retired extraction lanes, gates, merge prompts, noise drops, and summary I/O.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_ROOT = join(REPO_ROOT, "apps/mem-claw/src");
const FORBIDDEN_FILES = [
	"apps/mem-claw/src/extraction/memory-noise-classifier.ts",
	"apps/mem-claw/src/extraction/semantic-noise-prototype-bank.ts",
] as const;

interface SourceUnit {
	path: string;
	source: string;
}

function listTypeScriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

function readProductSource(): SourceUnit[] {
	return listTypeScriptFiles(SOURCE_ROOT).map((path) => ({
		path: relative(REPO_ROOT, path),
		source: readFileSync(path, "utf8"),
	}));
}

function retirementViolations(units: readonly SourceUnit[]): string[] {
	const violations: string[] = [];
	for (const unit of units) {
		const isEnhancementBoundary =
			unit.path === "apps/mem-claw/src/extraction/atomic-profile-keying.ts" ||
			unit.path === "apps/mem-claw/src/extraction/atomic-memory-extraction.ts";
		if (
			isEnhancementBoundary &&
			/\b(?:AtomicEnhancementCap|validateAtomicEnhancementCap|ratificationReceiptPath|expectedCostCurveSha256|enhance-skipped:over-cap)\b|\bcap\s*:/u.test(
				unit.source,
			)
		) {
			violations.push(`enhancement-cap:${unit.path}`);
		}
		for (const [lineIndex, line] of unit.source.split("\n").entries()) {
			const location = `${unit.path}:${lineIndex + 1}`;
			if (/callLabel\s*:\s*["']memory-extract-profile-gate["']/u.test(line)) {
				violations.push(`profile-gate:${location}`);
			}
			if (/\bbuildMergePrompt\s*\(/u.test(line)) {
				violations.push(`merge-prompt:${location}`);
			}
			if (/\b(?:extractEpisodicLane|extractProfileLane)\b/u.test(line)) {
				violations.push(`parallel-lane:${location}`);
			}
			if (
				/\b(?:shouldSkipCapture|decideCapture)\s*\(/u.test(line) &&
				!/export\s+function\s+(?:shouldSkipCapture|decideCapture)/u.test(line)
			) {
				violations.push(`keyword-write-decision:${location}`);
			}
			if (/\b(?:category|memory_category)\s*:\s*["']summary["']/u.test(line)) {
				violations.push(`summary-writer:${location}`);
			}
		}

		const isReadSurface =
			unit.path.includes("/retrieval/") ||
			/(?:read|search|lookup|fact-surface)-api\.ts$/u.test(unit.path);
		if (
			isReadSurface &&
			/(?:category|memory_category)\s*(?:=|==|===|IN|in)\s*\(?\s*["']summary["']/u.test(
				unit.source,
			)
		) {
			violations.push(`summary-reader:${unit.path}`);
		}
	}
	return violations;
}

describe("atomic extraction retirement repository guard", () => {
	it("removes the old gates, parallel lanes, merge path, keyword drop, and summary I/O", () => {
		for (const path of FORBIDDEN_FILES) {
			expect(existsSync(join(REPO_ROOT, path)), `retired file still exists: ${path}`).toBe(false);
		}

		const units = readProductSource();
		const violations = retirementViolations(units);
		expect(violations, violations.join("\n")).toEqual([]);

		const ambient = units.find(
			({ path }) => path === "apps/mem-claw/src/plugin/openclaw-ambient-learning-hook.ts",
		)?.source;
		expect(ambient).toBeDefined();
		expect(ambient).toContain("AtomicInsightDistiller");
		expect(ambient).not.toMatch(/\bextractEpisodicLane\b|\bextractProfileLane\b/u);
	});

	it.each([
		{
			name: "profile classification gate",
			rule: "profile-gate",
			source: 'callLabel: "memory-extract-profile-gate",',
		},
		{
			name: "merge prompt",
			rule: "merge-prompt",
			source: "export function buildMergePrompt(input: string) { return input; }",
		},
		{
			name: "parallel extraction lane",
			rule: "parallel-lane",
			source: "await this.extractProfileLane(turns);",
		},
		{
			name: "keyword write decision",
			rule: "keyword-write-decision",
			source: "if (shouldSkipCapture(record.text)) continue;",
		},
		{
			name: "summary writer",
			rule: "summary-writer",
			source: 'store({ category: "summary", text });',
		},
		{
			name: "profileKeying cap input",
			rule: "enhancement-cap",
			path: "apps/mem-claw/src/extraction/atomic-profile-keying.ts",
			source: "runAtomicProfileKeying({ cap: validatedCap });",
		},
	])("turns red for a planted $name", ({ rule, source, path = "planted.ts" }) => {
		expect(retirementViolations([{ path, source }]).some((value) => value.includes(rule))).toBe(
			true,
		);
	});
});
