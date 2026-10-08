import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId, EventLane, EventType, JsonObject } from "@snoai/observability";
import { createLogger } from "@snoai/utils/logger";
import { z } from "zod";
import { observeAgentId } from "../../../config/plugin-config-observe-schema";
import type { EmitInput } from "../observability/adapter";
import type { ObserveLogger } from "../observability/best-effort";

export interface ObserveLedgerRow {
	ts_ms: number;
	agent_id?: AgentId;
	event_type: EventType;
	lane: EventLane;
	project_id?: string;
	payload: JsonObject;
}

interface LedgerObserve {
	tryEmit(input: EmitInput): boolean | Promise<boolean>;
	emitError?(kind: string, error: unknown): void | Promise<void>;
	readonly logger?: ObserveLogger | undefined;
}

interface ForwardResult {
	status: "idle" | "forwarded" | "failed";
	forwarded: number;
	offset: number;
}

const log = createLogger("sno-station-mem:observe-ledger");
const rowSchema = z.object({
	ts_ms: z.number().int().nonnegative(),
	agent_id: z.string().transform(observeAgentId).optional(),
	event_type: z.string(),
	lane: z.string(),
	project_id: z.string().min(1).optional(),
	payload: z.record(z.string(), z.json()),
});

export function observeLedgerPath(profileDir: string): string {
	return join(profileDir, "observe", "ledger.jsonl");
}

export function observeLedgerSyncedPath(profileDir: string): string {
	return join(profileDir, "observe", "ledger.synced");
}

export function appendObserveLedgerRows(
	profileDir: string,
	rows: readonly ObserveLedgerRow[],
): void {
	if (rows.length === 0) return;
	const path = observeLedgerPath(profileDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
}

function warn(observe: LedgerObserve, message: string): void {
	if (observe.logger) observe.logger.warn(message);
	else log.warn(message, undefined, {
		event_name: "observe.ledger.failed",
		file: "packages/memory/src/engine/telemetry/observe-ledger.ts",
		function: "forwardObserveLedger",
		site_id: "observe.ledger.failed",
	});
}

async function reportRowFailure(
	observe: LedgerObserve,
	kind: "parse" | "rejected" | "throw",
	row: { start: number; end: number },
	error: unknown,
): Promise<void> {
	const message = `observe.ledger:${kind} bytes ${row.start}-${row.end}: ${String(error)}`;
	warn(observe, message);
	try {
		await observe.emitError?.(`observe.ledger:${kind}`, new Error(message));
	} catch (reportError) {
		warn(observe, `observe.ledger:error bytes ${row.start}-${row.end}: ${String(reportError)}`);
	}
}

function consumeRows(profileDir: string, observe: LedgerObserve, batchSize: number): {
	rows: { start: number; end: number; text: string }[];
	offset: number;
} {
	const syncedPath = observeLedgerSyncedPath(profileDir);
	let offset = existsSync(syncedPath) ? Number(readFileSync(syncedPath, "utf8").trim()) : 0;
	const path = observeLedgerPath(profileDir);
	const rows: { start: number; end: number; text: string }[] = [];
	if (!existsSync(path)) return { rows, offset };
	const ledger = readFileSync(path);
	if (offset > ledger.length) {
		warn(observe, `offset beyond ledger: ${offset} > ${ledger.length}`);
		return { rows, offset };
	}
	while (rows.length < batchSize) {
		const newline = ledger.indexOf(10, offset);
		if (newline === -1) break;
		rows.push({ start: offset, end: newline + 1, text: ledger.toString("utf8", offset, newline) });
		offset = newline + 1;
	}
	if (rows.length) writeFileSync(syncedPath, String(offset), { mode: 0o600 });
	return { rows, offset };
}

export async function forwardObserveLedger(options: {
	profileDir: string;
	observe: LedgerObserve;
	batchSize?: number;
}): Promise<ForwardResult> {
	const { profileDir, observe } = options;
	const batchSize = Math.min(50, Math.max(1, Math.trunc(options.batchSize ?? 50)));
	// Claim complete lines synchronously before any emit can yield to another call.
	const { rows, offset } = consumeRows(profileDir, observe, batchSize);
	let forwarded = 0;
	for (const line of rows) {
		let row: z.infer<typeof rowSchema>;
		try {
			row = rowSchema.parse(JSON.parse(line.text));
		} catch (error) {
			await reportRowFailure(observe, "parse", line, error);
			continue;
		}
		try {
			const accepted = await observe.tryEmit({
				// The SDK validates event membership; unknown names must be reported as rejected.
				eventType: row.event_type as EventType,
				agentId: row.agent_id,
				payload: row.payload,
				tsEdgeMs: row.ts_ms,
				...(row.project_id ? { scope: { project_id: row.project_id } } : {}),
			});
			if (accepted) forwarded++;
			else await reportRowFailure(observe, "rejected", line, "tryEmit returned false");
		} catch (error) {
			await reportRowFailure(observe, "throw", line, error);
		}
	}
	return { status: rows.length === 0 ? "idle" : forwarded ? "forwarded" : "failed",
		forwarded, offset };
}

/** Forwards batch after batch until the ledger is read to its end, so a session that wrote many rows (one session.activity row per turn) leaves no backlog for the next one. A batch that forwards nothing ends the loop. */
export async function forwardObserveLedgerUntilIdle(options: {
	profileDir: string;
	observe: LedgerObserve;
}): Promise<void> {
	for (;;) {
		const result = await forwardObserveLedger(options);
		if (result.status !== "forwarded") return;
	}
}
