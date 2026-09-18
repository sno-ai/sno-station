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
	env?: Record<string, string | undefined>;
	currentKeyVersion?: number;
}

const CURRENT_KEY_ENV = "SNO_STATION_MEM_TELEMETRY_HMAC_KEY";
const HISTORIC_KEY_PREFIX = "SNO_STATION_MEM_TELEMETRY_HMAC_KEY_V";

export function loadMemoryTelemetryKeySet(
	options: LoadMemoryTelemetryKeySetOptions,
): MemoryTelemetryKeySet {
	const env = options.env ?? process.env;
	if (!options.enabled) {
		return { enabled: false, current: null, historic: new Map() };
	}
	const key = env[CURRENT_KEY_ENV];
	if (!key || key.trim().length === 0) {
		throw new Error(`${CURRENT_KEY_ENV} is required when memory telemetry is enabled`);
	}
	const currentKeyVersion = options.currentKeyVersion ?? 1;
	if (!Number.isInteger(currentKeyVersion) || currentKeyVersion <= 0) {
		throw new Error("memory telemetry current key version must be a positive integer");
	}
	return {
		enabled: true,
		current: { version: currentKeyVersion, key },
		historic: readHistoricKeys(env),
	};
}

function readHistoricKeys(env: Record<string, string | undefined>): Map<number, string> {
	const historic = new Map<number, string>();
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith(HISTORIC_KEY_PREFIX) || !value) continue;
		const rawVersion = name.slice(HISTORIC_KEY_PREFIX.length);
		const version = Number.parseInt(rawVersion, 10);
		if (String(version) !== rawVersion || version <= 0) {
			throw new Error(`Invalid memory telemetry historic key version: ${name}`);
		}
		historic.set(version, value);
	}
	return historic;
}
