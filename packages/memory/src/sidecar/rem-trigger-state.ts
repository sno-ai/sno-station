/** @file rem-trigger-state.ts
 * @purpose Persists the automatic REM scheduler's strict per-scope state.
 * @boundary One atomically replaced JSON file under the sno-station-mem state directory.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface RemTriggerScopeState {
	last_pass_at: string;
	schedule_zone: string;
	last_covered_count: number;
	last_volume_pass_date: string | null;
	missed_window: { due_at: string; trigger: "daily" | "volume"; recorded_at: string } | null;
	attempts: { identity: string | null; count: number };
}

export interface RemTriggerStateDocument {
	version: 1;
	scopes: Record<string, RemTriggerScopeState>;
}

const remTriggerScopeStateSchema: z.ZodType<RemTriggerScopeState> = z
	.object({
		last_pass_at: z.string().datetime(),
		schedule_zone: z.string().min(1).refine(isValidScheduleZone, "invalid IANA time zone"),
		last_covered_count: z.number().int().nonnegative(),
		last_volume_pass_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
		// Earlier version 1 files have five fields; only the added field may be absent.
		missed_window: z.object({ due_at: z.string().datetime(), trigger: z.enum(["daily", "volume"]), recorded_at: z.string().datetime() }).strict().nullable().default(null),
		attempts: z
			.object({
				identity: z.string().min(1).nullable(),
				count: z.number().int().min(0).max(3),
			})
			.strict(),
	})
	.strict();

const remTriggerStateDocumentSchema: z.ZodType<RemTriggerStateDocument> = z
	.object({
		version: z.literal(1),
		scopes: z.record(z.string().min(1), remTriggerScopeStateSchema),
	})
	.strict();

export class RemTriggerStateError extends Error {
	constructor(
		readonly statePath: string,
		cause: unknown,
	) {
		super(`REM trigger state at ${statePath} is invalid or unreadable: ${errorMessage(cause)}`, {
			cause: cause instanceof Error ? cause : undefined,
		});
		this.name = "RemTriggerStateError";
	}
}

export function remTriggerStatePath(stateDir: string): string {
	return path.join(stateDir, "rem-trigger-state.json");
}

export async function loadRemTriggerState(stateDir: string): Promise<RemTriggerStateDocument> {
	const statePath = remTriggerStatePath(stateDir);
	let raw: string;
	try {
		raw = await readFile(statePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { version: 1, scopes: {} };
		throw new RemTriggerStateError(statePath, error);
	}
	try {
		return remTriggerStateDocumentSchema.parse(JSON.parse(raw) as unknown);
	} catch (error) {
		throw new RemTriggerStateError(statePath, error);
	}
}

export function ensureRemTriggerScope(
	state: RemTriggerStateDocument,
	input: {
		scope: string;
		now: Date;
		candidateCount: number;
		resolveScheduleZone?: () => string;
	},
): {
	state: RemTriggerStateDocument;
	scopeState: RemTriggerScopeState;
	initialized: boolean;
} {
	const existing = state.scopes[input.scope];
	if (existing !== undefined) return { state, scopeState: existing, initialized: false };
	if (input.scope.trim().length === 0) throw new Error("REM trigger scope is required");
	if (!Number.isInteger(input.candidateCount) || input.candidateCount < 0) {
		throw new Error("REM trigger candidate count must be a nonnegative integer");
	}
	if (Number.isNaN(input.now.getTime())) throw new Error("REM trigger initialization time is invalid");
	const scheduleZone = (input.resolveScheduleZone ?? resolveHostScheduleZone)();
	if (!isValidScheduleZone(scheduleZone)) throw new Error(`invalid REM schedule zone: ${scheduleZone}`);
	const scopeState: RemTriggerScopeState = {
		last_pass_at: input.now.toISOString(),
		schedule_zone: scheduleZone,
		last_covered_count: input.candidateCount,
		last_volume_pass_date: null,
		missed_window: null,
		attempts: { identity: null, count: 0 },
	};
	return {
		state: {
			version: 1,
			scopes: { ...state.scopes, [input.scope]: scopeState },
		},
		scopeState,
		initialized: true,
	};
}

export async function writeRemTriggerStateAtomic(
	stateDir: string,
	state: RemTriggerStateDocument,
): Promise<void> {
	const validated = remTriggerStateDocumentSchema.parse(state);
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const statePath = remTriggerStatePath(stateDir);
	const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(validated), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, statePath);
		await syncDirectory(stateDir);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

function resolveHostScheduleZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isValidScheduleZone(value: string): boolean {
	if (value.trim().length === 0) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
