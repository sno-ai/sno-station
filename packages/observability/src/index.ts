import { verifyAuditEvent } from "./internal/audit-verify.js";
import { SnoObserveRuntime } from "./internal/runtime.js";
import { shouldSampleTool as shouldSampleToolInternal } from "./internal/sampling.js";
import { parseEventInput } from "./internal/schemas.js";
import type {
	AgentId,
	AuditVerifyResult,
	ConsentValue,
	DoctorCheck,
	DoctorReport,
	EmitResult,
	Event,
	ExportFormat,
	ExportResult,
	Subscription,
} from "./internal/types.js";

const runtime = new SnoObserveRuntime();

function emit(event: Event): Promise<EmitResult> {
	const parsed = parseEventInput(event);
	return runtime.emitParsed(parsed);
}

function flush(options: { force?: boolean } = {}): Promise<{
	shipped: number;
	terminal: number;
	retryable: number;
}> {
	return runtime.flush(options.force ?? true);
}

const consent = {
	get(): ConsentValue {
		return runtime.getConsent();
	},
	set(value: ConsentValue, reason?: string): Promise<ConsentValue> {
		return runtime.setConsent(value, reason);
	},
};

const observe = {
	pause(): Promise<ConsentValue> {
		return runtime.pause();
	},
	resume(): Promise<ConsentValue> {
		return runtime.resume();
	},
	export(options?: { format?: ExportFormat; path?: string; includeData?: boolean }): ExportResult {
		return runtime.export(options);
	},
};

const audit = {
	verify(eventId: string): Promise<AuditVerifyResult> {
		return verifyAuditEvent(eventId);
	},
};

function register(
	options?: Parameters<SnoObserveRuntime["register"]>[0],
): ReturnType<SnoObserveRuntime["register"]> {
	return runtime.register(options);
}

function doctor(): DoctorReport {
	return runtime.doctor();
}

function shouldSampleTool(eventId: string, toolName?: string, rate?: number): boolean {
	return shouldSampleToolInternal(eventId, toolName, rate);
}

function subscribe(listener: Subscription): () => void {
	return runtime.subscribe(listener);
}

function shutdown(): Promise<void> {
	return runtime.shutdown();
}

export const snoObserve = {
	emit,
	flush,
	consent,
	observe,
	register,
	audit,
	doctor,
	shouldSampleTool,
	subscribe,
	shutdown,
};

export type { AgentId, ConsentValue, DoctorCheck, DoctorReport, Event, ExportFormat };
