import { getSnoProfileDir } from "@snoai/observability";
import { forwardObserveLedger } from "../engine/telemetry/observe-ledger";
import { readMaintenanceOverrides } from "./config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createUUIDv7 } from "@snoai/common-core";
import { readMemorySnapshotPayload, type SnapshotReason } from "../engine/observability/memory-snapshot";
import { forwardMemoryTelemetryToObserve } from "../engine/telemetry/memory-telemetry-observability";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { emitRuntimeStartSnapshot } from "../engine/observability/runtime-diagnostics";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT } from "../model/signed-registry-constants";
import { parseInput, parseOutput, type ContractMethod, type ContractOutputs, type Registration, type ScopeCtx } from "../contract/index";
import type { PluginConfig } from "../../config/plugin-config-schema";
import { MemoryContractRuntime } from "../engine/contract-runtime";
import { inspectProviderProjects } from "../engine/provider/provider-authority";
import { readTrustedUserId } from "../engine/provider/provider-registration";
import { getPrincipal, getSnoStationMemStateDir } from "../engine/shared/paths";
import { getSettingsPath, readSettings } from "../contract/profile";
import { settingsToPluginConfig, type Settings } from "../../config/settings";
import { ObservableEmbedder } from "../engine/observability/observable-embedder";
import { ObservableMemoryStore } from "../engine/observability/observable-memory-store";
import { ObservableMemoryRetriever } from "../engine/observability/observable-retriever";
import { PluginObservability } from "../engine/observability/adapter";
import { bestEffort } from "../engine/observability/best-effort";
import { AccessTracker } from "../engine/retrieval/access-tracker";
import { DEFAULT_RETRIEVAL_CONFIG } from "../engine/retrieval/retriever";
import { createTierPromoter } from "../engine/operations/memory-tier-promoter";
import { MemoryTelemetryUsageOutbox } from "../engine/telemetry/memory-telemetry-outbox";
import { readChunkVecTableState } from "../store/connection";
import { initSqliteRuntime } from "../store/sqlite-runtime";
import { startMaintenanceTimer, uniformMaintenanceIntervals, type MaintenanceTimerHandle } from "../store/maintenance";
import { RegisteredAgentPort } from "../model/registered-agent-port";
import { evaluateRemAutomaticTriggers } from "./rem-trigger";
import { withProviderResponses } from "../model/llm-provider-transport";
import type { ProviderResponseTrace } from "../model/llm-client-types";
import { MEMORY_USAGE_FLUSH_INTERVAL_MS } from "./config";
import { SNO_OBSERVE_FLUSH_TIMEOUT_MS } from "../../config/index";
import { isObserveAgentId, observeAgentId } from "../../config/plugin-config-observe-schema";

/** The skin and observe session of the request in flight; store, embedder and retriever events carry both. */
const observeSession = new AsyncLocalStorage<{ uuid: string; entry: SkinRuntime }>();
const observeSessionUuid = (): string | undefined => observeSession.getStore()?.uuid;

/**
 * The store and embedder are shared by every skin, so their events go to the skin in flight;
 * outside a request (maintenance) they fall back to the sidecar's own observability.
 */
function routedObservability(fallback: PluginObservability): PluginObservability {
	return new Proxy(fallback, {
		get(target, property) {
			const current = observeSession.getStore()?.entry.observability ?? target;
			const value = Reflect.get(current, property, current) as unknown;
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
}

const log = createLogger("sno-station-mem:runtime");
function engineLog(level: "info" | "warn" | "error" | "debug", message: string): void {
	log[level]("Memory engine message", { message }, {
		event_name: "memory.sidecar.engine.message", file: "packages/memory/src/sidecar/memory-runtime.ts",
		function: "engineLog", site_id: "memory.sidecar.engine.message",
	});
}
const engineLogger = {
	info: (message: string): void => engineLog("info", message),
	warn: (message: string): void => engineLog("warn", message),
	error: (message: string): void => engineLog("error", message),
	debug: (message: string): void => engineLog("debug", message),
};
interface SkinRuntime {
	runtime: MemoryContractRuntime;
	tracker: AccessTracker;
	observability: PluginObservability;
	active: number;
	retired: boolean;
	embedder: ObservableEmbedder;
	agentPort: RegisteredAgentPort;
	connected: boolean;
	/** Observe sessions this sidecar named for the skin (the coding skins name none), by host session id. */
	hostSessions: Map<string, { uuid: string; startedAt: number }>;
}

export class MemoryRuntimePool {
	readonly principal: string = getPrincipal();
	readonly stateDir: string = getSnoStationMemStateDir();
	readonly counters: { engineAccesses: number; storeAccesses: number } = { engineAccesses: 0, storeAccesses: 0 };
	private readonly skins = new Map<string, SkinRuntime>();
	private readonly owned = new Set<SkinRuntime>();
	private maintenance: MaintenanceTimerHandle | undefined;
	private usageTimer: NodeJS.Timeout | undefined;
	private usageFlush: Promise<unknown> | undefined;
	private modelReady = false;
	modelPreparationError: string | undefined;
	private modelPreparation: Promise<void> | undefined;
	private readonly usageOutbox: MemoryTelemetryUsageOutbox;
	private constructor(
		readonly storePath: string,
		readonly store: ObservableMemoryStore,
		readonly config: PluginConfig,
		readonly settings: Settings,
		private readonly observability: PluginObservability,
		private readonly embedder: ObservableEmbedder,
	) {
		this.usageOutbox = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: storePath });
		store.sqlite.exec("CREATE TABLE IF NOT EXISTS pending_captures (id TEXT PRIMARY KEY, skin_id TEXT NOT NULL, request TEXT NOT NULL)");
	}

	private async prepareModel(): Promise<void> {
		try {
			await this.embedder.warmup();
			this.modelReady = true;
			this.modelPreparationError = undefined;
			await this.replayPendingCaptures();
		} catch (error) {
			if (!this.modelReady) this.modelPreparationError = `model preparation failed: ${this.settings.embedding.model} (cache: ${this.settings.embedding.cacheDir}): ${String(error)}`;
			log.error("Embedding model preparation failed", { cache_path: this.settings.embedding.cacheDir,
				settings_file: getSettingsPath(), error }, {
				event_name: "memory.sidecar.model.prepare.failed", file: "packages/memory/src/sidecar/memory-runtime.ts",
				function: "prepareModel", site_id: "memory.sidecar.model.prepare.failed",
			});
		}
	}

	private async replayPendingCaptures(): Promise<void> {
		const rows = this.store.sqlite.prepare("SELECT id, skin_id, request FROM pending_captures ORDER BY rowid").all() as Array<{ id: string; skin_id: string; request: string }>;
		for (const row of rows) {
			try {
				const result = await this.invoke("capture", JSON.parse(row.request), row.skin_id);
				if (!result.degraded && "committed" in result && (result.committed || result.skipped || result.partial))
					this.store.sqlite.prepare("DELETE FROM pending_captures WHERE id = ?").run(row.id);
				else throw new Error("Pending capture was not completed");
			} catch (error) {
				log.error("Pending capture failed", { error }, {
					event_name: "memory.sidecar.pending_capture.failed", file: "packages/memory/src/sidecar/memory-runtime.ts",
					function: "replayPendingCaptures", site_id: "memory.sidecar.pending_capture.failed",
				});
			}
		}
	}

	static async open(): Promise<MemoryRuntimePool> {
		const settings = readSettings();
		const storePath = settings.store.path;
		const config = settingsToPluginConfig(settings);
		try {
			emitRuntimeStartSnapshot({ runtimeMode: "sidecar", preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
				logging: settings.logging,
				routing: { mode: settings.mode, language: config.language, modelCalls: settings.modelCalls } });
		} catch (error) { engineLogger.error(String(error)); }
		initSqliteRuntime(settings.store.encryptionKey);
		await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
		const stateDir = getSnoStationMemStateDir();
		const observability = new PluginObservability(config, stateDir, engineLogger, {}, settings.telemetry.redactionRules);
		const routed = routedObservability(observability);
		const embedder = new ObservableEmbedder(config.embedding, stateDir, routed, observeSessionUuid);
		const store = new ObservableMemoryStore({ dbPath: storePath, vectorDim: embedder.dimensions, embedder, memoryTelemetry: config.memoryTelemetry }, routed, observeSessionUuid, config.embedding);
		store.cancelScheduledLegacyChunkBackfill();
		const pool = new MemoryRuntimePool(storePath, store, config, settings, observability, embedder);
		return pool;
	}

	startWork(): void {
		if (this.modelPreparation) return;
		this.modelPreparation = this.prepareModel();
		this.store.scheduleLegacyChunkBackfill();
		const maintenance = readMaintenanceOverrides();
		this.maintenance = startMaintenanceTimer({ store: this.store, dbPath: this.storePath, stateDir: this.stateDir, remClock: maintenance.now, remVolumeThreshold: maintenance.volumeThreshold,
			mode: this.config.mode, modelCalls: this.settings.modelCalls,
			remSettings: { mode: this.settings.mode, requestedOperations: this.settings.rem.operations, tickEnabled: this.settings.rem.tick }, hasConnectedHost: () => this.connectedRemPort() !== undefined,
			backupDir: join(this.stateDir, "backups"), usageOutbox: this.usageOutbox }, maintenance.intervalMs, maintenance.intervalMs,
			maintenance.intervalMs === undefined ? undefined : uniformMaintenanceIntervals(maintenance.intervalMs));
		this.startUsageTimer();
	}

	private async register(scope: ScopeCtx, registration: Registration): Promise<ContractOutputs["init"]> {
		const config: PluginConfig = { ...this.config,
			observe: { ...this.config.observe, agentId: isObserveAgentId(registration.skinId)
				? observeAgentId(registration.skinId) : this.config.observe.agentId } };
		let entry: SkinRuntime;
		const agentPort = new RegisteredAgentPort(registration.model, () => { entry.connected = false; });
		const observability = new PluginObservability(config, this.stateDir, engineLogger, {}, this.settings.telemetry.redactionRules);
		const embedder = new ObservableEmbedder(config.embedding, this.stateDir, observability, observeSessionUuid);
		const retriever = new ObservableMemoryRetriever(this.store, embedder, engineLogger, { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval }, observability, observeSessionUuid, config.embedding);
		const tracker = new AccessTracker({ store: this.store, recallLifecycle: config.recallLifecycle });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(config.recallLifecycle);
		retriever.setTierPromoter(createTierPromoter());
		const runtime = new MemoryContractRuntime({ config, store: this.store, embedder, retriever, accessTracker: tracker, observability,
			stateDir: this.stateDir, agentPort, logger: engineLogger, telemetryUsage: this.usageOutbox, recallSettings: this.settings.recall });
		entry = { runtime, tracker, observability, embedder, agentPort, connected: !!registration.model, active: 0, retired: false, hostSessions: new Map() };
		this.owned.add(entry);
		try {
			const result = await runtime.init(scope, registration);
			// The successor is published only once it has proven it can read the store; the
			// sessions, cost tallies and per-turn recall state of the previous entry carry over.
			const previous = this.skins.get(registration.skinId);
			await this.snapshot(entry, "startup", scope.host?.observeSessionUuid);
			entry.observability.trackBestEffort("observe ledger", async () => {
				await forwardObserveLedger({
					profileDir: getSnoProfileDir(), observe: entry.observability,
				});
			});
			if (previous) {
				entry.hostSessions = previous.hostSessions;
				entry.observability.aggregator.adopt(previous.observability.aggregator);
				entry.runtime.adoptRecall(previous.runtime);
			}
			this.skins.delete(registration.skinId);
			this.skins.set(registration.skinId, entry);
			if (previous) { previous.retired = true; if (previous.active === 0) await this.dispose(previous); }
			if (registration.model) this.modelPreparation = this.modelPreparation?.then(() => this.modelReady
				? this.replayPendingCaptures() : this.prepareModel()).catch(error => engineLogger.error(String(error)));
			if (registration.model) void Promise.resolve().then(() => evaluateRemAutomaticTriggers({
				database: this.store.sqlite, stateDir: this.stateDir,
				mode: this.settings.mode, requestedOperations: this.settings.rem.operations,
				tickEnabled: this.settings.rem.tick, modelCalls: this.settings.modelCalls,
				hasConnectedHost: () => this.connectedRemPort() !== undefined,
			})).catch(error => engineLogger.error(String(error)));
			return result;
		} catch (error) { await this.dispose(entry); throw error; }
	}

	connectedRemPort(): RegisteredAgentPort | undefined {
		return [...this.skins.values()].reverse().find(entry => entry.connected)?.agentPort;
	}

	async invoke(method: ContractMethod, raw: unknown, skinId: string, signal?: AbortSignal): Promise<ContractOutputs[ContractMethod]> {
		signal?.throwIfAborted();
		const input = parseInput(method, raw);
		if (method === "inspect") {
			const { op } = parseInput("inspect", raw);
			if (op.op === "projects" || op.op === "currentProject") {
				this.counters.storeAccesses++;
				return parseOutput("inspect", { degraded: false, result: inspectProviderProjects(this.store, readTrustedUserId(this.config), op) });
			}
			if (op.op === "stats" && !op.scope) {
				this.counters.storeAccesses++;
				return parseOutput("inspect", { degraded: false, result: { op: "stats", ...await this.store.stats() } });
			}
		}
		this.startWork();
		if (method === "mutate" && parseInput("mutate", raw).op.op === "correct" && !this.modelReady) {
			const preparation = this.modelPreparation;
			if (preparation) {
				await (signal ? new Promise<void>((resolve, reject) => {
					const abort = (): void => reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					preparation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
				}) : preparation);
			}
			signal?.throwIfAborted();
			if (!this.modelReady) {
				const cause = this.modelPreparationError ?? "model-preparing";
				const op = parseInput("mutate", raw).op;
				if (op.op === "correct") engineLogger.error(`correct ${op.id}: ${cause}; correction was not applied`);
				return { degraded: true, reason: "engine-failed", error: cause, result: { isError: true,
					content: [{ type: "text", text: cause }], details: { errorCode: "engine-failed" } } };
			}
		}
		if (method === "capture" && !this.modelReady) {
			const capture = parseInput("capture", raw);
			const id = JSON.stringify([skinId, capture.scope.principal, capture.scope.project, capture.scope.session, capture.turn.turnId, capture.turn.rewindEpoch]);
			const request = JSON.stringify(capture);
			const existing = this.store.sqlite.prepare("SELECT request FROM pending_captures WHERE id = ?").get(id) as { request: string } | undefined;
			if (existing && existing.request !== request) throw new Error("Pending capture identity reused with different content");
			this.store.sqlite.prepare("INSERT OR IGNORE INTO pending_captures (id, skin_id, request) VALUES (?, ?, ?)")
				.run(id, skinId, request);
			return { degraded: false, turnId: capture.turn.turnId, committed: false, accepted: true };
		}
		if (method === "getRecall" && !this.modelReady) {
			const cause = this.modelPreparationError ?? "model-preparing";
			if (parseInput("getRecall", raw).options.source === "manual") {
				return { degraded: true, reason: "engine-failed", error: cause, recallId: "", contextText: "" };
			}
			return { degraded: false, recallId: "", contextText: "", memoryIds: [], unavailable: cause };
		}
		if (method === "inspect" && parseInput("inspect", raw).op.op === "storage") {
			this.counters.storeAccesses++;
			return { degraded: false, result: { op: "storage", dimension: readChunkVecTableState(this.store.sqlite)?.dimension ?? null, failed: false } };
		}
		if (method === "init") {
			const init = parseInput("init", raw);
			this.counters.engineAccesses++;
			this.counters.storeAccesses++;
			return this.register(init.scope, { ...init.registration, skinId });
		}
		let entry = this.skins.get(skinId);
		if (!entry) {
			// A coding-skin hook can arrive before its worker's init; register it as that skin, never as the default.
			await this.register(input.scope, { skinId });
			entry = this.skins.get(skinId);
		}
		if (!entry) throw new Error("memory.skin.registration.failed");
		signal?.throwIfAborted();
		entry.active++;
		this.counters.engineAccesses++;
		this.counters.storeAccesses++;
		const responses: ProviderResponseTrace[] = [];
		const uuid = await this.observeSessionFor(entry, input.scope);
		const scope: ScopeCtx = { ...input.scope, host: { ...input.scope.host, observeSessionUuid: uuid } };
		const body = { ...(raw as object), scope };
		try {
			const call = () => observeSession.run({ uuid, entry }, () => withProviderResponses(responses, () => this.call(entry, method, body, signal)));
			const result = parseOutput(method, await entry.agentPort.run(call, method === "capture"));
			if (method === "onSessionEnd") {
				// Usage from the closing call must be tallied before the session's cost is summed.
				await this.emitProviderUsage(entry, scope, responses.splice(0));
				await this.snapshot(entry, "session_end", uuid);
				await this.forwardTelemetry(entry, uuid);
				entry.observability.trackBestEffort("observe ledger", async () => {
					await forwardObserveLedger({
						profileDir: getSnoProfileDir(), observe: entry.observability,
					});
				});
				await this.endOwnedSession(entry, scope);
			}
			return result;
		}
		finally {
			await this.emitProviderUsage(entry, scope, responses);
			// A host-named session's skin owns cost.summary; the sidecar's tallies for it are never read.
			const session = input.scope.host?.observeSessionUuid;
			if (session) { this.observability.aggregator.delete(session); entry.observability.aggregator.delete(session); }
			entry.active--; if (entry.retired && entry.active === 0) await this.dispose(entry);
		}
	}

	/** The observe session of this call: the host's, or the one this sidecar named for the host session (emitting session.start once). */
	private async observeSessionFor(entry: SkinRuntime, scope: ScopeCtx): Promise<string> {
		if (scope.host?.observeSessionUuid) return scope.host.observeSessionUuid;
		const hostSessionId = scope.host?.sessionId ?? scope.session;
		const known = entry.hostSessions.get(hostSessionId);
		if (known) return known.uuid;
		const started = { uuid: createUUIDv7(), startedAt: Date.now() };
		entry.hostSessions.set(hostSessionId, started);
		entry.observability.aggregator.start(started.uuid);
		await entry.observability.emit({ eventType: "session.start", sessionUuid: started.uuid, payload: { session_uuid: started.uuid } });
		return started.uuid;
	}

	private async endOwnedSession(entry: SkinRuntime, scope: ScopeCtx): Promise<void> {
		const hostSessionId = scope.host?.sessionId ?? scope.session;
		const owned = entry.hostSessions.get(hostSessionId);
		if (!owned) return;
		entry.hostSessions.delete(hostSessionId);
		await entry.observability.emit({ eventType: "session.end", sessionUuid: owned.uuid,
			payload: { session_uuid: owned.uuid, duration_ms: Date.now() - owned.startedAt } });
		await entry.observability.emit({ eventType: "cost.summary", sessionUuid: owned.uuid,
			payload: entry.observability.aggregator.summaryAndDelete(owned.uuid) });
		await entry.observability.flush({ force: true, timeoutMs: SNO_OBSERVE_FLUSH_TIMEOUT_MS });
	}

	private async call(entry: SkinRuntime, method: Exclude<ContractMethod, "init">, raw: unknown, signal?: AbortSignal): Promise<ContractOutputs[ContractMethod]> {
		signal?.throwIfAborted();
		const runtime = entry.runtime;
		switch (method) {
			case "hostEvent": { const p = parseInput(method, raw); return runtime.hostEvent(p.event, p.scope); }
			case "capture": { const p = parseInput(method, raw); return runtime.capture(p.turn, p.scope, signal); }
			case "getRecall": { const p = parseInput(method, raw); return runtime.getRecall(p.query, p.scope, p.options, signal); }
			case "mutate": { const p = parseInput(method, raw); return runtime.mutate(p.op, p.scope, signal); }
			case "inspect": { const p = parseInput(method, raw); return runtime.inspect(p.op, p.scope); }
			case "recordUsage": { const p = parseInput(method, raw); return runtime.recordUsage(p.recallId, p.signal, p.scope); }
			case "onSessionEnd": { const p = parseInput(method, raw); return runtime.onSessionEnd(p.messages, p.scope, signal); }
			case "staticBlock": { const p = parseInput(method, raw); return runtime.staticBlock(p.scope); }
		}
	}

	private async emitProviderUsage(entry: SkinRuntime, scope: ScopeCtx, responses: ProviderResponseTrace[]): Promise<void> {
		if (!scope.host?.observeSessionUuid || responses.length === 0) return;
		await bestEffort("provider usage", async () => {
			for (const response of responses) {
				if (response.failure) {
					await entry.observability.emitError(`llm.call:${response.failure}`, `${response.provider} ${response.callId}`, scope.host?.observeSessionUuid);
					continue;
				}
				// A response without a model or usage is an error, never a zero-token call.
				if (!response.usage || !response.model) {
					await entry.observability.emitError("llm.call:usage_missing", `${response.provider} ${response.callId}`, scope.host?.observeSessionUuid);
					continue;
				}
				await entry.observability.emit({ eventType: "llm.call", sessionUuid: scope.host?.observeSessionUuid,
					payload: { call_id: response.callId, destination: response.destination, model: `${response.provider}:${response.model}`, prompt_tokens: response.usage.inputTokens,
						completion_tokens: response.usage.outputTokens, token_source: "plugin_internal_paid",
						latency_ms: Math.max(0, Math.round(response.durationMs ?? 0)), cache_read_tokens: 0, cache_write_tokens: 0 } });
			}
			if (responses.length) await entry.observability.flush({ force: true, timeoutMs: 5_000 });
		});
	}

	/** The local memory event rows written since the last sync go up as `memory.telemetry` batches. */
	private async forwardTelemetry(entry: SkinRuntime, sessionUuid: string): Promise<void> {
		await entry.observability.trackBestEffort("memory telemetry", async () => {
			const result = await forwardMemoryTelemetryToObserve({
				sqlite: this.store.sqlite,
				observe: { tryEmit: (input) => entry.observability.tryEmit({ ...input, sessionUuid }) },
			});
			if (result.status === "failed") throw new Error("memory telemetry forward failed");
		});
	}

	private async snapshot(entry: SkinRuntime, reason: SnapshotReason, sessionUuid: string | undefined): Promise<void> {
		const payload = await readMemorySnapshotPayload(this.storePath, this.config, sessionUuid ?? createUUIDv7(), reason, this.store.sqlite);
		await entry.observability.emit({ eventType: "memory.snapshot", sessionUuid, payload });
	}

	private async dispose(entry: SkinRuntime): Promise<void> {
		if (!this.owned.delete(entry)) return;
		await entry.runtime.close();
		await entry.tracker.destroy();
		await entry.embedder.dispose();
		await entry.observability.shutdown();
	}

	private startUsageTimer(): void {
		this.usageTimer = setInterval(() => {
			if (this.usageFlush) return;
			this.usageFlush = this.usageOutbox.flushPendingAsync().catch((error: unknown) => {
				log.warn("Memory usage delivery failed", { error }, {
					event_name: "memory.sidecar.usage.failed", file: "packages/memory/src/sidecar/memory-runtime.ts",
					function: "<anonymous callback>", site_id: "memory.sidecar.usage.failed",
				});
			}).finally(() => { this.usageFlush = undefined; });
		}, MEMORY_USAGE_FLUSH_INTERVAL_MS);
		this.usageTimer.unref();
	}

	stopTimers(): void {
		this.maintenance?.stop();
		if (this.usageTimer) clearInterval(this.usageTimer);
	}

	async close(): Promise<void> {
		this.stopTimers();
		await this.modelPreparation?.catch(() => undefined);
		for (const entry of this.owned) await this.dispose(entry);
		this.skins.clear();
		await this.usageFlush;
		await this.store.close();
		await this.embedder.dispose();
		await this.observability.shutdown();
	}
}
