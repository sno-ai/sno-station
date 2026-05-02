import { type RuntimeOptions, SnoObserveRuntime } from "./internal/runtime.js";
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
	ShutdownResult,
	Subscription,
} from "./internal/types.js";

function createApi(runtime: SnoObserveRuntime) {
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
		export(options?: {
			format?: ExportFormat;
			path?: string;
			includeData?: boolean;
		}): ExportResult {
			return runtime.export(options);
		},
	};

	const audit = {
		verify(eventId: string): Promise<AuditVerifyResult> {
			return runtime.verifyAudit(eventId);
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

	function shutdown(): Promise<ShutdownResult> {
		return runtime.shutdown();
	}

	return {
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
}

export function createSnoObserve(options: RuntimeOptions = {}) {
	return createApi(new SnoObserveRuntime(options));
}

type SnoObserveApi = ReturnType<typeof createSnoObserve>;

const SNO_OBSERVE_KEYS = [
	"emit",
	"flush",
	"consent",
	"observe",
	"register",
	"audit",
	"doctor",
	"shouldSampleTool",
	"subscribe",
	"shutdown",
] as const satisfies ReadonlyArray<keyof SnoObserveApi>;

let defaultObserve: SnoObserveApi | undefined;
const SNO_OBSERVE_KEY_SET: ReadonlySet<PropertyKey> = new Set(SNO_OBSERVE_KEYS);

function getDefaultObserve(): SnoObserveApi {
	defaultObserve ??= createSnoObserve();
	return defaultObserve;
}

export const snoObserve: SnoObserveApi = new Proxy({} as SnoObserveApi, {
	get(_target, property) {
		if (!SNO_OBSERVE_KEY_SET.has(property)) {
			return undefined;
		}
		return getDefaultObserve()[property as keyof SnoObserveApi];
	},
	has(_target, property) {
		return SNO_OBSERVE_KEY_SET.has(property);
	},
	ownKeys() {
		return [...SNO_OBSERVE_KEYS];
	},
	getOwnPropertyDescriptor(_target, property) {
		if (!SNO_OBSERVE_KEY_SET.has(property)) {
			return undefined;
		}
		return {
			configurable: true,
			enumerable: true,
		};
	},
});

export type {
	AgentId,
	ConsentValue,
	DoctorCheck,
	DoctorReport,
	Event,
	ExportFormat,
	RuntimeOptions,
	ShutdownResult,
};
