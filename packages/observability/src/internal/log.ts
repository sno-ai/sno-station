import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogPath } from "./paths.js";

export interface LogContext {
	[key: string]: unknown;
}

/** Where the record came from; kept for the shared log-site convention. */
export interface LogSource {
	event_name: string;
	file: string;
	function: string;
	site_id: string;
}

const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * SDK diagnostics go to `<profile>/observe.log`, never to the host process's
 * stdout or stderr: the SDK lives inside agents whose output is the product.
 */
export class ObserveLogger {
	private degraded = false;
	private lastError: string | null = null;
	private readonly failureLogTimes = new Map<string, number>();
	private suppressedCount = 0;

	debug(message: string, context: LogContext, source: LogSource): void {
		if (process.env["SNO_OBSERVE_LOG"] === "debug") {
			this.write("debug", message, context, source);
		}
	}

	info(message: string, context: LogContext, source: LogSource): void {
		this.write("info", message, context, source);
	}

	warn(message: string, context: LogContext, source: LogSource): void {
		this.write("warn", message, context, source);
	}

	warnRateLimited(key: string, message: string, context: LogContext, source: LogSource): void {
		this.writeRateLimited("warn", key, message, context, source);
	}

	error(message: string, context: LogContext, source: LogSource): void {
		this.degraded = true;
		this.lastError = message;
		this.write("error", message, context, source);
	}

	errorRateLimited(key: string, message: string, context: LogContext, source: LogSource): void {
		this.degraded = true;
		this.lastError = message;
		this.writeRateLimited("error", key, message, context, source);
	}

	getServiceDegraded(): boolean {
		return this.degraded;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	resetDegraded(): void {
		this.degraded = false;
		this.lastError = null;
	}

	flushSuppressed(): void {
		if (this.suppressedCount === 0) return;
		this.write("warn", "Sno Observe log messages were suppressed", { scope: "observe_logger" }, {
			event_name: "observe.logging.suppressed",
			file: "packages/observability/src/internal/log.ts",
			function: "flushSuppressed",
			site_id: "observe.logging.suppressed",
		});
	}

	private write(
		level: "debug" | "info" | "warn" | "error",
		message: string,
		context: LogContext,
		source: LogSource,
	): void {
		const record = {
			timestamp: new Date().toISOString(),
			level,
			body: message,
			event_name: source.event_name,
			attributes: {
				...context,
				...(this.suppressedCount > 0 ? { suppressed_count: this.suppressedCount } : {}),
			},
			source,
		};
		try {
			const path = getLogPath();
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record, errorReplacer)}\n`, { mode: 0o600 });
			this.suppressedCount = 0;
		} catch {
			// An unwritable log file must not change delivery or consent.
		}
	}

	private writeRateLimited(
		level: "warn" | "error",
		key: string,
		message: string,
		context: LogContext,
		source: LogSource,
	): void {
		const now = Date.now();
		const last = this.failureLogTimes.get(key);
		if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) {
			this.suppressedCount += 1;
			return;
		}
		if (this.failureLogTimes.size >= 1_000) {
			const oldestKey = this.failureLogTimes.keys().next().value;
			if (typeof oldestKey === "string") {
				this.failureLogTimes.delete(oldestKey);
			}
		}
		this.failureLogTimes.delete(key);
		this.failureLogTimes.set(key, now);
		this.write(level, message, context, source);
	}
}

function errorReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
	}
	return value;
}

export const logger = new ObserveLogger();
