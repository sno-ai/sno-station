import { NonRetryableEvidenceError } from "./types";

export async function waitForEvidence<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	options: { label: string; pollMs: number; timeoutMs: number },
): Promise<T> {
	const deadline = Date.now() + options.timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (ready(value)) {
				return value;
			}
		} catch (error) {
			if (error instanceof NonRetryableEvidenceError) {
				throw error;
			}
			lastError = error;
		}
		await sleep(options.pollMs);
	}
	throw new Error(
		`Timed out waiting for ${options.label}${
			lastError instanceof Error ? `: ${lastError.message}` : ""
		}`,
	);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
