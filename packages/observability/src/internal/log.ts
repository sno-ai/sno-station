import { emitDiagnostic, type LogSource } from "@snoai/utils/logger";

export interface LogContext {
	[key: string]: unknown;
}

const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1_000;

export class ObserveLogger {
	private degraded = false;
	private lastError: string | null = null;
	private readonly failureLogTimes = new Map<string, number>();
	private suppressedCount = 0;
	private firstSuppressedAt: number | undefined;
	private lastSuppressedAt: number | undefined;

	debug(message: string, context: LogContext, source: LogSource): void {
		const { SNO_OBSERVE_LOG: logLevel } = process.env;
		if (logLevel === "debug") {
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
			file: "packages/sno-observe/src/internal/log.ts",
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
		try {
			const written = emitDiagnostic(level, message, {
				...context,
				...(this.suppressedCount > 0 ? {
					suppressed_count: this.suppressedCount,
					suppressed_first_ms: this.firstSuppressedAt,
					suppressed_last_ms: this.lastSuppressedAt,
				} : {}),
			}, source);
			if (written) {
				this.suppressedCount = 0;
				this.firstSuppressedAt = undefined;
				this.lastSuppressedAt = undefined;
			}
		} catch {
			// A failing caller context must not change SDK delivery or consent.
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
			this.firstSuppressedAt ??= now;
			this.lastSuppressedAt = now;
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

export const logger = new ObserveLogger();
