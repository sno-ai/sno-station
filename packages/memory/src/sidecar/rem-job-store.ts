import { readJsonlLines } from "../engine/operations/jsonl-lines";
import { createLogger } from "@snoai/utils/logger";
/** @file rem-job-store.ts
 * @purpose Persists append-only REM job state transitions.
 * @boundary Durable local JSONL journal used by the standalone REM sidecar.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const log = createLogger("sno-station-mem:rem-jobs");

export type RemJobState = "queued" | "running" | "done" | "failed";

interface RemJobMeasurements {
	rows_considered: number;
	pairs_built?: number;
	pair_cap_binding?: boolean;
	model_calls: number;
	model_tokens: number;
	wall_ms: number;
}

export interface RemJobStats {
	operations: number;
	applied_count?: number;
	actionable_candidate_count?: number;
	applied_fraction?: number | null;
	scan?: {
		scope: string;
		candidate_count: number;
		stamped_skipped_count?: number;
		actionable_candidate_count?: number;
	};
	parse_failure_count?: number;
	top_refusal_reasons?: string[];
	// What the wave actually consumed. `model_calls` is the one number that separates a wave which
	// judged everything and changed nothing — a legitimate outcome — from a wave whose engine never
	// ran at all. Both write `applied_count: 0`, and for four months only the second was happening.
	measured?: RemJobMeasurements;
	by_operation?: Array<{
		operation: string;
		applied_count: number;
		actionable_candidate_count: number;
		candidate_count: number;
		parse_failure_count: number;
		top_refusal_reasons: string[];
		measured: RemJobMeasurements;
	}>;
}

export interface RemJob {
	job_id: string;
	state: RemJobState;
	type: string;
	scope: string;
	started_at: string | null;
	finished_at: string | null;
	stats: RemJobStats;
	error?: string;
	correlation_id: string;
	requested_operations: string[];
}

interface RemWaveJob {
	payloadVersion: 1;
	waveId: string;
	correlationId: string;
	scope: string;
	requestedOperations: string[];
	state: RemJobState;
	startedAt: string | null;
	finishedAt: string | null;
	stats: RemJobStats;
	error?: string;
}

const remJobStateSchema: z.ZodType<RemJobState> = z.enum([
	"queued",
	"running",
	"done",
	"failed",
]);
const remJobMeasurementsSchema: z.ZodType<RemJobMeasurements> = z
	.object({
		rows_considered: z.number().int().nonnegative(),
		pairs_built: z.number().int().nonnegative().optional(),
		pair_cap_binding: z.boolean().optional(),
		model_calls: z.number().int().nonnegative(),
		model_tokens: z.number().int().nonnegative(),
		wall_ms: z.number().int().nonnegative(),
	})
	.strict();
const remJobStatsSchema: z.ZodType<RemJobStats> = z
	.object({
		operations: z.number().int().nonnegative(),
		applied_count: z.number().int().nonnegative().optional(),
		actionable_candidate_count: z.number().int().nonnegative().optional(),
		applied_fraction: z.number().min(0).max(1).nullable().optional(),
		scan: z
			.object({
				scope: z.string().min(1),
				candidate_count: z.number().int().nonnegative(),
				stamped_skipped_count: z.number().int().nonnegative().optional(),
				actionable_candidate_count: z.number().int().nonnegative().optional(),
			})
			.strict()
			.optional(),
		parse_failure_count: z.number().int().nonnegative().optional(),
		top_refusal_reasons: z.array(z.string().min(1)).max(2).optional(),
		// The declared type above is not what decides: this schema is `.strict()`, and without this
		// block every completed wave threw `Unrecognized key: "measured"` before its line reached the
		// journal — so the measurements were unreadable and the runner's liveness check could only
		// ever report that it could not find them. Proved by reverting this block: the round-trip
		// test goes red with that exact ZodError.
		measured: remJobMeasurementsSchema.optional(),
		by_operation: z
			.array(
				z
					.object({
						operation: z.string().min(1),
						applied_count: z.number().int().nonnegative(),
						actionable_candidate_count: z.number().int().nonnegative(),
						candidate_count: z.number().int().nonnegative(),
						parse_failure_count: z.number().int().nonnegative(),
						top_refusal_reasons: z.array(z.string().min(1)).max(2),
						measured: remJobMeasurementsSchema,
					})
					.strict(),
			)
			.min(1)
			.optional(),
	})
	.strict();

export function parseRemJobStats(value: unknown): RemJobStats | undefined {
	const parsed = remJobStatsSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

const remWaveJobSchema: z.ZodType<RemWaveJob> = z
	.object({
		payloadVersion: z.literal(1),
		waveId: z.string().min(1),
		correlationId: z.string().min(1),
		scope: z.string().min(1),
		requestedOperations: z.array(z.string().min(1)).min(1),
		state: remJobStateSchema,
		startedAt: z.string().datetime().nullable(),
		finishedAt: z.string().datetime().nullable(),
		stats: remJobStatsSchema,
		error: z.string().min(1).optional(),
	})
	.strict();

const legacyJobSchema = z
	.object({
		job_id: z.string().min(1),
		state: remJobStateSchema,
		type: z.string().min(1),
		scope: z.string().min(1),
		started_at: z.string().datetime().nullable(),
		finished_at: z.string().datetime().nullable(),
		stats: remJobStatsSchema,
		error: z.string().min(1).optional(),
		correlation_id: z.string().min(1),
	})
	.strict();

const OPERATION_ORDER = ["rem-replace", "rem-update", "rem-distill", "rem-retire"] as const;

export type RemJobTransition = {
	state: Exclude<RemJobState, "queued">;
	started_at?: string;
	finished_at?: string;
	stats?: RemJobStats;
	error?: string;
};

export class RemJobStore {
	private readonly jobs = new Map<string, RemWaveJob>();
	private readonly persistedJobs = new Set<string>();
	private readonly mergeKeys = new Map<string, string>();
	private operationQueue: Promise<void> = Promise.resolve();

	private constructor(
		private readonly journalPath: string,
		private readonly onDurableTransition: (job: RemJob) => void,
	) {}

	static async open(
		journalPath: string,
		onDurableTransition: (job: RemJob) => void = () => undefined,
	): Promise<RemJobStore> {
		const store = new RemJobStore(journalPath, onDurableTransition);
		await store.migrateLegacyJournal().catch(error => store.reportFailure(error));
		await store.load();
		return store;
	}

	isPersisted(jobId: string): boolean { return this.persistedJobs.has(jobId); }

	get(jobId: string): RemJob | undefined {
		const job = this.jobs.get(jobId);
		return job === undefined ? undefined : toRemJob(job);
	}

	nonTerminalJobs(): RemJob[] {
		return Array.from(this.jobs.values()).filter(
			(job) => job.state === "queued" || job.state === "running",
		).map(toRemJob);
	}

	async createQueued(
		type: string | readonly string[],
		scope: string,
		correlationId: string,
	): Promise<{ created: boolean; job: RemJob }> {
		return this.enqueue(async () => {
			const requestedOperations = canonicalOperations(
				typeof type === "string" ? [type] : type,
			);
			if (requestedOperations.length === 0) {
				throw new Error("REM wave requires at least one supported operation");
			}
			const mergeKey = `${correlationId}\0${scope}`;
			const existingId = this.mergeKeys.get(mergeKey);
			const existing = existingId === undefined ? undefined : this.jobs.get(existingId);
			if (existing !== undefined && existing.state === "queued") {
				const mergedOperations = canonicalOperations([
					...existing.requestedOperations,
					...requestedOperations,
				]);
				if (mergedOperations.length === existing.requestedOperations.length) {
					return { created: false, job: toRemJob(existing) };
				}
				const updated = remWaveJobSchema.parse({
					...existing,
					requestedOperations: mergedOperations,
				});
				const durable = await this.persist(updated);
				this.jobs.set(updated.waveId, updated);
				if (durable) this.onDurableTransition(toRemJob(updated));
				return { created: false, job: toRemJob(updated) };
			}
			if (
				existing !== undefined &&
				requestedOperations.every((operation) => existing.requestedOperations.includes(operation))
			) {
				return { created: false, job: toRemJob(existing) };
			}
			const job = remWaveJobSchema.parse({
				payloadVersion: 1,
				waveId: `rem-wave-${randomUUID()}`,
				correlationId,
				scope,
				requestedOperations,
				state: "queued",
				startedAt: null,
				finishedAt: null,
				stats: { operations: 0 },
			});
			const durable = await this.persist(job);
			this.jobs.set(job.waveId, job);
			this.mergeKeys.set(mergeKey, job.waveId);
			const outward = toRemJob(job);
			if (durable) this.onDurableTransition(outward);
			return { created: true, job: outward };
		});
	}

	async transition(jobId: string, transition: RemJobTransition): Promise<RemJob> {
		return this.enqueue(async () => {
			const current = this.jobs.get(jobId);
			if (!current) {
				throw new Error(`REM job not found: ${jobId}`);
			}
			const next = remWaveJobSchema.parse({
				...current,
				state: transition.state,
				...(transition.started_at === undefined ? {} : { startedAt: transition.started_at }),
				...(transition.finished_at === undefined ? {} : { finishedAt: transition.finished_at }),
				...(transition.stats === undefined ? {} : { stats: transition.stats }),
				...(transition.error === undefined ? {} : { error: transition.error }),
			});
			const durable = await this.persist(next);
			this.jobs.set(jobId, next);
			const outward = toRemJob(next);
			if (durable) this.onDurableTransition(outward);
			return outward;
		});
	}

	private async load(): Promise<void> {
		if (!existsSync(this.journalPath)) return;
		const bytes = await readFile(this.journalPath);
		const lines = bytes.toString("utf8").split("\n");
		const endsWithNewline = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
		for (const [index, line] of lines.entries()) {
			if (!line) continue;
			if (!endsWithNewline && index === lines.length - 1) {
				const lastNewline = bytes.lastIndexOf(0x0a);
				await this.truncateJournal(lastNewline < 0 ? 0 : lastNewline + 1);
				return;
			}
			try {
				const parsed: unknown = JSON.parse(line);
				const job = remWaveJobSchema.parse(parsed);
				this.jobs.set(job.waveId, job);
				this.mergeKeys.set(`${job.correlationId}\0${job.scope}`, job.waveId);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`invalid REM job journal at line ${index + 1}: ${reason}`);
			}
		}
	}

	private async migrateLegacyJournal(): Promise<void> {
		const legacyPath = path.join(path.dirname(this.journalPath), "rem-jobs.jsonl");
		if (!existsSync(legacyPath)) return;

		const latest = new Map<string, z.infer<typeof legacyJobSchema>>();
		for await (const line of readJsonlLines(legacyPath)) {
			try {
				const parsed: unknown = JSON.parse(line);
				const job = legacyJobSchema.parse(parsed);
				latest.set(job.job_id, job);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.reportFailure(reason);
			}
		}
		const interrupted = [...latest.values()].filter(
			(job) => job.state === "queued" || job.state === "running",
		);
		if (interrupted.length > 0) {
			const finishedAt = new Date().toISOString();
			const handle = await open(legacyPath, "a");
			try {
				for (const job of interrupted) {
					await handle.writeFile(
						`${JSON.stringify({
							...job,
							state: "failed",
							finished_at: finishedAt,
							error: "sidecar_upgrade_interrupted",
						})}\n`,
						"utf8",
					);
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		await rename(legacyPath, path.join(path.dirname(legacyPath), "rem-jobs.v0.jsonl"));
	}

	private reportFailure(error: unknown): void {
		log.error("rem.journal.failed", { error, path: this.journalPath }, {
			event_name: "rem.journal.failed", file: "packages/sno-station-mem/src/sidecar/rem-job-store.ts",
			function: "reportFailure", site_id: "rem.journal.failed",
		});
	}

	private async persist(job: RemWaveJob): Promise<boolean> {
		this.persistedJobs.delete(job.waveId);
		await this.append(job);
		this.persistedJobs.add(job.waveId);
		return true;
	}

	private async truncateJournal(length: number): Promise<void> {
		const handle = await open(this.journalPath, "r+");
		try {
			await handle.truncate(length);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async append(job: RemWaveJob): Promise<void> {
		const parent = path.dirname(this.journalPath);
		await mkdir(parent, { recursive: true });
		const journalAlreadyExisted = existsSync(this.journalPath);
		const handle = await open(this.journalPath, "a");
		try {
			await handle.writeFile(`${JSON.stringify(job)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!journalAlreadyExisted) {
			await syncDirectory(parent);
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function canonicalOperations(operations: readonly string[]): string[] {
	const unique = new Set(operations);
	return OPERATION_ORDER.filter((operation) => unique.has(operation));
}

function toRemJob(job: RemWaveJob): RemJob {
	return {
		job_id: job.waveId,
		state: job.state,
		type: job.requestedOperations[0] ?? "rem-replace",
		scope: job.scope,
		started_at: job.startedAt,
		finished_at: job.finishedAt,
		stats: job.stats,
		...(job.error === undefined ? {} : { error: job.error }),
		correlation_id: job.correlationId,
		requested_operations: [...job.requestedOperations],
	};
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
