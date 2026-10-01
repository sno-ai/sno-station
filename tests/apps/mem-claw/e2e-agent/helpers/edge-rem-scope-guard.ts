import type { JsonObject } from "./types";

export function assertEdgeRemJobScopeMatchesStoredRows(input: {
	jobScope: string;
	rows: readonly JsonObject[];
}): void {
	if (input.rows.length === 0) {
		throw new Error("edge REM scope guard received no stored rows");
	}
	for (const row of input.rows) {
		const storedScope = row["scope"];
		if (typeof storedScope !== "string" || storedScope.length === 0) {
			throw new Error(`edge REM stored row has no scope: ${JSON.stringify(row)}`);
		}
		if (storedScope !== input.jobScope) {
			throw new Error(
				`edge REM scope mismatch: job=${input.jobScope} stored=${storedScope}`,
			);
		}
	}
}
