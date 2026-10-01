export interface MemoryTelemetryKey {
	version: number;
	key: string;
}

export interface MemoryTelemetryKeySet {
	enabled: boolean;
	current: MemoryTelemetryKey | null;
	historic: Map<number, string>;
}

export interface LoadMemoryTelemetryKeySetOptions {
	enabled: boolean;
	key: string;
	historicKeys: readonly string[];
	currentKeyVersion?: number;
}

export function loadMemoryTelemetryKeySet(
	options: LoadMemoryTelemetryKeySetOptions,
): MemoryTelemetryKeySet {
	if (!options.enabled) {
		return { enabled: false, current: null, historic: new Map() };
	}
	const key = options.key;
	if (!key || key.trim().length === 0) {
		throw new Error("telemetry.memoryUsage.key is required when memory telemetry is enabled");
	}
	const currentKeyVersion = options.currentKeyVersion ?? options.historicKeys.length + 1;
	if (!Number.isInteger(currentKeyVersion) || currentKeyVersion <= 0) {
		throw new Error("memory telemetry current key version must be a positive integer");
	}
	return {
		enabled: true,
		current: { version: currentKeyVersion, key },
		historic: new Map(options.historicKeys.map((value, index) => [index + 1, value])),
	};
}
