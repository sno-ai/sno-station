import {
	diagnosticProcessInstanceId,
	encodeDiagnostic as encodeRecord,
	writeEmergencyDiagnostic as writeRecord,
	type DiagnosticInput,
} from "@snoai/utils/log-encoder";
import packageMetadata from "../../../package.json" with { type: "json" };
import { logSiteCatalog } from "./log-site-catalog.generated";

function bindApplication(input: DiagnosticInput): DiagnosticInput {
	const site = logSiteCatalog.sites[input.source.site_id];
	const matched = site?.file === input.source.file && site?.function === input.source.function;
	return {
		...input,
		resource: { service_name: "sno-station-mem", service_version: packageMetadata.version,
			build_id: logSiteCatalog.build_id, process_id: process.pid,
			process_instance_id: diagnosticProcessInstanceId },
		resolvedSource: { catalog_status: matched ? "available" : "unavailable",
			...(!matched ? { catalog_reason: "site_not_in_catalog" } : {}) },
	};
}

export function encodeDiagnostic(input: DiagnosticInput): string {
	return encodeRecord(bindApplication(input));
}

export function writeEmergencyDiagnostic(input: DiagnosticInput): void {
	writeRecord(bindApplication(input));
}

export type { DiagnosticInput, LogLevel, LogSource } from "@snoai/utils/log-encoder";
