/** @file adapter.ts
 * @purpose Adapts plugin events to the public @snoai/sno-observe SDK.
 * @boundary Plugin emits only public SDK events; the SDK owns buffering and HTTP delivery.
 */

import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:adapter");
import {
	type AgentId,
	createSnoObserve,
	type Event,
	type EventLane,
	type EventType,
	type JsonObject,
} from "@snoai/sno-observe";
import type { PluginConfig } from "../shared/types";
import { bestEffort, bestEffortSync, type ObserveLogger } from "./best-effort";
import { CostAggregator } from "./cost-aggregator";
import { readSnoStationMemPackageVersion, readSnoStationCoreWorkspaceVersion } from "./version-metadata";

type ObserveRuntime = ReturnType<typeof createSnoObserve>;

type EmitInput = {
	eventType: EventType;
	eventId?: string;
	scope?: JsonObject;
	payload: JsonObject;
	sessionUuid?: string;
};

type FlushOptions = {
	force?: boolean;
	timeoutMs?: number;
};

type BackgroundTaskOptions = {
	cooldownKey?: string;
};

const OBSERVE_EMIT_TIMEOUT_MS = 5_000;
const OBSERVE_BACKGROUND_TIMEOUT_MS = 5_000;
const OBSERVE_BACKGROUND_COOLDOWN_MS = 60_000;
// Bounds cases where the wrapped SDK's shared emit mutex is genuinely wedged
// forever: the local cap (MAX_PENDING_OBSERVE_TASKS) frees a slot as soon as
// a task times out, so new work keeps being admitted and piling up as
// uncancellable orphaned promises inside the SDK even though the cap-count
// itself stays bounded. Once this many orphans are outstanding at once, stop
// admitting new background work for a cooldown instead of growing forever.
// host review 2026-07-12.
const MAX_OUTSTANDING_ORPHANED_TASKS = 50;
const ORPHAN_CIRCUIT_COOLDOWN_MS = 60_000;
const MAX_PENDING_OBSERVE_TASKS = 1_000;

function laneForEventType(eventType: EventType): EventLane {
	if (eventType === "llm.call") return "llm";
	if (eventType === "tool.call") return "skill";
	return "memory";
}

export function observeBackgroundCooldownKey(
	label: string,
	sessionUuid: string | undefined,
): string {
	return sessionUuid ? `${label}:${sessionUuid}` : label;
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null) {
		try {
			return JSON.stringify(error);
		} catch {
			return "[unserializable]";
		}
	}
	return String(error);
}

export class PluginObservability {
	private readonly runtime: ObserveRuntime | undefined;
	private readonly logger: ObserveLogger | undefined;
	private readonly pending = new Set<Promise<void>>();
	private readonly liveBackgroundTasks = new Set<Promise<void>>();
	private readonly backgroundCircuitOpenUntilMsByLabel = new Map<string, number>();
	private outstandingOrphanedTasks = 0;
	private orphanCircuitOpenUntilMs = 0;
	readonly agentId: AgentId;
	readonly enabled: boolean;
	readonly aggregator: CostAggregator = new CostAggregator();

	constructor(config: PluginConfig, cwd: string, logger?: ObserveLogger) {
		this.enabled = config.observe.enabled;
		this.agentId = config.observe.agentId;
		this.logger = logger;
		if (this.enabled) {
			const snoStationCoreVersion = readSnoStationCoreWorkspaceVersion() ?? readSnoStationMemPackageVersion();
			this.runtime = createSnoObserve({
				cwd,
				env: {
					...process.env,
					SNO_OBSERVE_BASE_URL: config.observe.baseUrl,
				},
				...(snoStationCoreVersion ? { cliVersion: snoStationCoreVersion, pluginVersion: snoStationCoreVersion } : {}),
			});
		}
	}

	hashText(input: string): string | undefined {
		if (!this.runtime) return undefined;
		return bestEffortSync(
			"hashRedactedText",
			() => this.runtime?.hashRedactedText(input),
			this.logger,
		);
	}

	shouldSampleTool(eventId: string, toolName: string): boolean {
		if (!this.runtime) return false;
		return (
			bestEffortSync(
				"shouldSampleTool",
				() => this.runtime?.shouldSampleTool(eventId, toolName) ?? false,
				this.logger,
			) ?? false
		);
	}

	async emit(input: EmitInput): Promise<void> {
		await this.tryEmit(input);
	}

	async tryEmit(input: EmitInput): Promise<boolean> {
		if (!this.runtime) return false;
		const scope = input.sessionUuid
			? { ...(input.scope ?? {}), session_uuid: input.sessionUuid }
			: input.scope;
		const event: Event = {
			event_type: input.eventType,
			...(input.eventId ? { event_id: input.eventId } : {}),
			agent_id: this.agentId,
			lane: laneForEventType(input.eventType),
			...(scope ? { scope } : {}),
			payload: input.payload,
		};
		// tool.call aggregator.record is owned by withToolObservability so the
		// counter still ticks when cloud emit is unsampled (spec §7.2/§10.2).
		if (input.eventType !== "tool.call") {
			bestEffortSync(
				"costAggregator.record",
				() => this.aggregator.record(input.eventType, input.sessionUuid, input.payload),
				this.logger,
			);
		}
		// Bound this single emit so a stuck SDK call cannot block the caller
		// (e.g. session finalization). NO circuit breaker — a timeout drops
		// only this event; subsequent events still go through.
		try {
			return await this.runEmitWithTimeout(event, {
				timeoutMs: OBSERVE_EMIT_TIMEOUT_MS,
			});
		} catch (error) {
			diagnosticLog.warn("Cloud event emission failed", { error, outcome: "failed" }, {
				event_name: "observability.emit.failed",
				file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
				function: "PluginObservability.tryEmit",
				site_id: "observability.emit.failed",
			});
			return false;
		}
	}

	private async runEmitWithTimeout(
		event: Event,
		options: { timeoutMs: number },
	): Promise<boolean> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const run = Promise.resolve()
			.then(() => this.runtime?.emit(event))
			.then(() => true);
		run.catch(() => undefined);
		try {
			return await Promise.race([
				run,
				new Promise<boolean>((resolve) => {
					timeoutHandle = setTimeout(() => {
						diagnosticLog.warn("sno-station-mem observability: emit timed out", undefined, {
							event_name: "sno_station_mem.adapter.sno.station.mem.observability.emit.timed.out",
							file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
							function: "<anonymous callback>",
							site_id: "adapter.<anonymous callback>.82f49c57a7",
						});
						// This race abandons `run` — the genuinely orphaned promise when
						// the SDK's shared emit mutex is wedged (emit has no abort hook;
						// its network I/O lives in flush/drain which do). Counting here,
						// at the abandonment site, is what makes the orphan ceiling see
						// production wedges. A background task that awaits BEFORE calling
						// emit (memory.write/read, embeddings) arms the OUTER 5s timer
						// first, so one wedged emit can be counted at both sites for the
						// brief window until this self-timeout settles the outer task and
						// its finally() decrements — a transient conservative overcount
						// in the protective direction, self-correcting to +1 per wedge.
						this.registerOrphanedTask(run);
						resolve(false);
					}, options.timeoutMs);
					const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
						unref?: () => void;
					};
					nodeTimeout.unref?.();
				}),
			]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	private registerOrphanedTask(run: Promise<unknown>): void {
		this.outstandingOrphanedTasks += 1;
		if (this.outstandingOrphanedTasks >= MAX_OUTSTANDING_ORPHANED_TASKS) {
			this.orphanCircuitOpenUntilMs = Date.now() + ORPHAN_CIRCUIT_COOLDOWN_MS;
			diagnosticLog.warn("Background telemetry paused after stuck emissions", {
				outstanding_count: this.outstandingOrphanedTasks, cooldown_ms: ORPHAN_CIRCUIT_COOLDOWN_MS,
			}, {
				event_name: "observability.background.paused",
				file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
				function: "PluginObservability.registerOrphanedTask",
				site_id: "observability.background.paused",
			});
		}
		// If the orphan eventually settles the wedge was transient, not permanent —
		// release its slot so only genuinely-stuck work accumulates toward the ceiling.
		run.finally(() => {
			this.outstandingOrphanedTasks = Math.max(0, this.outstandingOrphanedTasks - 1);
		});
	}

	async emitError(kind: string, error: unknown, sessionUuid?: string): Promise<void> {
		const messageHash = this.hashText(formatErrorMessage(error));
		if (!messageHash) return;
		await this.emit({
			eventType: "error",
			sessionUuid,
			payload: {
				kind,
				message_hash: messageHash,
				recoverable: false,
			},
		});
	}

	trackBestEffort(
		label: string,
		task: () => void | Promise<void>,
		options: BackgroundTaskOptions = {},
	): void {
		const cooldownKey = options.cooldownKey ?? label;
		const now = Date.now();
		this.pruneExpiredBackgroundCooldowns(now);
		if (this.liveBackgroundTasks.size >= MAX_PENDING_OBSERVE_TASKS) {
			diagnosticLog.warn("Background telemetry rejected by queue limit", {
				action: label, reason: "queue_full", pending_count: this.liveBackgroundTasks.size,
			}, {
				event_name: "observability.background.rejected",
				file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
				function: "PluginObservability.trackBestEffort",
				site_id: "observability.background.queue_full",
			});
			return;
		}
		if (now < (this.backgroundCircuitOpenUntilMsByLabel.get(cooldownKey) ?? 0)) {
			diagnosticLog.warn("Background telemetry rejected during timeout cooldown", {
				action: label, reason: "timeout_cooldown",
			}, {
				event_name: "observability.background.rejected",
				file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
				function: "PluginObservability.trackBestEffort",
				site_id: "observability.background.cooldown",
			});
			return;
		}
		if (now < this.orphanCircuitOpenUntilMs) {
			diagnosticLog.warn("Background telemetry rejected by stuck emission limit", {
				action: label, reason: "orphan_limit", outstanding_count: this.outstandingOrphanedTasks,
			}, {
				event_name: "observability.background.rejected",
				file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
				function: "PluginObservability.trackBestEffort",
				site_id: "observability.background.orphan_limit",
			});
			return;
		}
		const run = bestEffort(label, task, this.logger);
		this.liveBackgroundTasks.add(run);
		// Free the queue slot when the *bounded* task settles (completion or the
		// 5s timeout), not when the raw emit settles. The SDK emit exposes no
		// cancellation hook, so a wedged emit never settles; keying eviction on
		// the raw promise leaked slots until the cap permanently dropped all
		// telemetry. runBackgroundTask always settles within the timeout, so a
		// timed-out emit is evicted and subsequent events still go through.
		const tracked = this.runBackgroundTask(label, cooldownKey, run).finally(() => {
			this.liveBackgroundTasks.delete(run);
			this.pending.delete(tracked);
		});
		this.pending.add(tracked);
	}

	private pruneExpiredBackgroundCooldowns(now: number): void {
		for (const [cooldownKey, openUntilMs] of this.backgroundCircuitOpenUntilMsByLabel) {
			if (openUntilMs <= now) {
				this.backgroundCircuitOpenUntilMsByLabel.delete(cooldownKey);
			}
		}
	}

	private async runBackgroundTask(
		label: string,
		cooldownKey: string,
		run: Promise<void>,
	): Promise<void> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		run.catch(() => undefined);
		try {
			await Promise.race([
				run,
				new Promise<void>((resolve) => {
					timeoutHandle = setTimeout(() => {
						this.backgroundCircuitOpenUntilMsByLabel.set(
							cooldownKey,
							Date.now() + OBSERVE_BACKGROUND_COOLDOWN_MS,
						);
						diagnosticLog.warn("Background telemetry action timed out", {
							action: label, timeout_ms: OBSERVE_BACKGROUND_TIMEOUT_MS,
						}, {
							event_name: "observability.background.timed_out",
							file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
							function: "PluginObservability.runBackgroundTask",
							site_id: "observability.background.timed_out",
						});
						// Tasks stuck outside the emit path land here (emit-bound tasks
						// are normally settled by emit's own self-timeout). For a task
						// that awaited before reaching emit, this outer timer can fire
						// first and briefly count the same wedge as the emit-site
						// registration — see the note there: transient, protective
						// direction, self-corrects when this `run` settles. The raw
						// `run` here is equally uncancellable and orphaned; same ceiling.
						this.registerOrphanedTask(run);
						resolve();
					}, OBSERVE_BACKGROUND_TIMEOUT_MS);
					const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
						unref?: () => void;
					};
					nodeTimeout.unref?.();
				}),
			]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	async drain(options: Pick<FlushOptions, "timeoutMs"> = {}): Promise<void> {
		if (this.pending.size === 0) return;
		const pending = Promise.allSettled([...this.pending]).then(() => undefined);
		if (!options.timeoutMs) {
			await bestEffort("drain", () => pending, this.logger);
			return;
		}
		await bestEffort(
			"drain",
			async () => {
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						pending,
						new Promise<void>((resolve) => {
							timeoutHandle = setTimeout(() => {
								diagnosticLog.warn("sno observe drain timed out", undefined, {
									event_name: "sno_station_mem.adapter.sno.observe.drain.timed.out",
									file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
									function: "<anonymous callback>",
									site_id: "adapter.<anonymous callback>.f036514cb8",
								});
								resolve();
							}, options.timeoutMs);
							const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
								unref?: () => void;
							};
							nodeTimeout.unref?.();
						}),
					]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			},
			this.logger,
		);
	}

	async drainBuffer(options: Pick<FlushOptions, "timeoutMs"> = {}): Promise<void> {
		if (!this.runtime) return;
		const run = this.runtime.drain().then(() => undefined);
		run.catch(() => undefined);
		if (!options.timeoutMs) {
			await bestEffort("drainBuffer", () => run, this.logger);
			return;
		}
		await bestEffort(
			"drainBuffer",
			async () => {
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						run,
						new Promise<void>((resolve) => {
							timeoutHandle = setTimeout(() => {
								diagnosticLog.warn("sno observe buffer drain timed out", undefined, {
									event_name: "sno_station_mem.adapter.sno.observe.buffer.drain.timed.out",
									file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
									function: "<anonymous callback>",
									site_id: "adapter.<anonymous callback>.9aedc01548",
								});
								resolve();
							}, options.timeoutMs);
							const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
								unref?: () => void;
							};
							nodeTimeout.unref?.();
						}),
					]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			},
			this.logger,
		);
	}

	async flush(options: FlushOptions = {}): Promise<void> {
		if (!this.runtime) return;
		const force = options.force ?? true;
		const controller = options.timeoutMs ? new AbortController() : undefined;
		const run = this.runtime
			.flush(controller === undefined ? { force } : { force, signal: controller.signal })
			.then(() => undefined);
		run.catch(() => undefined);
		if (!options.timeoutMs) {
			await bestEffort("flush", () => run, this.logger);
			return;
		}
		await bestEffort(
			"flush",
			async () => {
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						run,
						new Promise<void>((resolve) => {
							timeoutHandle = setTimeout(() => {
								controller?.abort();
								diagnosticLog.warn("sno observe flush timed out", undefined, {
									event_name: "sno_station_mem.adapter.sno.observe.flush.timed.out",
									file: "packages/sno-station-mem/src/engine/observability/adapter.ts",
									function: "<anonymous callback>",
									site_id: "adapter.<anonymous callback>.52f64c2607",
								});
								resolve();
							}, options.timeoutMs);
							const nodeTimeout = timeoutHandle as typeof timeoutHandle & {
								unref?: () => void;
							};
							nodeTimeout.unref?.();
						}),
					]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			},
			this.logger,
		);
	}

	async shutdown(): Promise<void> {
		if (!this.runtime) return;
		await bestEffort(
			"shutdown",
			async () => {
				await this.runtime?.shutdown();
			},
			this.logger,
		);
	}
}
