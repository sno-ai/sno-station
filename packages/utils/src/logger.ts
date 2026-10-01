import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configureLogStateRoot, currentLogContext, logStateRoot } from "./log-context.js";
import { configureDiagnosticMetadata, diagnosticProcessInstanceId, encodeDiagnostic, LOG_SEVERITY, type LogLevel, type LogResource } from "./log-encoder.js";
import { LogFileSink } from "./log-file-sink.js";
import { resolveLogSite, validateLogCatalog, type LogSiteCatalog, type LogSource } from "./log-site-catalog.js";

export interface LoggerConfiguration {
	app: string;
	serviceVersion: string;
	buildId: string;
	catalog: LogSiteCatalog;
	level?: LogLevel;
	file?: string;
	home?: string;
}

export interface Logger {
	debug(body: string, attributes: unknown, source: LogSource): boolean;
	info(body: string, attributes: unknown, source: LogSource): boolean;
	warn(body: string, attributes: unknown, source: LogSource): boolean;
	error(body: string, attributes: unknown, source: LogSource): boolean;
	fatal(body: string, attributes: unknown, source: LogSource): boolean;
}

const DEFAULT_LEVEL: LogLevel = "info";
const LOG_DIRECTORY = "logs";
let configuration: LoggerConfiguration | undefined;
let ordinarySink: LogFileSink | undefined;
const additionalSinks = new Set<LogFileSink>();
let fileStatus: { destination: string | null; reason: string | null } = {
	destination: null, reason: "application_not_configured",
};
const reported = new Set<string>();

export function effectiveLogLevel(): LogLevel {
	return configuration?.level ?? DEFAULT_LEVEL;
}

function resource(): LogResource {
	return {
		service_name: configuration?.app ?? "unavailable",
		service_version: configuration?.serviceVersion ?? "unavailable",
		build_id: configuration?.buildId ?? "unavailable",
		process_id: process.pid, process_instance_id: diagnosticProcessInstanceId,
	};
}

function stderr(line: string): void {
	try { process.stderr.write(`${line}\n`); } catch { /* Diagnostics cannot fail the owner. */ }
}

function sinkNotice(reason: string, fields?: Record<string, unknown>): string {
	const source = { event_name: "diagnostic.delivery.degraded", file: "packages/utils/src/logger.ts",
		function: "sinkNotice", site_id: "diagnostic.delivery.degraded" };
	const metadata = resource();
	const line = encodeDiagnostic({
		level: "warn", body: "Diagnostic delivery degraded", resource: metadata,
		attributes: { reason_code: reason, ...fields },
		source, resolvedSource: resolveLogSite(source, metadata.build_id, configuration?.catalog),
	});
	stderr(line);
	return line;
}

function reportOnce(reason: string): void {
	if (reported.has(reason)) return;
	reported.add(reason);
	sinkNotice(reason);
}

function testIsolation(): boolean {
	return process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true"
		|| process.env["VITEST_WORKER_ID"] !== undefined;
}

function prepareDestination(path: string): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
			| constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
		try { if (!fstatSync(fd).isFile()) throw new Error("Diagnostic destination is not regular"); }
		finally { closeSync(fd); }
		return true;
	} catch { reportOnce("file_destination_unwritable"); return false; }
}

export function configureLogger(next: LoggerConfiguration): void {
	if (configuration) {
		if (configuration.app !== next.app || configuration.buildId !== next.buildId) {
			reportOnce("application_configuration_conflict");
		}
		return;
	}
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(next.app)) { reportOnce("application_configuration_invalid"); return; }
	let catalog = next.catalog;
	try { validateLogCatalog(catalog, next.buildId); }
	catch { catalog = { build_id: next.buildId, sites: {} }; reportOnce("source_catalog_invalid"); }
	configuration = { ...next, catalog };
	configureLogStateRoot(next.home);
	try { configureDiagnosticMetadata(resource(), catalog); }
	catch { reportOnce("source_catalog_invalid"); }
	if (testIsolation()) { fileStatus = { destination: null, reason: "test_isolation" }; return; }
	const defaultPath = join(logStateRoot(), LOG_DIRECTORY, `${next.app}.log`);
	const override = next.file;
	const nullDevice = override && (resolve(override) === "/dev/null" || /^nul(?::)?$/i.test(override));
	if (nullDevice) reportOnce("null_destination_refused");
	const destination = override && !nullDevice ? resolve(override) : defaultPath;
	if (!prepareDestination(destination)) {
		fileStatus = { destination: null, reason: "file_destination_unwritable" };
		return;
	}
	ordinarySink = new LogFileSink(destination, sinkNotice);
	fileStatus = { destination, reason: null };
	const rawLevel = next.level;
	if (rawLevel !== undefined && !Object.hasOwn(LOG_SEVERITY, rawLevel)) reportOnce("invalid_log_level");
}

export function loggerFileStatus(): { destination: string | null; reason: string | null } {
	return ordinarySink?.status() ?? { ...fileStatus };
}

export function addLogFileTarget(path: string): () => Promise<void> {
	if (testIsolation() || !prepareDestination(path)) return async () => {};
	const sink = new LogFileSink(path, sinkNotice, false);
	additionalSinks.add(sink);
	return async () => { additionalSinks.delete(sink); await sink.close(); };
}

/** The caller owns level filtering; used by the independent Observe level control. */
export function emitDiagnostic(level: LogLevel, body: string, attributes: unknown, source: LogSource): boolean {
	try {
		const metadata = resource();
		const resolvedSource = resolveLogSite(source, metadata.build_id, configuration?.catalog);
		if (resolvedSource["catalog_status"] !== "available") reportOnce("source_catalog_unavailable");
		const line = encodeDiagnostic({
			level, body, attributes, source, resource: metadata, resolvedSource, context: currentLogContext(),
		});
		stderr(line);
		ordinarySink?.enqueue(line, level);
		for (const sink of additionalSinks) sink.enqueue(line, level);
		return true;
	} catch { reportOnce("encoding_failed"); return false; }
}

export function createLogger(_scope: string): Logger {
	const emit = (level: LogLevel, body: string, attributes: unknown, source: LogSource): boolean => {
		if (LOG_SEVERITY[level] < LOG_SEVERITY[effectiveLogLevel()]) return false;
		return emitDiagnostic(level, body, attributes, source);
	};
	return {
		debug: (body, attributes, source) => emit("debug", body, attributes, source),
		info: (body, attributes, source) => emit("info", body, attributes, source),
		warn: (body, attributes, source) => emit("warn", body, attributes, source),
		error: (body, attributes, source) => emit("error", body, attributes, source),
		fatal: (body, attributes, source) => emit("fatal", body, attributes, source),
	};
}

export async function closeLogger(): Promise<void> {
	await Promise.all([ordinarySink?.close(), ...[...additionalSinks].map((sink) => sink.close())]);
}

export type { LogLevel, LogResource } from "./log-encoder.js";
export type { LogSource, LogSiteCatalog } from "./log-site-catalog.js";
export { currentLogContext, externalLogReference, privateLogReference, withLogContext } from "./log-context.js";
export type { LogContext, LogContextInput, LogReference } from "./log-context.js";
