import { createUUIDv7, isCuid2 } from "@snoai/common-core";
import { verifyAuditEvent } from "./audit-verify.js";
import { BufferStore } from "./buffer-store.js";
import { ConsentStore } from "./consent.js";
import { type ClaimOptions, type ClaimResult, claimMachine } from "./device-claim.js";
import { createDoctorReport } from "./doctor.js";
import {
	BufferCapacityError,
	ChainSeedError,
	ChainUnavailableError,
	InvalidEventPayloadError,
} from "./errors.js";
import { type ExportOptions, exportEvents } from "./export.js";
import { type DrainResult, FlushEngine, type FlushResult, SCHEDULE_FLUSH_DELAY_MS } from "./flush.js";
import { sha256Hex } from "./hash.js";
import { normalizeBaseUrl } from "./http.js";
import { bootstrapIdentity } from "./identity.js";
import { logger } from "./log.js";
import {
	type RegisterOptions,
	type RegisterResult,
	registerMachine,
} from "./machine-registration.js";
import { AsyncMutex } from "./mutex.js";
import { getBufferPath, getRedactionRulesPath, type PathEnv } from "./paths.js";
import { redactEventPayload, redactScope } from "./redact.js";
import { shouldSampleTool } from "./sampling.js";
import { parseConsentValue } from "./schemas.js";
import {
	type AgentId,
	type AuditVerifyResult,
	type ConsentValue,
	type DoctorReport,
	type EmitResult,
	type EventLane,
	type EventScope,
	type EventType,
	type ExportResult,
	type Identity,
	type JsonObject,
	type ParsedEvent,
	SDK_VERSION,
	type ShutdownResult,
	type SubscribeEvent,
	type Subscription,
} from "./types.js";

export interface RuntimeOptions {
	cwd?: string;
	env?: PathEnv & Record<string, string | undefined>;
	fetch?: typeof fetch;
	agentVersion?: string;
	cliVersion?: string;
	pluginVersion?: string;
}

export class SnoObserveRuntime {
	private store: BufferStore | null = null;
	private storePath: string | null = null;
	private flushEngine: FlushEngine | null = null;
	private consentStoreCache: ConsentStore | null = null;
	private consentStoreEnv: PathEnv | null = null;
	private readonly mutex = new AsyncMutex();
	private readonly listeners = new Set<Subscription>();

	constructor(private readonly options: RuntimeOptions = {}) {}

	emitParsed(parsed: ParsedEvent): Promise<EmitResult> {
		const eventId = parsed.eventId ?? createUUIDv7();
		if (parsed.eventType === "tool.call") {
			const payload = parsed.payload as JsonObject & { tool_name?: unknown };
			const toolName = String(payload.tool_name);
			if (!shouldSampleTool(eventId, toolName, 20, this.env())) {
				const result: EmitResult = { accepted: false, eventId, reason: "tool_unsampled" };
				this.notify(parsed.eventType, result);
				return Promise.resolve(result);
			}
		}
		return this.mutex.runExclusive(async () => {
			const identity = bootstrapIdentity(this.env());
			const consent = this.consentStore().get();
			const store = this.getStore();
			store.pruneRetention();
			const safeguard = store.getAdmissionSafeguard(identity.machine_uuid, parsed.agentId);
			if (safeguard !== null) {
				const stats = store.getQueueStats();
				logger.errorRateLimited(`buffer-safeguard:${safeguard}`, "sno observe buffer safeguard active", {
					safeguard,
					queue_depth: stats.pendingCount,
					oldest_age_ms: stats.oldestPendingAgeMs,
					retry_count: stats.maxAttempts,
					quarantined_count: stats.quarantinedCount,
					database_size_bytes: stats.databaseSizeBytes,
				}, {
					event_name: "sno.observe.internal.runtime.emitparsed",
					file: "packages/sno-observe/src/internal/runtime.ts",
					function: "emitParsed",
					site_id: "sno.observe.internal.runtime.emitparsed.1",
				});
				const result: EmitResult = { accepted: false, eventId, reason: "buffer_safeguard" };
				this.notify(parsed.eventType, result);
				this.getFlushEngine().schedule(SCHEDULE_FLUSH_DELAY_MS);
				return result;
			}
			let chainEpoch = store.getCurrentEpoch(identity.machine_uuid, parsed.agentId);
			const recoveryState = store.getChainRecoveryState(
				identity.machine_uuid,
				parsed.agentId,
				chainEpoch,
			);
			if (recoveryState === "retired") {
				const result: EmitResult = { accepted: false, eventId, reason: "chain_retired" };
				this.notify(parsed.eventType, result);
				return result;
			}
			if (recoveryState === "reseed_required") {
				chainEpoch = store.nextEpoch(identity.machine_uuid, parsed.agentId);
				if (parsed.eventType !== "agent.identify") {
					this.ensureAgentIdentify(identity, parsed.agentId, parsed.lane, consent, chainEpoch);
					chainEpoch = store.getCurrentEpoch(identity.machine_uuid, parsed.agentId);
				}
			}
			if (
				recoveryState === null &&
				parsed.eventType !== "agent.identify" &&
				!store.hasTail(identity.machine_uuid, parsed.agentId, chainEpoch)
			) {
				this.ensureAgentIdentify(identity, parsed.agentId, parsed.lane, consent, chainEpoch);
			}
			const terminal = consent === "off" && parsed.eventType !== "consent.change";
			const appended = this.appendPrepared({
				identity,
				agentId: parsed.agentId,
				eventId,
				eventType: parsed.eventType,
				lane: parsed.lane,
				tsEdgeMs: parsed.tsEdgeMs ?? Date.now(),
				consent,
				payload: parsed.payload,
				scope: parsed.scope,
				chainEpoch,
				terminal,
			});
			const result: EmitResult = {
				accepted: !terminal,
				eventId,
				rowid: appended.rowid,
				seq: appended.seq,
				chainEpoch: appended.chainEpoch,
			};
			if (terminal) {
				result.reason = "consent_off";
			}
			this.notify(parsed.eventType, result);
			if (!terminal) {
				this.scheduleFlush();
			}
			return result;
		}).catch((error: unknown) => {
			if (error instanceof BufferCapacityError) {
				const result: EmitResult = { accepted: false, eventId, reason: "buffer_safeguard" };
				this.notify(parsed.eventType, result);
				return result;
			}
			if (error instanceof ChainUnavailableError) {
				const result: EmitResult = { accepted: false, eventId, reason: "chain_retired" };
				this.notify(parsed.eventType, result);
				return result;
			}
			throw error;
		});
	}

	private ensureAgentIdentify(
		identity: Identity,
		agentId: AgentId,
		lane: EventLane,
		consent: ConsentValue,
		chainEpoch: number,
	): void {
		try {
			this.appendPrepared({
				identity,
				agentId,
				eventId: createUUIDv7(),
				eventType: "agent.identify",
				lane,
				tsEdgeMs: Date.now(),
				consent,
				payload: agentIdentifyPayload(identity, agentId, {}, this.options),
				scope: {},
				chainEpoch,
				terminal: consent === "off",
			});
		} catch (error) {
			if (!(error instanceof ChainSeedError)) {
				throw error;
			}
		}
	}

	async flush(
		options: boolean | { force?: boolean; signal?: AbortSignal } = true,
	): Promise<FlushResult> {
		const force = typeof options === "boolean" ? options : (options.force ?? true);
		const signal = typeof options === "boolean" ? undefined : options.signal;
		const identity = bootstrapIdentity(this.env());
		const flushOptions = {
			identity,
			env: this.env(),
			force,
			...(signal === undefined ? {} : { signal }),
		};
		return this.getFlushEngine().flush(
			this.options.fetch === undefined
				? flushOptions
				: { ...flushOptions, fetch: this.options.fetch },
		);
	}

	async drain(): Promise<DrainResult> {
		return this.getFlushEngine().drain();
	}

	async setConsent(value: string, reason = "user changed in SDK"): Promise<ConsentValue> {
		const next = parseConsentValue(value);
		return this.mutex.runExclusive(() => this.setConsentLocked(next, reason));
	}

	private async setConsentLocked(next: ConsentValue, reason: string): Promise<ConsentValue> {
		const consentStore = this.consentStore();
		const current = consentStore.get();
		if (current === next) {
			return current;
		}
		const identity = bootstrapIdentity(this.env());
		const store = this.getStore();
		const agents = this.agentsForConsentTransition(store);
		if (current === "off" && next !== "off") {
			this.persistConsent(consentStore, next);
			this.appendResumeFromOff(identity, store, agents, current, next, reason);
			this.scheduleFlush();
			return next;
		}
		this.appendConsentChangeBeforeRotation(identity, store, agents, current, next, reason);
		this.persistConsent(consentStore, next);
		this.appendPostTransitionIdentify(identity, store, agents, next);
		if (current !== "off") {
			await this.flushConsentTransition();
		}
		if (next !== "off") {
			this.scheduleFlush();
		}
		return next;
	}

	private agentsForConsentTransition(store: BufferStore): AgentId[] {
		const agents = uniqueAgents(store.listAgents());
		return agents.length === 0 ? ["codex"] : agents;
	}

	private persistConsent(consentStore: ConsentStore, next: ConsentValue): void {
		consentStore.write(next);
		this.consentStoreCache = null;
		this.consentStoreEnv = null;
	}

	private appendResumeFromOff(
		identity: Identity,
		store: BufferStore,
		agents: AgentId[],
		current: ConsentValue,
		next: ConsentValue,
		reason: string,
	): void {
		for (const agentId of agents) {
			const chainEpoch = store.nextEpoch(identity.machine_uuid, agentId);
			this.appendAgentIdentify(identity, agentId, chainEpoch, next, false);
			this.appendConsentChange(identity, agentId, chainEpoch, next, current, next, reason);
		}
	}

	private appendConsentChangeBeforeRotation(
		identity: Identity,
		store: BufferStore,
		agents: AgentId[],
		current: ConsentValue,
		next: ConsentValue,
		reason: string,
	): void {
		for (const agentId of agents) {
			const currentEpoch = store.getCurrentEpoch(identity.machine_uuid, agentId);
			if (!store.hasTail(identity.machine_uuid, agentId, currentEpoch)) {
				this.appendAgentIdentify(identity, agentId, currentEpoch, current, current === "off");
			}
			this.appendConsentChange(identity, agentId, currentEpoch, current, current, next, reason);
		}
	}

	private appendPostTransitionIdentify(
		identity: Identity,
		store: BufferStore,
		agents: AgentId[],
		next: ConsentValue,
	): void {
		for (const agentId of agents) {
			const chainEpoch = store.nextEpoch(identity.machine_uuid, agentId);
			this.appendAgentIdentify(identity, agentId, chainEpoch, next, next === "off");
		}
	}

	private appendAgentIdentify(
		identity: Identity,
		agentId: AgentId,
		chainEpoch: number,
		consent: ConsentValue,
		terminal: boolean,
	): void {
		this.appendPrepared({
			identity,
			agentId,
			eventId: createUUIDv7(),
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: Date.now(),
			consent,
			payload: agentIdentifyPayload(identity, agentId, {}, this.options),
			scope: {},
			chainEpoch,
			terminal,
		});
	}

	private appendConsentChange(
		identity: Identity,
		agentId: AgentId,
		chainEpoch: number,
		consent: ConsentValue,
		from: ConsentValue,
		to: ConsentValue,
		reason: string,
	): void {
		this.appendPrepared({
			identity,
			agentId,
			eventId: createUUIDv7(),
			eventType: "consent.change",
			lane: "memory",
			tsEdgeMs: Date.now(),
			consent,
			payload: { from, to, reason },
			scope: {},
			chainEpoch,
			terminal: false,
		});
	}

	getConsent(): ConsentValue {
		return this.consentStore().get();
	}

	hashRedactedText(input: string): string {
		const result = redactEventPayload({ value: input }, "full", getRedactionRulesPath(this.env()));
		const redacted = (result.value as { value?: unknown }).value;
		const text = typeof redacted === "string" ? redacted : String(redacted);
		return sha256Hex(Buffer.from(text, "utf8"));
	}

	async pause(): Promise<ConsentValue> {
		return this.mutex.runExclusive(async () => {
			const store = this.consentStore();
			const current = store.get();
			if (current === "off") {
				return current;
			}
			store.writePausedPrior(current);
			return this.setConsentLocked("off", "observe.pause");
		});
	}

	async resume(): Promise<ConsentValue> {
		return this.mutex.runExclusive(async () => {
			const store = this.consentStore();
			const prior = store.getPausedPrior() ?? "metadata-only";
			const result = await this.setConsentLocked(prior, "observe.resume");
			store.clearPausedPrior();
			return result;
		});
	}

	export(options: ExportOptions = {}): ExportResult {
		return exportEvents(this.getStore(), options);
	}

	subscribe(listener: Subscription): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	doctor(): DoctorReport {
		return createDoctorReport(this.env());
	}

	register(options: RegisterOptions = {}): Promise<RegisterResult> {
		const identity = bootstrapIdentity(this.env());
		const registerOptions: RegisterOptions = {
			...options,
			baseUrl: options.baseUrl ?? this.baseUrl(),
			env: options.env ?? this.env(),
		};
		const fetchImpl = options.fetch ?? this.options.fetch;
		if (fetchImpl !== undefined) {
			registerOptions.fetch = fetchImpl;
		}
		return registerMachine(identity, registerOptions);
	}

	claim(options: ClaimOptions = {}): Promise<ClaimResult> {
		const identity = bootstrapIdentity(this.env());
		const claimOptions: ClaimOptions = {
			...options,
			baseUrl: options.baseUrl ?? this.baseUrl(),
			env: options.env ?? this.env(),
		};
		const fetchImpl = options.fetch ?? this.options.fetch;
		if (fetchImpl !== undefined) {
			claimOptions.fetch = fetchImpl;
		}
		return claimMachine(identity, claimOptions);
	}

	async verifyAudit(eventId: string): Promise<AuditVerifyResult> {
		const identity = bootstrapIdentity(this.env());
		const baseUrl = this.baseUrl();
		const fetchImpl = this.options.fetch;
		const registerOptions: RegisterOptions = {
			baseUrl,
			env: this.env(),
			...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
		};
		await registerMachine(identity, registerOptions);
		return verifyAuditEvent(eventId, {
			baseUrl,
			machineSecret: identity.machine_secret,
			...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
		});
	}

	async shutdown(): Promise<ShutdownResult> {
		return this.mutex.runExclusive(async () => {
			const result: ShutdownResult = { flushedCount: 0, failedCount: 0 };
			if (this.store !== null) {
				try {
					const drainResult = await this.getFlushEngine().drain();
					result.flushedCount += drainResult.flushedCount;
					result.failedCount += drainResult.failedCount;
					if (drainResult.lastError !== undefined) {
						result.lastError = drainResult.lastError;
					}
				} catch (error) {
					result.failedCount += this.store.countPending();
					result.lastError = errorMessage(error);
					logger.error("sno observe shutdown flush failed", { error: result.lastError }, {
						event_name: "sno.observe.internal.runtime.shutdown",
						file: "packages/sno-observe/src/internal/runtime.ts",
						function: "shutdown",
						site_id: "sno.observe.internal.runtime.shutdown.2",
					});
				}
				this.flushEngine?.dispose();
			}
			this.store?.close();
			this.store = null;
			this.storePath = null;
			this.flushEngine = null;
			return result;
		}).finally(() => logger.flushSuppressed());
	}

	private appendPrepared(input: {
		identity: Identity;
		agentId: AgentId;
		eventId: string;
		eventType: EventType;
		lane: EventLane;
		tsEdgeMs: number;
		consent: ConsentValue;
		payload: JsonObject;
		scope: JsonObject;
		chainEpoch: number;
		terminal: boolean;
	}) {
		rejectRawContent(input.eventType, input.payload, input.consent);
		const payload = normalizeSystemPayload({ ...input, options: this.options });
		const callerScope = stripCallerAccountScope(input.scope);
		const accountScope =
			typeof input.identity.user_account_id === "string" && isCuid2(input.identity.user_account_id)
				? { user_account_id: input.identity.user_account_id }
				: {};
		const scope: EventScope = {
			...callerScope,
			...accountScope,
			user_id: input.identity.user_cuid,
			machine_id: input.identity.machine_uuid,
			agent_id: input.agentId,
		};
		const redactionRulesPath = getRedactionRulesPath(this.env());
		const redactedScope = redactScope(scope, redactionRulesPath);
		const redactedPayload = redactEventPayload(payload, input.consent, redactionRulesPath);
		return this.getStore().append({
			eventId: input.eventId,
			eventType: input.eventType,
			lane: input.lane,
			tsEdgeMs: input.tsEdgeMs,
			consentLevel: input.consent,
			redacted: redactedScope.redacted || redactedPayload.redacted,
			scope: redactedScope.value as EventScope,
			payload: redactedPayload.value,
			terminal: input.terminal,
			chainEpoch: input.chainEpoch,
		});
	}

	private scheduleFlush(): void {
		const store = this.getStore();
		if (store.countPending() >= 50) {
			this.flushInBackground();
			return;
		}
		this.getFlushEngine().schedule(SCHEDULE_FLUSH_DELAY_MS);
	}

	private async flushConsentTransition(): Promise<void> {
		try {
			const result = await this.flush(true);
			if (result.retryable > 0 || result.terminal > 0) {
				logger.warn("sno observe consent transition flush incomplete", {
					retryable: result.retryable,
					terminal: result.terminal,
				}, {
					event_name: "sno.observe.internal.runtime.flushconsenttransition",
					file: "packages/sno-observe/src/internal/runtime.ts",
					function: "flushConsentTransition",
					site_id: "sno.observe.internal.runtime.flushconsenttransition.3",
				});
			}
		} catch (error) {
			logger.error("sno observe consent transition flush failed", { error }, {
				event_name: "sno.observe.internal.runtime.flushconsenttransition",
				file: "packages/sno-observe/src/internal/runtime.ts",
				function: "flushConsentTransition",
				site_id: "sno.observe.internal.runtime.flushconsenttransition.4",
			});
		}
	}

	private flushInBackground(): void {
		void this.flush(false).catch((error) => {
			logger.error("sno observe background flush failed", { error }, {
				event_name: "sno.observe.internal.runtime.flushinbackground",
				file: "packages/sno-observe/src/internal/runtime.ts",
				function: "flushInBackground",
				site_id: "sno.observe.internal.runtime.flushinbackground.5",
			});
		});
	}

	private getFlushEngine(): FlushEngine {
		if (this.flushEngine === null) {
			this.flushEngine = new FlushEngine(
				this.getStore(),
				() => bootstrapIdentity(this.env()),
				() => this.baseUrl(),
				() => this.env(),
				() => this.options.fetch,
			);
		}
		return this.flushEngine;
	}

	private getStore(): BufferStore {
		const path = getBufferPath(this.env());
		if (this.store === null || this.storePath !== path) {
			this.flushEngine?.dispose();
			this.store?.close();
			this.store = new BufferStore(path);
			this.storePath = path;
			this.flushEngine = null;
		}
		return this.store;
	}

	private consentStore(): ConsentStore {
		const env = this.env();
		if (this.consentStoreCache === null || this.consentStoreEnv !== env) {
			this.consentStoreCache = new ConsentStore(env);
			this.consentStoreEnv = env;
		}
		return this.consentStoreCache;
	}

	private env(): PathEnv & Record<string, string | undefined> {
		return this.options.env ?? process.env;
	}

	private baseUrl(): string {
		const env = this.env();
		return normalizeBaseUrl(env.SNO_OBSERVE_BASE_URL ?? "https://www.sno.ai");
	}

	private notify(eventType: EventType, result: EmitResult): void {
		const event: SubscribeEvent = {
			eventId: result.eventId,
			eventType,
			accepted: result.accepted,
			reason: result.reason,
		};
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("sno observe subscriber failed", {
					error,
					event_type: eventType,
				}, {
					event_name: "sno.observe.internal.runtime.notify",
					file: "packages/sno-observe/src/internal/runtime.ts",
					function: "notify",
					site_id: "sno.observe.internal.runtime.notify.6",
				});
			}
		}
	}
}

function stripCallerAccountScope(scope: JsonObject): JsonObject {
	const sanitized: JsonObject = {};
	for (const [key, value] of Object.entries(scope)) {
		if (key !== "user_account_id") {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function rejectRawContent(eventType: EventType, payload: JsonObject, consent: ConsentValue): void {
	if (consent === "full") {
		return;
	}
	const fields = payload as JsonObject & { message?: unknown; prompt_text?: unknown };
	if (eventType === "prompt.submit" && typeof fields.prompt_text === "string") {
		throw new InvalidEventPayloadError("prompt_text is only allowed when consent_level is full");
	}
	if (eventType === "error" && typeof fields.message === "string") {
		throw new InvalidEventPayloadError("message is only allowed when consent_level is full");
	}
}

function normalizeSystemPayload(input: {
	eventType: EventType;
	payload: JsonObject;
	agentId: AgentId;
	identity: Identity;
	options: RuntimeOptions;
}): JsonObject {
	if (input.eventType !== "agent.identify") {
		return input.payload;
	}
	return agentIdentifyPayload(input.identity, input.agentId, input.payload, input.options);
}

function agentIdentifyPayload(
	identity: Identity,
	agentId: AgentId,
	payload: JsonObject = {},
	options: RuntimeOptions = {},
): JsonObject {
	const agentVersion =
		optionalString(payload["agent_version"]) ?? optionalString(options.agentVersion);
	const cliVersion = optionalString(payload["cli_version"]) ?? optionalString(options.cliVersion);
	const pluginVersion =
		optionalString(payload["plugin_version"]) ?? optionalString(options.pluginVersion);
	return {
		agent_id: agentId,
		machine_id: identity.machine_uuid,
		...(agentVersion ? { agent_version: agentVersion } : {}),
		...(cliVersion ? { cli_version: cliVersion } : {}),
		...(pluginVersion ? { plugin_version: pluginVersion } : {}),
		sdk_version: SDK_VERSION,
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueAgents(values: AgentId[]): AgentId[] {
	return [...new Set(values)];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
