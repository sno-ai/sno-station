export interface LogContext {
	[key: string]: string | number | boolean | null | undefined;
}

const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1_000;

export class ObserveLogger {
	private degraded = false;
	private lastError: string | null = null;
	private readonly failureLogTimes = new Map<string, number>();

	debug(message: string, context: LogContext = {}): void {
		const { SNO_OBSERVE_LOG: logLevel } = process.env;
		if (logLevel === "debug") {
			this.write("debug", message, context);
		}
	}

	info(message: string, context: LogContext = {}): void {
		this.write("info", message, context);
	}

	warn(message: string, context: LogContext = {}): void {
		this.write("warn", message, context);
	}

	warnRateLimited(key: string, message: string, context: LogContext = {}): void {
		this.writeRateLimited("warn", key, message, context);
	}

	error(message: string, context: LogContext = {}): void {
		this.degraded = true;
		this.lastError = message;
		this.write("error", message, context);
	}

	errorRateLimited(key: string, message: string, context: LogContext = {}): void {
		this.degraded = true;
		this.lastError = message;
		this.writeRateLimited("error", key, message, context);
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

	private write(
		level: "debug" | "info" | "warn" | "error",
		message: string,
		context: LogContext,
	): void {
		const safeContext: LogContext = {};
		for (const [key, value] of Object.entries(context)) {
			if (key === "payload" || key === "body" || key === "raw") {
				continue;
			}
			safeContext[key] = value;
		}
		try {
			process.stderr.write(
				`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeContext })}\n`,
			);
		} catch {}
	}

	private writeRateLimited(
		level: "warn" | "error",
		key: string,
		message: string,
		context: LogContext,
	): void {
		const now = Date.now();
		const last = this.failureLogTimes.get(key);
		if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) {
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
		this.write(level, message, context);
	}
}

export const logger = new ObserveLogger();
