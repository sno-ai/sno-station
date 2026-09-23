/** @file adapter.ts
 * @purpose Adapts plugin events to the public @snoai/observability SDK.
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
} from "@snoai/observability";
import type { PluginConfig } from "../shared/types";
import { bestEffort, bestEffortSync, type ObserveLogger } from "./best-effort";
import { CostAggregator } from "./cost-aggregator";
import { readInstalledPackageVersion, readSnoStationCoreWorkspaceVersion } from "./version-metadata";

type ObserveRuntime = ReturnType<typeof createSnoObserve>;

export type EmitInput = {
	eventType: EventType;
	eventId?: string;
	tsEdgeMs?: number;
	scope?: JsonObject;
	payload: JsonObject;
	sessionUuid?: string;
};

type FlushOptions = {
	force?: boolean;
	timeoutMs?: number;
};

const OBSERVE_EMIT_TIMEOUT_MS = 5_000;
const OBSERVE_BACKGROUND_TIMEOUT_MS = 5_000;

/** Mirrors the server's event-type → lane registry; a mismatch is a 400 on ingest. */
export function laneForEventType(eventType: EventType): EventLane {
	if (/^(reach|handoff|review)\./.test(eventType)) return "squad";
	if (eventType.startsWith("rsi.")) return "rsi";
	if (eventType.startsWith("skill.")) return "skill";
	if (eventType === "llm.call") return "llm";
	if (eventType === "tool.call") return "skill";
	if (eventType === "consent.change" || eventType === "permission.request") return "security";
	return "memory";
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
	readonly logger: ObserveLogger | undefined;
	private readonly pending = new Set<Promise<void>>();
	readonly agentId: AgentId;
	readonly enabled: boolean;
	readonly aggregator: CostAggregator = new CostAggregator();

	constructor(
		config: PluginConfig,
		cwd: string,
		logger?: ObserveLogger,
		options: { agentVersion?: string } = {},
	) {
		this.enabled = config.observe.enabled;
		this.agentId = config.observe.agentId;
		this.logger = logger;
		if (this.enabled) {
			// Both version fields are ours (spec §8.7); the host's own build is agent_version.
			const pluginVersion = readSnoStationCoreWorkspaceVersion() ?? readInstalledPackageVersion();
			this.runtime = createSnoObserve({
				cwd,
				env: {
					...process.env,
					SNO_OBSERVE_BASE_URL: config.observe.baseUrl,
				},
				...(pluginVersion ? { cliVersion: pluginVersion, pluginVersion } : {}),
				...(options.agentVersion ? { agentVersion: options.agentVersion } : {}),
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
			...(input.tsEdgeMs !== undefined ? { ts_edge_ms: input.tsEdgeMs } : {}),
			...(input.eventId ? { event_id: input.eventId } : {}),
			agent_id: this.agentId,
			lane: laneForEventType(input.eventType),
			...(scope ? { scope } : {}),
			payload: input.payload,
		};
		// tool.call aggregator.record is owned by withToolObservability (spec §7.2/§10.2).
		if (input.eventType !== "tool.call") {
			bestEffortSync(
				"costAggregator.record",
				() => this.aggregator.record(input.eventType, input.sessionUuid, input.payload),
				this.logger,
			);
		}
		// Bound this single emit so a stuck SDK call cannot block the caller
		// (e.g. session finalization); the detached emit still completes on its own.
		try {
			return await this.runEmitWithTimeout(event, {
				timeoutMs: OBSERVE_EMIT_TIMEOUT_MS,
			});
		} catch (error) {
			diagnosticLog.error("Cloud event emission failed", { event_type: input.eventType, error, outcome: "failed" }, {
				event_name: "observability.emit.failed",
				file: "packages/memory/src/engine/observability/adapter.ts",
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
						diagnosticLog.error("sno-station-mem observability: emit timed out", { event_type: event.event_type }, {
							event_name: "sno_station_mem.adapter.sno.station.mem.observability.emit.timed.out",
							file: "packages/memory/src/engine/observability/adapter.ts",
							function: "<anonymous callback>",
							site_id: "adapter.<anonymous callback>.82f49c57a7",
						});
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

	async emitError(kind: string, error: unknown, sessionUuid?: string): Promise<void> {
		const messageHash = this.hashText(formatErrorMessage(error));
		if (!messageHash) return;
		await this.emit({
			eventType: "error",
			sessionUuid,
			payload: {
				kind,
				component: {
					"claude-code": "mem-claude", codex: "mem-codex",
					openclaw: "mem-claw", hermes: "mem-hermes",
				}[this.agentId],
				context: kind.split(":", 1)[0] ?? kind,
				message_hash: messageHash,
				recoverable: false,
			},
		});
	}

	trackBestEffort(label: string, task: () => void | Promise<void>): void {
		const run = bestEffort(label, task, this.logger);
		const tracked = this.runBackgroundTask(label, run).finally(() => {
			this.pending.delete(tracked);
		});
		this.pending.add(tracked);
	}

	private async runBackgroundTask(label: string, run: Promise<void>): Promise<void> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		run.catch(() => undefined);
		try {
			await Promise.race([
				run,
				new Promise<void>((resolve) => {
					timeoutHandle = setTimeout(() => {
						diagnosticLog.error("Background telemetry action timed out", {
							action: label, timeout_ms: OBSERVE_BACKGROUND_TIMEOUT_MS,
						}, {
							event_name: "observability.background.timed_out",
							file: "packages/memory/src/engine/observability/adapter.ts",
							function: "PluginObservability.runBackgroundTask",
							site_id: "observability.background.timed_out",
						});
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
									file: "packages/memory/src/engine/observability/adapter.ts",
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
									file: "packages/memory/src/engine/observability/adapter.ts",
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
		// The timeout bounds how long the caller waits, never the request: cutting a slow POST
		// turns an accepted event into a retry with backoff (measured against www.sno.ai 2026-09-22).
		const run = this.runtime.flush({ force }).then(() => undefined);
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
								diagnosticLog.warn("sno observe flush timed out", undefined, {
									event_name: "sno_station_mem.adapter.sno.observe.flush.timed.out",
									file: "packages/memory/src/engine/observability/adapter.ts",
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
