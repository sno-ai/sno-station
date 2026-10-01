import { createHash, randomUUID } from "node:crypto";
import { resolveLogSite, validateLogCatalog, type LogSiteCatalog, type LogSource } from "./log-site-catalog.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export const MAX_LOG_RECORD_BYTES: number = 16 * 1024;
export const LOG_SEVERITY: Readonly<Record<LogLevel, number>> = {
	debug: 5, info: 9, warn: 13, error: 17, fatal: 21,
};

export interface LogResource {
	service_name: string;
	service_version: string;
	build_id: string;
	process_id: number;
	process_instance_id: string;
}

export interface DiagnosticInput {
	level: LogLevel;
	body: string;
	attributes?: unknown;
	source: LogSource;
	resource?: LogResource;
	context?: Readonly<Record<string, unknown>> | object;
	resolvedSource?: Record<string, unknown>;
}

export const diagnosticProcessInstanceId: string = randomUUID();
let configuredMetadata: { resource: LogResource; catalog: LogSiteCatalog } | undefined;
const RESERVED = new Set([
	"schema_version", "timestamp", "severity_text", "severity_number", "event_name",
	"body", "resource", "source", "context", "attributes", "event_id",
]);
const PRIVATE_KEYS = /^(authorization|token|apikey|secret|password|cookie|credentials?|privatekey|accesstoken|refreshtoken|bearer|prompt|reply|query|querytext|text|content|memory|memorytext|claimtext|abstract|reasoning|raw|rawmessage|rawbody|payload|httpbody|dek|keymaterial|sessionid|userid)$/;
const LABEL_KEYS = new Set([
	"outcome", "reason", "reason_code", "error_code", "code", "phase", "mode", "level", "effective_level",
	"model", "requested_model", "returned_model", "route", "transport", "adapter_slot",
	"call_label", "finish_reason", "token_source", "sampling_status", "availability",
	"status", "lane", "stage", "selected_mode", "operation", "source", "kind", "type",
	"unit", "visibility", "basis", "provider", "method", "version", "product_mode",
	"file_sink_reason", "catalog_status", "catalog_reason", "disabled_reason", "result",
	"service_name", "service_version", "build_id", "event_name", "site_id", "function",
	"prompt_template_unavailable_reason", "first_token_reason", "unavailable_reason",
	"name", "skipped",
	"runtime_mode", "occasion", "tier", "parser", "preset",
	"mapped_kind", "category",
	"mutation_outcome", "action", "tool_name",
	"locale",
]);
const ERROR_NAMES = new Set([
	"Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError",
	"EvalError", "AggregateError", "AbortError", "TimeoutError", "DOMException",
	"WrongKeyError", "IntegrityCheckFailed", "ManifestCorrupted", "KeychainUnavailableError",
	"StorageError", "SnoStationCoreCryptoError", "CanaryMismatch", "DbIdMismatch", "ManifestMissing",
	"MissingDekError", "ForeignDekError", "InvalidExportFormat", "UnsupportedExportVersion",
	"MemClawError", "EmbeddingError", "RetrievalError", "ConfigError",
	"ProviderTerminalError", "LlmClientTerminalError",
	"PermanentUsageOutboxRowError", "LiveClauseVerdictGateError", "TaskLifecycleJudgmentUnavailableError",
	"TaskLifecycleCommandMismatchError", "BProfileLaneError", "ExtractionError", "ManifestSchemaError",
	"ManifestMissingButDataPresentError", "NonLocalFilesystemError", "StorageFailedError",
	"RuntimeNotInitialized", "SqliteFileMissingError", "TaskLifecycleCommandCollisionError",
	"TaskLifecycleStateCollisionError", "TaskLifecycleStaleResolutionError",
	"TaskLifecycleTimestampCollisionError", "StaleSupersedeTargetError",
	"ZodError",
]);
const ERROR_CODES = new Set([
	"KEYCHAIN_UNAVAILABLE", "WRONG_KEY", "INTEGRITY_CHECK_FAILED", "CANARY_MISMATCH",
	"DB_ID_MISMATCH", "MANIFEST_MISSING", "MANIFEST_CORRUPTED", "MISSING_DEK", "FOREIGN_DEK",
	"INVALID_EXPORT_FORMAT", "UNSUPPORTED_EXPORT_VERSION", "storage_error", "embedding_error",
	"retrieval_error", "config_error",
	"task_lifecycle_judgment_unavailable",
]);

function digest(value: string): { length: number; sha256: string } {
	return { length: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

function safeError(error: Error, depth: number, seen: Set<object>): Record<string, unknown> {
	const message = typeof error.message === "string" ? error.message : "";
	const result: Record<string, unknown> = {
		type: ERROR_NAMES.has(error.name) ? error.name : "Error",
		message_length: message.length, message_sha256: digest(message).sha256,
	};
	if (!ERROR_NAMES.has(error.name)) result["type_sha256"] = digest(error.name).sha256;
	if ("category" in error && typeof error.category === "string"
		&& ["cancelled", "timeout", "auth", "transport"].includes(error.category)) {
		result["category"] = error.category;
	}
	if ("statusCode" in error && typeof error.statusCode === "number"
		&& Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) {
		result["statusCode"] = error.statusCode;
	}
	if ("code" in error && typeof error.code === "string") {
		if (ERROR_CODES.has(error.code) || /^(?:E[A-Z]|SQLITE_)[A-Z_0-9]{1,40}$/.test(error.code)) {
			result["code"] = error.code;
		} else result["code_sha256"] = digest(error.code).sha256;
	}
	const frames = (typeof error.stack === "string" ? error.stack : "").split("\n").slice(1, 17);
	result["frames"] = frames.flatMap((frame) => {
		const match = frame.match(/(?:\/|\()((?:tests|apps|packages)\/[\w./-]+):(\d+):(\d+)\)?$/);
		return match?.[1] && !match[1].split("/").includes("..")
			? [{ file: match[1], line: Number(match[2]), column: Number(match[3]) }] : [];
	});
	if (error.cause !== undefined && depth < 4) result["cause"] = safeValue("error", error.cause, depth + 1, seen);
	return result;
}

function safeString(key: string, value: string): unknown {
	if (value === "unavailable" || value === "undetermined" || value === "unknown") return value;
	if (key === "timezone") {
		if (value === "user" || /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
		try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; }
		catch { return digest(value); }
	}
	if ((key.endsWith("_hash") || key.endsWith("_sha256")) && /^[a-f0-9]{64}$/.test(value)) return value;
	if ((key === "trace_id" || key === "span_id") && /^[a-f0-9]+$/.test(value)
		&& value.length === (key === "trace_id" ? 32 : 16) && /[1-9a-f]/.test(value)) return value;
	if (/^(operation_id|attempt_id|attempt_ids|job_id|memory_id|memory_ids|served_ids|row_id|row_ids|config_id|reflection_event_reference)$/.test(key)
		&& /^[\w.:-]{1,128}$/.test(value)) return value;
	if ((LABEL_KEYS.has(key) || key.endsWith("_reason")) && /^[\w.:/@+-]{1,160}$/.test(value)) return value;
	if ((key === "destination" || key === "file_destination" || key === "file")
		&& value.length <= 1024 && [...value].every((char) => char.charCodeAt(0) >= 32
			&& char.charCodeAt(0) !== 127)) return value;
	if (key === "endpoint" || key === "url") {
		try {
			const url = new URL(value);
			return { protocol: url.protocol, host: url.host, path_sha256: digest(url.pathname).sha256 };
		} catch { return digest(value); }
	}
	return digest(value);
}

function safeValue(key: string, value: unknown, depth: number, seen: Set<object>): unknown {
	if (PRIVATE_KEYS.test(key.toLowerCase().replace(/[-_]/g, ""))) return { unavailable: "private_field" };
	if (depth > 5) return { truncated: "depth_limit" };
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") return safeString(key, value);
	if (typeof value !== "object") return { unavailable: "unsupported_value" };
	if (key === "external_reference") return safeContextReference(value, true);
	if (key.endsWith("session_reference") || key === "store_reference" || key === "artifact_reference"
		|| key === "agent_reference" || key === "scope_reference") return safeContextReference(value, false);
	if (seen.has(value)) return { unavailable: "circular_value" };
	seen.add(value);
	try {
		if (value instanceof Error) return safeError(value, depth, seen);
		if (Array.isArray(value)) {
			const result = value.slice(0, 128).map((item) => safeValue(key, item, depth + 1, seen));
			if (value.length > 128) result.push({ truncated: "array_limit", omitted_count: value.length - 128 });
			return result;
		}
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value);
		for (const [field, item] of entries.slice(0, 64)) {
			if (/^[a-zA-Z][\w]{0,63}$/.test(field) && (depth > 0 || !RESERVED.has(field))) {
				result[field] = safeValue(field, item, depth + 1, seen);
			}
		}
		if (entries.length > 64) result["truncated"] = { reason: "field_limit", omitted_count: entries.length - 64 };
		return result;
	} finally { seen.delete(value); }
}

export function sanitizeLogAttributes(attributes: unknown): unknown {
	try { return safeValue("attributes", attributes ?? {}, 0, new Set()); }
	catch { return { unavailable: "attribute_access_failed" }; }
}

function safeContextReference(value: unknown, publicAllowed: boolean): unknown {
	if (typeof value !== "object" || value === null || !("value" in value)
		|| !("visibility" in value)) return { value: null, visibility: "unavailable", reason: "not_supplied" };
	if (value.visibility === "hashed" && typeof value.value === "string" && /^[a-f0-9]{64}$/.test(value.value)) {
		return { value: value.value, visibility: "hashed" };
	}
	if (publicAllowed && value.visibility === "public" && typeof value.value === "string"
		&& value.value.trim() && value.value.length <= 128) return { value: value.value, visibility: "public" };
	const reason = "reason" in value && typeof value.reason === "string"
		&& /^[a-z_]{1,64}$/.test(value.reason) ? value.reason : "unsafe_reference";
	return { value: null, visibility: "unavailable", reason };
}

function safeContext(value: object | undefined): Record<string, unknown> {
	const input = value ? Object.fromEntries(Object.entries(value)) : {};
	const result: Record<string, unknown> = { operation_id: null, operation_reason: "not_supplied" };
	for (const key of ["operation_id", "attempt_id", "job_id", "trace_id", "span_id"]) {
		const raw = input[key];
		if (typeof raw !== "string") continue;
		const safe = safeString(key, raw);
		if (typeof safe === "string") result[key] = safe;
	}
	if (result["operation_id"]) delete result["operation_reason"];
	result["session_reference"] = safeContextReference(input["session_reference"], false);
	result["external_reference"] = safeContextReference(input["external_reference"], true);
	return result;
}

function boundedIdentity(value: unknown, limit = 256): string {
	return typeof value === "string" && Buffer.byteLength(value) <= limit
		&& [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
		? value : "unavailable";
}

function encodedSource(input: DiagnosticInput, buildId: string): Record<string, unknown> {
	const supplied = input.resolvedSource;
	const file = input.source.file;
	const validFile = typeof file === "string" && /^(apps|packages|tests)\/[\w./-]+$/.test(file)
		&& !file.split("/").includes("..");
	return {
		file: validFile ? boundedIdentity(file, 1024) : "unavailable",
		function: boundedIdentity(input.source.function), site_id: boundedIdentity(input.source.site_id),
		build_id: buildId,
		catalog_status: supplied?.["catalog_status"] === "available" ? "available" : "unavailable",
		...(supplied?.["catalog_status"] !== "available"
			? { catalog_reason: boundedIdentity(supplied?.["catalog_reason"] ?? "not_configured") } : {}),
	};
}

export function encodeDiagnostic(input: DiagnosticInput): string {
	const suppliedResource = input.resource ?? configuredMetadata?.resource ?? {
		service_name: "unavailable", service_version: "unavailable", build_id: "unavailable",
		process_id: process.pid, process_instance_id: diagnosticProcessInstanceId,
	};
	const resource = {
		service_name: boundedIdentity(suppliedResource.service_name),
		service_version: boundedIdentity(suppliedResource.service_version),
		build_id: boundedIdentity(suppliedResource.build_id),
		process_id: process.pid,
		process_instance_id: diagnosticProcessInstanceId,
	};
	const record = {
		schema_version: 1, timestamp: new Date().toISOString(),
		severity_text: input.level.toUpperCase(), severity_number: LOG_SEVERITY[input.level],
		event_name: boundedIdentity(input.source.event_name),
		body: input.body.length <= 512 ? input.body : "Diagnostic body exceeded limit",
		resource, source: encodedSource({ ...input, resolvedSource: input.resolvedSource
			?? resolveLogSite(input.source, resource.build_id, configuredMetadata?.catalog) }, resource.build_id),
		context: safeContext(input.context),
		attributes: sanitizeLogAttributes(input.attributes), event_id: randomUUID(),
	};
	if (input.body.length > 512) record.attributes = {
		truncated: { reason: "body_limit", original_bytes: Buffer.byteLength(input.body) },
	};
	return boundedRecord(record);
}

function boundedRecord(record: { attributes: unknown }): string {
	let encoded = JSON.stringify(record);
	if (Buffer.byteLength(encoded) + 1 > MAX_LOG_RECORD_BYTES) {
		const originalBytes = Buffer.byteLength(encoded) + 1;
		const preserved: Record<string, unknown> = {};
		if (record.attributes && typeof record.attributes === "object") {
			for (const key of ["outcome", "reason_code", "duration_ms", "error"]) {
				if (!(key in record.attributes)) continue;
				const value: unknown = Reflect.get(record.attributes, key);
				if (JSON.stringify(value).length < 4096) preserved[key] = value;
			}
		}
		record.attributes = { ...preserved, truncated: { reason: "record_limit", original_bytes: originalBytes } };
		encoded = JSON.stringify(record);
		if (Buffer.byteLength(encoded) + 1 > MAX_LOG_RECORD_BYTES) {
			record.attributes = { truncated: { reason: "record_limit", original_bytes: originalBytes } };
			encoded = JSON.stringify(record);
		}
	}
	return encoded;
}

export function configureDiagnosticMetadata(resource: LogResource, catalog: LogSiteCatalog): void {
	validateLogCatalog(catalog, resource.build_id);
	configuredMetadata = { resource: { ...resource }, catalog };
}

export function writeEmergencyDiagnostic(input: DiagnosticInput, requested?: LogLevel): void {
	const effective = requested && Object.hasOwn(LOG_SEVERITY, requested)
		? LOG_SEVERITY[requested as LogLevel] : LOG_SEVERITY.info;
	if (LOG_SEVERITY[input.level] < effective) return;
	try { process.stderr.write(`${encodeDiagnostic(input)}\n`); }
	catch { /* Early diagnostics must not replace the startup or crypto result. */ }
}

export type { LogSource } from "./log-site-catalog.js";
