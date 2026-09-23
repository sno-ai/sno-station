/**
 * QCG-10 (REQ-14): both skill category maps list the fifteen deployed family members under their
 * unit's category, and every entry present before this change keeps its category. The "before"
 * maps are read from the change's recorded baseline commit (f90ab0d16), never from a moving HEAD.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_CATEGORIES } from "../../../../packages/memory/config/skill-categories.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const TS_MAP = "packages/memory/config/skill-categories.ts";
const JSON_MAP = "apps/mem-hermes/sno-mem-hermes/skill_categories.json";

const MEMBERS: Record<string, string> = {
	"adlc-build": "T", "adlc-mid": "T", "adlc-quick": "T", "adlc-route": "T", "adlc-small": "T",
	"prd-creator-mid": "T", "prd-creator-small": "T",
	"tpm-audit": "T", "tpm-dispatch": "T", "tpm-env": "T", "tpm-watch": "T",
	"cts-review": "T", "cts-watch": "T",
	"e2e-environment-preflight": "J", "e2e-red-triage": "J",
};

function committed(path: string): Record<string, string> {
	const text = execFileSync("git", ["show", `f90ab0d1681dae639224b4d6feab1a74f16ac3b7:${path}`], { cwd: repoRoot, encoding: "utf8" });
	return Object.fromEntries([...text.matchAll(/"([^"]+)":\s*"([A-Za-z]+)"/g)].map((m) => [m[1], m[2]]));
}

describe("skill category maps", () => {
	const maps = {
		[TS_MAP]: SKILL_CATEGORIES as Record<string, string>,
		[JSON_MAP]: JSON.parse(readFileSync(join(repoRoot, JSON_MAP), "utf8")) as Record<string, string>,
	};

	for (const [path, map] of Object.entries(maps)) {
		it(`${path} lists every family member under its unit's category`, () => {
			for (const [member, category] of Object.entries(MEMBERS)) expect([member, map[member]]).toEqual([member, category]);
		});

		it(`${path} keeps every entry it had before`, () => {
			const before = committed(path);
			expect(Object.keys(before).length).toBeGreaterThan(20);
			for (const [name, category] of Object.entries(before)) expect([name, map[name]]).toEqual([name, category]);
		});
	}
});
