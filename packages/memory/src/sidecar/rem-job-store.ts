import { readJsonlLines } from "../engine/operations/jsonl-lines";
import { createLogger } from "@snoai/utils/logger";
/** @file rem-job-store.ts
 * @purpose Persists append-only REM job state transitions.
 * @boundary Durable local JSONL journal used by the standalone REM sidecar.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const log = createLogger("sno-station-mem:rem-jobs");

export type RemJobState = "queued" | "running" | "done" | "failed" | "skipped";

export interface RemJobStats {
	operations: number;
	applied_count?: number;
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
}

interface RemWaveJob {
	payloadVersion: 1;
	waveId: string;
	correlationId: string;
	scope: string;
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
	"skipped",
]);
const remJobStatsSchema: z.ZodType<RemJobStats> = z.object({
	operations: z.number().int().nonnegative(),
	applied_count: z.number().int().nonnegative().optional(),
}).strict();

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
		state: remJobStateSchema,
		startedAt: z.string().datetime().nullable(),
		finishedAt: z.string().datetime().nullable(),
		stats: remJobStatsSchema,
		error: z.string().min(1).optional(),
	})
	.strict();

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
	private journalRecords = 0;

	private constructor(
		private readonly journalPath: string,
		private readonly onDurableTransition: (job: RemJob) => void,
	) {}

	static async open(
		journalPath: string,
		onDurableTransition: (job: RemJob) => void = () => undefined,
	): Promise<RemJobStore> {
		const store = new RemJobStore(journalPath, onDurableTransition);
		await store.load();
		return store;
	}

	isPersisted(jobId: string): boolean { return this.persistedJobs.has(jobId); }

	get(jobId: string): RemJob | undefined {
		const job = this.jobs.get(jobId);
		return job === undefined ? undefined : toRemJob(job);
	}

	static async readCompletedJobs(journalPath: string): Promise<RemJob[]> {
		const completed = new Map<string, RemJob>();
		for await (const line of readJsonlLines(journalPath)) {
			try {
				const parsed = remWaveJobSchema.parse(JSON.parse(line));
				if (parsed.state === "done") completed.set(parsed.waveId, toRemJob(parsed));
				else completed.delete(parsed.waveId);
			} catch (error) {
				log.error("rem.journal.failed", { error, path: journalPath }, {
					event_name: "rem.journal.failed", file: "packages/memory/src/sidecar/rem-job-store.ts",
					function: "readCompletedJobs", site_id: "rem-job-store.readCompletedJobs.invalid-line",
				});
			}
		}
		return [...completed.values()];
	}

	nonTerminalJobs(): RemJob[] {
		return Array.from(this.jobs.values()).filter(
			(job) => job.state === "queued" || job.state === "running",
		).map(toRemJob);
	}

	async createQueued(
		scope: string,
		correlationId: string,
	): Promise<{ created: boolean; job: RemJob }> {
		return this.enqueue(async () => {
			const mergeKey = `${correlationId}\0${scope}`;
			const existingId = this.mergeKeys.get(mergeKey);
			const existing = existingId === undefined ? undefined : this.jobs.get(existingId);
			if (existing !== undefined && existing.state !== "skipped" && existing.state !== "failed") {
				return { created: false, job: toRemJob(existing) };
			}
			const job = remWaveJobSchema.parse({
				payloadVersion: 1,
				waveId: `rem-wave-${randomUUID()}`,
				correlationId,
				scope,
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
			if (next.state === "done") this.jobs.set(jobId, next);
			const durable = await this.persist(next);
			this.jobs.set(jobId, next);
			const outward = toRemJob(next);
			if (durable) this.onDurableTransition(outward);
			return outward;
		});
	}

	private async load(): Promise<void> {
		if (!existsSync(this.journalPath)) return;
		await this.removeTornTail();
		let index = 0;
		for await (const line of readJsonlLines(this.journalPath)) {
			index++;
			this.journalRecords++;
			try {
				const job = remWaveJobSchema.parse(JSON.parse(line));
				this.jobs.set(job.waveId, job);
				this.mergeKeys.set(`${job.correlationId}\0${job.scope}`, job.waveId);
			} catch (error) {
				log.error("rem.journal.failed", { path: this.journalPath, line: index, error }, {
					event_name: "rem.journal.failed", file: "packages/memory/src/sidecar/rem-job-store.ts",
					function: "load", site_id: "rem-job-store.load.invalid-line",
				});
			}
		}
		if (this.journalRecords >= 256) await this.compact().catch(error => this.reportFailure(error));
	}

	private async removeTornTail(): Promise<void> {
		const handle = await open(this.journalPath, "r");
		let committed = (await handle.stat()).size;
		const buffer = Buffer.alloc(64 * 1024);
		try {
			while (committed > 0) {
				const start = Math.max(0, committed - buffer.length);
				const { bytesRead } = await handle.read(buffer, 0, committed - start, start);
				const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
				if (newline >= 0) { committed = start + newline + 1; break; }
				committed = start;
			}
			if (committed < (await handle.stat()).size) await this.truncateJournal(committed);
		} finally { await handle.close(); }
	}

	private async compact(): Promise<void> {
		const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		const retained = [...this.jobs.values()].filter(job => job.state === "queued" || job.state === "running"
			|| (job.finishedAt ?? job.startedAt ?? "") >= cutoff);
		const temporary = `${this.journalPath}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			try {
				for (const job of retained) await handle.writeFile(`${JSON.stringify(job)}\n`, "utf8");
				await handle.sync();
			} finally { await handle.close(); }
			await rename(temporary, this.journalPath);
			await syncDirectory(path.dirname(this.journalPath));
			const retainedIds = new Set(retained.map(job => job.waveId));
			for (const id of this.jobs.keys()) if (!retainedIds.has(id)) {
				this.jobs.delete(id);
				this.persistedJobs.delete(id);
			}
			for (const [key, id] of this.mergeKeys) if (!retainedIds.has(id)) this.mergeKeys.delete(key);
			this.journalRecords = 0;
		} finally { await rm(temporary, { force: true }); }
	}

	private reportFailure(error: unknown): void {
		log.error("rem.journal.failed", { error, path: this.journalPath }, {
			event_name: "rem.journal.failed", file: "packages/memory/src/sidecar/rem-job-store.ts",
			function: "reportFailure", site_id: "rem.journal.failed",
		});
	}

	private async persist(job: RemWaveJob): Promise<boolean> {
		this.persistedJobs.delete(job.waveId);
		await this.append(job);
		this.persistedJobs.add(job.waveId);
		this.journalRecords++;
		if (this.journalRecords >= 256) {
			// Include the just-appended transition before replacing the journal.
			this.jobs.set(job.waveId, job);
			await this.compact().catch(error => this.reportFailure(error));
		}
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

function toRemJob(job: RemWaveJob): RemJob {
	return {
		job_id: job.waveId,
		state: job.state,
		type: "precision-nightly",
		scope: job.scope,
		started_at: job.startedAt,
		finished_at: job.finishedAt,
		stats: job.stats,
		...(job.error === undefined ? {} : { error: job.error }),
		correlation_id: job.correlationId,
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
