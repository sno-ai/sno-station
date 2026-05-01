export interface LogContext {
	[key: string]: string | number | boolean | null | undefined;
}

export class ObserveLogger {
	private degraded = false;
	private lastError: string | null = null;

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

	error(message: string, context: LogContext = {}): void {
		this.degraded = true;
		this.lastError = message;
		this.write("error", message, context);
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
		process.stderr.write(
			`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeContext })}\n`,
		);
	}
}

export const logger = new ObserveLogger();
