import { atomicWriteJson, readJsonFile, removeFile } from "./fs-utils.js";
import { getConsentPath, getPausePath, type PathEnv } from "./paths.js";
import { parseConsentValue } from "./schemas.js";
import type { ConsentValue } from "./types.js";

interface ConsentState {
	version: 1;
	value: ConsentValue;
	updated_at: string;
}

interface PauseState {
	version: 1;
	prior: ConsentValue;
	paused_at: string;
}

export class ConsentStore {
	constructor(private readonly env: PathEnv = process.env) {}

	get(): ConsentValue {
		const state = readJsonFile<ConsentState>(getConsentPath(this.env));
		if (state !== null && state.version === 1) {
			return parseConsentValue(state.value);
		}
		return "metadata-only";
	}

	write(value: ConsentValue): void {
		atomicWriteJson(
			getConsentPath(this.env),
			{
				version: 1,
				value,
				updated_at: new Date().toISOString(),
			} satisfies ConsentState,
			0o600,
		);
	}

	getPausedPrior(): ConsentValue | null {
		const state = readJsonFile<PauseState>(getPausePath(this.env));
		if (state === null || state.version !== 1) {
			return null;
		}
		return parseConsentValue(state.prior);
	}

	writePausedPrior(prior: ConsentValue): void {
		atomicWriteJson(
			getPausePath(this.env),
			{
				version: 1,
				prior,
				paused_at: new Date().toISOString(),
			} satisfies PauseState,
			0o600,
		);
	}

	clearPausedPrior(): void {
		removeFile(getPausePath(this.env));
	}
}
