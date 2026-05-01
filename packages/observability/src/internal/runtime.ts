import { v7 as uuidv7 } from "uuid";
import { BufferStore } from "./buffer-store.js";
import { ConsentStore } from "./consent.js";
import { type RegisterOptions, type RegisterResult, registerDevice } from "./device-flow.js";
import { createDoctorReport } from "./doctor.js";
import { InvalidEventPayloadError } from "./errors.js";
import { type ExportOptions, exportEvents } from "./export.js";
import { FlushEngine, type FlushResult } from "./flush.js";
import { normalizeBaseUrl } from "./http.js";
import { bootstrapIdentity } from "./identity.js";
import { AsyncMutex } from "./mutex.js";
import { getBufferPath, getRedactionRulesPath, type PathEnv } from "./paths.js";
import { detectProjectId } from "./project-id.js";
import { redactEventPayload, redactScope } from "./redact.js";
import { shouldSampleTool } from "./sampling.js";
import { parseConsentValue } from "./schemas.js";
import {
	type AgentId,
	type ConsentValue,
	type DoctorReport,
	type EmitResult,
	type EventScope,
	type EventType,
	type ExportResult,
	type Identity,
	type JsonObject,
	type ParsedEvent,
	SDK_VERSION,
	type SubscribeEvent,
	type Subscription,
} from "./types.js";

export interface RuntimeOptions {
	cwd?: string;
	env?: PathEnv & Record<string, string | undefined>;
	fetch?: typeof fetch;
}

export class SnoObserveRuntime {
	private store: BufferStore | null = null;
	private storePath: string | null = null;
	private flushEngine: FlushEngine | null = null;
	private readonly mutex = new AsyncMutex();
	private readonly listeners = new Set<Subscription>();

	constructor(private readonly options: RuntimeOptions = {}) {}

	emitParsed(parsed: ParsedEvent): Promise<EmitResult> {
		const eventId = parsed.eventId ?? uuidv7();
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
			const consent = parsed.consentLevel ?? this.consentStore().get();
			const store = this.getStore();
			const chainEpoch = store.getCurrentEpoch(identity.machine_uuid, parsed.agentId);
			if (
				parsed.eventType !== "agent.identify" &&
				!store.hasTail(identity.machine_uuid, parsed.agentId, chainEpoch)
			) {
				this.appendPrepared({
					identity,
					agentId: parsed.agentId,
					eventId: uuidv7(),
					eventType: "agent.identify",
					tsEdgeMs: Date.now(),
					consent,
					payload: {
						agent_id: parsed.agentId,
						machine_id: identity.machine_uuid,
						sdk_version: SDK_VERSION,
					},
					scope: {},
					chainEpoch,
					terminal: consent === "off",
				});
			}
			const terminal = consent === "off" && parsed.eventType !== "consent.change";
			const appended = this.appendPrepared({
				identity,
				agentId: parsed.agentId,
				eventId,
				eventType: parsed.eventType,
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
		});
	}

	async flush(force = true): Promise<FlushResult> {
		const identity = bootstrapIdentity(this.env());
		const options = {
			identity,
			env: this.env(),
			force,
		};
		return this.getFlushEngine().flush(
			this.options.fetch === undefined ? options : { ...options, fetch: this.options.fetch },
		);
	}

	async setConsent(value: string, reason = "user changed in SDK"): Promise<ConsentValue> {
		const next = parseConsentValue(value);
		return this.mutex.runExclusive(async () => {
			const consentStore = this.consentStore();
			const current = consentStore.get();
			if (current === next) {
				return current;
			}
			const identity = bootstrapIdentity(this.env());
			const store = this.getStore();
			const agents = uniqueAgents(store.listAgents());
			if (agents.length === 0) {
				agents.push("codex");
			}
			for (const agentId of agents) {
				const currentEpoch = store.getCurrentEpoch(identity.machine_uuid, agentId);
				if (!store.hasTail(identity.machine_uuid, agentId, currentEpoch)) {
					this.appendPrepared({
						identity,
						agentId,
						eventId: uuidv7(),
						eventType: "agent.identify",
						tsEdgeMs: Date.now(),
						consent: current,
						payload: {
							agent_id: agentId,
							machine_id: identity.machine_uuid,
							sdk_version: SDK_VERSION,
						},
						scope: {},
						chainEpoch: currentEpoch,
						terminal: current === "off",
					});
				}
				this.appendPrepared({
					identity,
					agentId,
					eventId: uuidv7(),
					eventType: "consent.change",
					tsEdgeMs: Date.now(),
					consent: current,
					payload: { from: current, to: next, reason },
					scope: {},
					chainEpoch: currentEpoch,
					terminal: false,
				});
			}
			if (current !== "off") {
				await this.flush(true);
			}
			consentStore.write(next);
			for (const agentId of agents) {
				const chainEpoch = store.nextEpoch(identity.machine_uuid, agentId);
				this.appendPrepared({
					identity,
					agentId,
					eventId: uuidv7(),
					eventType: "agent.identify",
					tsEdgeMs: Date.now(),
					consent: next,
					payload: {
						agent_id: agentId,
						machine_id: identity.machine_uuid,
						sdk_version: SDK_VERSION,
					},
					scope: {},
					chainEpoch,
					terminal: next === "off",
				});
			}
			if (next !== "off") {
				this.scheduleFlush();
			}
			return next;
		});
	}

	getConsent(): ConsentValue {
		return this.consentStore().get();
	}

	async pause(): Promise<ConsentValue> {
		const store = this.consentStore();
		const current = store.get();
		if (current !== "off") {
			store.writePausedPrior(current);
			return this.setConsent("off", "observe.pause");
		}
		return current;
	}

	async resume(): Promise<ConsentValue> {
		const store = this.consentStore();
		const prior = store.getPausedPrior() ?? "metadata-only";
		store.clearPausedPrior();
		return this.setConsent(prior, "observe.resume");
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
		return registerDevice(identity, registerOptions);
	}

	async shutdown(): Promise<void> {
		if (this.store !== null) {
			await this.flush(true);
			// Drain any background flush (e.g. fire-and-forget from emitParsed) before closing the DB.
			await this.flushEngine?.drain();
			this.flushEngine?.dispose();
		}
		this.store?.close();
		this.store = null;
		this.storePath = null;
		this.flushEngine = null;
	}

	private appendPrepared(input: {
		identity: Identity;
		agentId: AgentId;
		eventId: string;
		eventType: EventType;
		tsEdgeMs: number;
		consent: ConsentValue;
		payload: JsonObject;
		scope: JsonObject;
		chainEpoch: number;
		terminal: boolean;
	}) {
		rejectRawContent(input.eventType, input.payload, input.consent);
		const payload = normalizeSystemPayload(input);
		const projectId = detectProjectId(this.options.cwd ?? process.cwd(), this.env());
		const scope: EventScope = {
			...input.scope,
			user_id: input.identity.user_cuid,
			machine_id: input.identity.machine_uuid,
			agent_id: input.agentId,
			project_id: projectId,
		};
		const redactionRulesPath = getRedactionRulesPath(this.env());
		const redactedScope = redactScope(scope, redactionRulesPath);
		const redactedPayload = redactEventPayload(payload, input.consent, redactionRulesPath);
		return this.getStore().append({
			eventId: input.eventId,
			eventType: input.eventType,
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
			void this.flush(false);
			return;
		}
		this.getFlushEngine().schedule(60_000);
	}

	private getFlushEngine(): FlushEngine {
		if (this.flushEngine === null) {
			this.flushEngine = new FlushEngine(
				this.getStore(),
				() => bootstrapIdentity(this.env()),
				() => this.baseUrl(),
				() => this.env(),
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
		return new ConsentStore(this.env());
	}

	private env(): PathEnv & Record<string, string | undefined> {
		return this.options.env ?? process.env;
	}

	private baseUrl(): string {
		const env = this.env() as PathEnv & { SNO_OBSERVE_BASE_URL?: string };
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
			listener(event);
		}
	}
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
}): JsonObject {
	if (input.eventType !== "agent.identify") {
		return input.payload;
	}
	const payload = input.payload as JsonObject & { agent_version?: unknown };
	const agentVersion =
		typeof payload.agent_version === "string" ? { agent_version: payload.agent_version } : {};
	return {
		agent_id: input.agentId,
		machine_id: input.identity.machine_uuid,
		...agentVersion,
		sdk_version: SDK_VERSION,
	};
}

function uniqueAgents(values: AgentId[]): AgentId[] {
	return [...new Set(values)];
}
