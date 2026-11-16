import { z } from "zod";
import { formatPrecisionDoctor } from "../../config/precision-doctor";
import type { PrecisionInspection, PrecisionNight } from "../contract/results";
import type { MemoryStore } from "../store/store";

const detailSchema = z.object({
	scope: z.enum(["project", "shared"]), projectId: z.string().optional(),
	rows: z.array(z.string()), error: z.string().nullable().optional(), sameVendor: z.boolean().optional(),
});
type JournalRow = { jobId: string; stage: string; outcome: string; reason: string | null; detail: string | null };

export function inspectPrecision(store: MemoryStore, projectId: string,
	notFit: PrecisionInspection["notFit"]): PrecisionInspection {
	const journal = store.sqlite.prepare(`SELECT job_id AS jobId, stage, outcome, reason, detail
		FROM nodix_rem_journal WHERE job_type = 'precision-nightly' ORDER BY sequence DESC`).all() as JournalRow[];
	const relevant = journal.flatMap(row => {
		const parsed = detailSchema.safeParse(row.detail === null ? null : JSON.parse(row.detail));
		if (!parsed.success) return [];
		const detail = parsed.data;
		if (detail.scope === "project" && (detail.projectId !== undefined ? detail.projectId !== projectId
			: !detail.rows.some(id => store.getById(id)?.projectId === projectId))) return [];
		return [{ ...row, detail }];
	});
	const jobs = [...new Set(relevant.map(row => row.jobId))].slice(0, 3);
	const nights: PrecisionNight[] = [];
	for (const jobId of jobs) for (const scope of ["project", "shared"] as const) {
		const night: PrecisionNight = { jobId, scope, checked: 0, replaced: 0, merged: 0, corrected: 0, removed: 0, undecided: 0, failures: [] };
		const checked = new Set<string>();
		for (const row of relevant.filter(row => row.jobId === jobId && row.detail.scope === scope)) {
			if (row.outcome === "failed") {
				night.failures.push({ stage: row.stage, error: row.detail.error ?? row.reason ?? "unknown error", rows: row.detail.rows });
				continue;
			}
			for (const id of row.detail.rows) checked.add(id);
			if (row.outcome === "replaced" || row.outcome === "merged" || row.outcome === "corrected"
				|| row.outcome === "removed" || row.outcome === "undecided") night[row.outcome] += 1;
		}
		night.checked = checked.size;
		nights.push(night);
	}
	const project = projectId === "global" ? [] : store.readActivePrecisionRows(projectId);
	const shared = store.readActivePrecisionRows("global");
	const pending = (rows: typeof project): string[] => rows.filter(row => JSON.parse(row.metadata).precision_check === "pending").map(row => row.id);
	const contradictions = [...project, ...shared].flatMap(row => store.getLoadedFileJudgments(row.id)
		.filter(answer => answer.verdict === "opposite" && answer.memoryContentHash === row.contentHash)
		.map(answer => ({ id: row.id, filePath: answer.filePath })));
	const data = { nights, pending: { project: pending(project), shared: pending(shared) }, notFit, contradictions,
		sameVendor: relevant.some(row => jobs.includes(row.jobId) && row.detail.sameVendor === true) };
	return { op: "precision", ...data, lines: formatPrecisionDoctor(data) };
}

export function lastNightFailure(data: PrecisionInspection): string | undefined {
	const latest = data.nights[0]?.jobId;
	const failures = data.nights.filter(night => night.jobId === latest).flatMap(night => night.failures);
	return failures.length ? `Memory check failed last night: ${[...new Set(failures.map(failure => failure.stage))].join(", ")}; run memory doctor for details.` : undefined;
}
