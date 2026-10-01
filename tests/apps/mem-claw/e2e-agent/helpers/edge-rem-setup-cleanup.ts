import type { JsonObject } from "./types";

export type EdgeRemSetupCleanup = {
	deletedIds: string[];
	errors: string[];
	remaining: JsonObject[];
};

export function assertEdgeRemSetupCleanup(
	setupRowIds: readonly string[],
	cleanup: EdgeRemSetupCleanup,
): void {
	if (cleanup.errors.length > 0) {
		throw new Error(`Edge REM cleanup errors: ${cleanup.errors.join("; ")}`);
	}
	if (cleanup.remaining.length > 0) {
		throw new Error(
			`Edge REM cleanup left rows: ${cleanup.remaining.map((row) => String(row.id)).join(", ")}`,
		);
	}
	const setup = new Set(setupRowIds);
	const deleted = new Set(cleanup.deletedIds);
	for (const id of setup) {
		if (!deleted.has(id)) throw new Error(`Edge REM cleanup is missing ${id}`);
	}
	for (const id of deleted) {
		if (!setup.has(id)) throw new Error(`Edge REM cleanup deleted unexpected ${id}`);
	}
}
