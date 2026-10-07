// Generated from sno-station-skills-core/registry.yaml at 52c902964b0173406f9328b9322b1a79df43dbcd; entries for skills outside that registry are kept as they were.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SKILL_CATEGORIES: Record<string, "J" | "M" | "S" | "H" | "T" | "R" | "other"> = {
	"peer-review": "J",
	"agentic-walkthrough": "J",
	"owner-intent-audit": "J",
	"pr-review": "J",
	"first-principles-review": "J",
	"e2e": "J",
	"e2e-environment-preflight": "M",
	"e2e-red-triage": "J",
	"heartbeat": "S",
	"subscription-quota-check": "S",
	"reach": "S",
	"handoff": "S",
	"join-talk": "S",
	"rotate-agent": "S",
	"prd-board": "H",
	"insights-codex": "H",
	"analysis": "R",
	"tpm": "T",
	"tpm-audit": "T",
	"tpm-dispatch": "T",
	"tpm-env": "T",
	"tpm-watch": "T",
	"tpm-task-evidence": "J",
	"tpm-analyze": "R",
	"cts": "T",
	"cts-review": "T",
	"cts-watch": "T",
	"cts-evolve": "R",
	"agentic-time-estimate": "H",
	"codex-coder": "M",
	"python-coder": "M",
	"ts-coder": "M",
	"shellscript-coder": "M",
	"test-writer": "J",
	"prd-creator": "T",
	"prd-creator-mid": "T",
	"prd-creator-small": "T",
	"prd-discover": "M",
	"adlc": "T",
	"adlc-build": "T",
	"adlc-mid": "T",
	"adlc-quick": "T",
	"adlc-route": "T",
	"adlc-small": "T",
	"prd-graph": "H",
	"prdm": "H",
	"rem-reflect": "R",
	"bro": "T",
	"managed-worktree": "T",
	"lh-english-writer": "T",
	"less-is-more": "J",
	"medic": "M",
	"sno-cli": "M",
	"pl": "T",
	"pl-analyze": "R",
	"pl-audit": "T",
	"pl-dispatch": "T",
	"pl-env": "T",
	"pl-watch": "T",
	"cos": "T",
	"cos-evolve": "R",
	"cos-review": "T",
	"cos-watch": "T",
	"away-brief": "H",
	"catch-report": "H",
	"charter": "T",
	"deliver": "T",
};

const publishedSchema = z.object({ source: z.object({ commit: z.string().min(1) }) });

export function skillVersionFor(skillDir: string): string {
	try {
		const text = readFileSync(join(skillDir, "PUBLISHED.json"), "utf8");
		const published = publishedSchema.parse(JSON.parse(text));
		return published.source.commit.slice(0, 12);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "local";
		throw error;
	}
}
