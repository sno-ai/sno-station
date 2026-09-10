/** @file daily-spend-estimator.ts
 * @purpose Tracks extraction and LLM usage costs for capture and reflection flows.
 * @boundary LLM client accounting, extractor usage, and runtime diagnostics.
 * @see llm-client.ts, memory-extraction-pipeline.ts, daily-log-generator.ts.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { COST_ESTIMATE_CACHE_TTL_MS } from "../../../config/index";
import { getCostPath } from "./runtime-audit-log";
import { createLogger } from "@snoai/utils/logger";
const diagnosticLog = createLogger("sno-station-mem:daily-spend-estimator");

type SpendCacheEntry = {
	day: string;
	size: number;
	mtimeMs: number;
	expiresAt: number;
	total: number;
};
const spendCache = new Map<string, SpendCacheEntry>();

/**
 * Reads estimated spend today and applies daily spend accounting fallback behavior for missing
 * data.
 */
// LH: Cost tracking reads pricing data for visibility only; it must not enforce budgets or block extraction.
// LH: The pricing file is local JSON so operators can inspect and update estimates without changing TypeScript code.
// LH: Daily spend output supports operational tuning for modes where multiple model calls can happen per turn.
export async function readEstimatedSpendToday(stateDir: string): Promise<number> {
	const filePath = getCostPath(stateDir);
	let fileStat: { mtimeMs: number; size: number };
	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	try {
		fileStat = await stat(filePath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			diagnosticLog.warn("Recorded spend file unavailable", { error, outcome: "partial" },
				{ event_name: "memory.spend.read.failed", file: "packages/sno-station-mem/src/engine/operations/daily-spend-estimator.ts", function: "readEstimatedSpendToday", site_id: "memory.spend.stat.failed" });
		}
		// Missing cost file means no spend has been recorded yet.
		return 0;
	}

	const today = new Date().toISOString().slice(0, 10);
	const now = Date.now();
	const cached = spendCache.get(filePath);
	// Guard this branch early so the remaining operational safety path works with normalized inputs.
	if (
		cached &&
		cached.day === today &&
		cached.size === fileStat.size &&
		cached.mtimeMs === fileStat.mtimeMs &&
		cached.expiresAt > now
	) {
		return cached.total;
	}

	let total = 0;
	let malformedCount = 0;
	let startOffset = 0;
	// Guard this branch early so the remaining operational safety path works with normalized inputs.
	if (
		cached &&
		cached.day === today &&
		fileStat.size >= cached.size &&
		fileStat.mtimeMs >= cached.mtimeMs
	) {
		total = cached.total;
		startOffset = cached.size;
	}

	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	try {
		const stream = createReadStream(filePath, {
			encoding: "utf-8",
			...(startOffset > 0 ? { start: startOffset } : {}),
		});
		const lines = createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		// Await the module behavior dependency before deriving downstream state.
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
				const parsed = JSON.parse(line) as {
					timestamp?: string;
					estimatedCostUsd?: number;
				};
				if (!parsed.timestamp?.startsWith(today)) continue;
				if (typeof parsed.estimatedCostUsd === "number") {
					total += parsed.estimatedCostUsd;
				}
			} catch {
				malformedCount += 1;
				// Skip malformed JSONL lines.
			}
		}
	} catch (error) {
		diagnosticLog.warn("Recorded spend read failed", { error, outcome: "partial" },
			{ event_name: "memory.spend.read.failed", file: "packages/sno-station-mem/src/engine/operations/daily-spend-estimator.ts", function: "readEstimatedSpendToday", site_id: "memory.spend.stream.failed" });
		// Stream read failed (file removed mid-read, permission error) — treat as zero spend
		return 0;
	}

	if (malformedCount > 0) diagnosticLog.warn("Recorded spend contains invalid rows", { malformed_count: malformedCount, outcome: "partial" },
		{ event_name: "memory.spend.rows.invalid", file: "packages/sno-station-mem/src/engine/operations/daily-spend-estimator.ts", function: "readEstimatedSpendToday", site_id: "memory.spend.rows.invalid" });
	spendCache.set(filePath, {
		day: today,
		size: fileStat.size,
		mtimeMs: fileStat.mtimeMs,
		expiresAt: now + COST_ESTIMATE_CACHE_TTL_MS,
		total,
	});
	return total;
}
