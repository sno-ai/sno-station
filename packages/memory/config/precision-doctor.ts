import type { PrecisionInspection } from "../src/contract/results";

/** One service-rendered report, passed through unchanged by each coding skin. */
export function formatPrecisionDoctor(data: Omit<PrecisionInspection, "op" | "lines">): string[] {
	const lines = data.nights.flatMap(night => [
		`${night.scope} ${night.jobId}: checked ${night.checked}, replaced ${night.replaced}, merged ${night.merged}, corrected ${night.corrected}, removed ${night.removed}, undecided ${night.undecided}`,
		...night.failures.map(failure => `${night.scope} ${night.jobId}: failed ${failure.stage}: ${failure.error}; rows ${failure.rows.join(", ")}`),
	]);
	for (const scope of ["project", "shared"] as const) {
		lines.push(`${scope}: pending ${data.pending[scope].length}${data.pending[scope].length ? ` (${data.pending[scope].join(", ")})` : ""}; did not fit at session start ${data.notFit[scope]}`);
	}
	for (const row of data.contradictions) lines.push(`${row.id}: contradicted by ${row.filePath}`);
	if (data.sameVendor) lines.push("checked by the same vendor");
	return lines;
}
