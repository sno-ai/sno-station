import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { RemDatabaseLike } from "./types.js";

export type RemEntryDecision =
	| { decision: "allow"; reasonCode: null }
	| { decision: "refuse"; reasonCode: string };

export async function recordNonRefusePairDecision(input: {
	database: RemDatabaseLike;
	attemptIdentity: string;
	waveId: string;
	operation: "rem-replace" | "rem-update";
	decision: "allow" | "refuse";
	source: "arbitration" | "coverage";
	reason: string | null;
	throughRefusePair: boolean;
}): Promise<void> {
	if (input.decision === "allow" || input.throughRefusePair) return;
	if (input.reason === null || input.reason.trim().length === 0) {
		throw new Error("A refused pair decision requires a reason");
	}
	const existing = input.database
		.prepare(
			`SELECT job_id, job_type, stage, outcome, reason
			 FROM nodix_rem_journal WHERE attempt_id = ?`,
		)
		.get(input.attemptIdentity) as
		| { job_id: string; job_type: string; stage: string; outcome: string; reason: string | null }
		| undefined;
	if (existing !== undefined) {
		if (
			existing.job_id === input.waveId &&
			existing.job_type === input.operation &&
			existing.stage === input.source &&
			existing.outcome === "refused" &&
			existing.reason === input.reason
		) {
			return;
		}
		throw new Error("attempt_decision_conflict");
	}
	input.database
		.prepare(
			`INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, attempt_id, outcome,
				pairs_scanned, verdicts, actions_applied, reason
			) VALUES (?, ?, ?, ?, 'refused', 0, 0, 0, ?)`,
		)
		.run(input.waveId, input.operation, input.source, input.attemptIdentity, input.reason);
}

export function validateRemSubstantiveWaveEffects(input: {
	database: RemDatabaseLike;
	waveId: string;
}): RemEntryDecision {
	const journalRows = input.database
		.prepare(
			`SELECT count(*) AS count FROM nodix_rem_journal
			 WHERE job_id = ? AND outcome NOT IN ('refused', 'disabled', 'no-action')`,
		)
		.get(input.waveId) as { count: number } | undefined;
	const effects = input.database
		.prepare("SELECT count(*) AS count FROM nodix_rem_write_attempts WHERE job_id = ? AND outcome = 'succeeded'")
		.get(input.waveId) as { count: number } | undefined;
	const groupCloses = input.database
		.prepare(
			`SELECT count(*) AS count
			 FROM nodix_rem_journal AS journal
			 JOIN nodix_memories AS memory
			   ON memory.id = CASE WHEN json_valid(journal.detail)
			      THEN json_extract(journal.detail, '$.targetRowId') END
			 WHERE journal.job_id = ?
			   AND journal.outcome = 'done'
			   AND journal.stage LIKE 'update-retirement-target:%'
			   AND json_extract(memory.metadata, '$.superseded_by') = CASE
			       WHEN json_valid(journal.detail)
			       THEN json_extract(journal.detail, '$.nominatedRowId') END`,
		)
		.get(input.waveId) as { count: number } | undefined;
	if (
		(journalRows?.count ?? 0) > 0 &&
		(effects?.count ?? 0) + (groupCloses?.count ?? 0) === 0
	) {
		return { decision: "refuse", reasonCode: "journal_only" };
	}
	return { decision: "allow", reasonCode: null };
}

export function defineRemSafetyGuard<TInput, TResult>(
	_metadata: { guardId: string },
	guard: (input: TInput) => TResult,
): (input: TInput) => TResult {
	return guard;
}

interface GuardManifestRow {
	guardId: string;
	module: string;
	export: string;
	productionRoots: string[];
	requirementIds: string[];
}

interface RequiredGuardRow {
	requirementId: string;
	protection: string;
	guardId: string;
}

export function validateRemGuardCensus(input: {
	manifestPath: string;
	requiredGuardsPath: string;
	sourceRoots: readonly string[];
	productionRoots: readonly string[];
}): RemEntryDecision {
	const manifest = readJsonArray<GuardManifestRow>(input.manifestPath);
	const required = readJsonArray<RequiredGuardRow>(input.requiredGuardsPath);
	const sourceFiles = input.sourceRoots.flatMap(listTypeScriptFiles);
	const sources = new Map(sourceFiles.map((file) => [path.resolve(file), readFileSync(file, "utf8")]));
	const discovered = new Set<string>();
	for (const source of sources.values()) {
		for (const match of source.matchAll(/defineRemSafetyGuard\s*\(\s*\{\s*guardId:\s*["']([^"']+)["']/gu)) {
			const guardId = match[1];
			if (guardId !== undefined) discovered.add(guardId);
		}
	}
	const manifestIds = new Set(manifest.map((row) => row.guardId));
	if (manifestIds.size === 0 && discovered.size === 0) {
		return { decision: "refuse", reasonCode: "guard_inventory_empty" };
	}
	if (!sameSet(manifestIds, discovered)) {
		const hasUnmarkedGuard = [...sources.values()].some((source) =>
			/(?:function\s+\w+\s*\([^)]*\)\s*:\s*RemRefusalCode|throw\s+new\s+\w*RemGateError)/u.test(source),
		);
		return { decision: "refuse", reasonCode: hasUnmarkedGuard ? "unmarked_guard" : "manifest_source_inequality" };
	}
	if (
		required.length === 0 ||
		manifest.some((row) => !required.some((item) => item.guardId === row.guardId)) ||
		required.some((item) => !manifestIds.has(item.guardId))
	) {
		return { decision: "refuse", reasonCode: "required_protection_missing" };
	}
	const reachable = collectReachableFiles(input.productionRoots, sources);
	for (const row of manifest) {
		const moduleFile = [...sources.keys()].find((file) => file.endsWith(row.module));
		if (moduleFile === undefined || !reachable.has(moduleFile)) {
			return { decision: "refuse", reasonCode: "guard_unreachable" };
		}
	}
	return { decision: "allow", reasonCode: null };
}

function readJsonArray<T>(file: string): T[] {
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(value)) throw new Error(`${file} must contain a JSON array`);
	return value as T[];
}

function listTypeScriptFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
		return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
	});
}

function collectReachableFiles(
	roots: readonly string[],
	sources: ReadonlyMap<string, string>,
): Set<string> {
	const reachable = new Set<string>();
	const pending = roots.map((root) => path.resolve(root));
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || reachable.has(file)) continue;
		const source = sources.get(file);
		if (source === undefined) continue;
		reachable.add(file);
		for (const match of source.matchAll(/(?:from\s+|import\s*\()["'](\.[^"']+)["']/gu)) {
			const specifier = match[1];
			if (specifier === undefined) continue;
			for (const candidate of resolveSourceCandidates(file, specifier)) {
				if (sources.has(candidate)) pending.push(candidate);
			}
		}
	}
	return reachable;
}

function resolveSourceCandidates(importer: string, specifier: string): string[] {
	const base = path.resolve(path.dirname(importer), specifier);
	return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].map((file) => path.resolve(file));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}
