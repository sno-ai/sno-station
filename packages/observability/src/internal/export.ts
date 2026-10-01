import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { type BufferStore, decodeEnvelope, type PendingRow } from "./buffer-store.js";
import { atomicWrite } from "./fs-utils.js";
import { type ExportFormat, type ExportResult, SDK_VERSION, type WireEnvelope } from "./types.js";

export interface ExportOptions {
	format?: ExportFormat;
	path?: string;
	includeData?: boolean;
}

interface BuiltExport {
	data: Uint8Array;
	tarballSha256?: string;
}

interface ManifestChain {
	machine_id: string;
	agent_id: string;
	chain_epoch: number;
	first_seq: number;
	last_seq: number;
	first_self: string;
	last_self: string;
	row_count: number;
	shipped_count: number;
	off_period: boolean;
}

interface ChainGroup {
	machineId: string;
	agentId: string;
	chainEpoch: number;
	rows: PendingRow[];
}

export function exportEvents(store: BufferStore, options: ExportOptions = {}): ExportResult {
	const format = options.format ?? inferFormat(options.path);
	const rows = store.getAllRows();
	const built = buildExportData(format, rows);
	const data = built.data;
	if (options.path !== undefined) {
		atomicWrite(options.path, data);
	}
	const result: ExportResult = {
		format,
		rowCount: rows.length,
		bytes: data.byteLength,
	};
	if (options.path !== undefined) {
		result.path = options.path;
	}
	if (options.includeData !== false) {
		result.data = data;
	}
	if (built.tarballSha256 !== undefined) {
		result.tarballSha256 = built.tarballSha256;
	}
	return result;
}

function inferFormat(path?: string): ExportFormat {
	if (path?.endsWith(".csv")) {
		return "csv";
	}
	if (path?.endsWith(".jsonl")) {
		return "jsonl";
	}
	if (path?.endsWith(".tar.gz") || path?.endsWith(".tgz")) {
		return "tarball";
	}
	return "tarball";
}

function buildExportData(format: ExportFormat, rows: PendingRow[]): BuiltExport {
	if (format === "csv") {
		return { data: new TextEncoder().encode(buildCsv(rows)) };
	}
	if (format === "tarball") {
		return buildTarGz(rows);
	}
	return { data: new TextEncoder().encode(buildJsonl(rows)) };
}

function buildJsonl(rows: PendingRow[]): string {
	if (rows.length === 0) {
		return "";
	}
	return `${rows.map((row) => row.payload.toString("utf8")).join("\n")}\n`;
}

function buildCsv(rows: PendingRow[]): string {
	const header = [
		"event_id",
		"event_type",
		"ts_edge_ms",
		"consent_level",
		"redacted",
		"agent_id",
		"chain_epoch",
		"seq",
		"self",
		"prev",
	].join(",");
	const lines = rows.map((row) => {
		const envelope = decodeEnvelope(row.payload);
		return [
			envelope.event_id,
			envelope.event_type,
			String(envelope.ts_edge_ms),
			envelope.consent_level,
			String(envelope.redacted),
			envelope.scope.agent_id,
			String(envelope.chain_epoch),
			String(envelope.seq),
			envelope.hash_chain.self,
			envelope.hash_chain.prev,
		]
			.map(csvCell)
			.join(",");
	});
	return `${[header, ...lines].join("\n")}\n`;
}

function csvCell(value: string): string {
	if (!/[",\n\r]/u.test(value)) {
		return value;
	}
	return `"${value.replace(/"/gu, '""')}"`;
}

function buildTarGz(rows: PendingRow[]): BuiltExport {
	const jsonlBytes = new TextEncoder().encode(buildJsonl(rows));
	const manifest = JSON.stringify(buildManifest(rows, jsonlBytes), null, 2);
	const tar = concatBytes([
		tarEntry("events.jsonl", jsonlBytes),
		tarEntry("MANIFEST.json", new TextEncoder().encode(`${manifest}\n`)),
		new Uint8Array(1024),
	]);
	const data = gzipSync(tar);
	return { data, tarballSha256: sha256Hex(data) };
}

function buildManifest(
	rows: PendingRow[],
	jsonlBytes: Uint8Array,
): {
	manifest_version: 1;
	exported_at_ms: number;
	sdk_version: string;
	event_count: number;
	events_jsonl_sha256: string;
	chains: ManifestChain[];
	verification: {
		rule: "v1";
		notes: string;
	};
} {
	return {
		manifest_version: 1,
		exported_at_ms: Date.now(),
		sdk_version: SDK_VERSION,
		event_count: rows.length,
		events_jsonl_sha256: sha256Hex(jsonlBytes),
		chains: buildManifestChains(rows),
		verification: {
			rule: "v1",
			notes:
				"Re-derive each event's self_hash via plugin-integration-spec.md section 4.1 and confirm prev-link continuity within each chain; gap-free seq is required.",
		},
	};
}

function buildManifestChains(rows: PendingRow[]): ManifestChain[] {
	const groups = new Map<string, ChainGroup>();
	for (const row of rows) {
		const key = `${row.machine_id}:${row.agent_id}:${row.chain_epoch}`;
		const existing = groups.get(key);
		if (existing === undefined) {
			groups.set(key, {
				machineId: row.machine_id,
				agentId: row.agent_id,
				chainEpoch: row.chain_epoch,
				rows: [row],
			});
			continue;
		}
		existing.rows.push(row);
	}

	const chains: ManifestChain[] = [];
	for (const group of groups.values()) {
		const sorted = [...group.rows].sort((left, right) => left.seq - right.seq);
		const first = sorted.at(0);
		const last = sorted.at(-1);
		if (first === undefined || last === undefined) {
			continue;
		}
		chains.push({
			machine_id: group.machineId,
			agent_id: group.agentId,
			chain_epoch: group.chainEpoch,
			first_seq: first.seq,
			last_seq: last.seq,
			first_self: first.self_hash,
			last_self: last.self_hash,
			row_count: sorted.length,
			shipped_count: sorted.filter((row) => row.shipped === 1).length,
			off_period: sorted.every((row) => decodeEnvelope(row.payload).consent_level === "off"),
		});
	}
	return chains;
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function tarEntry(name: string, contents: Uint8Array): Uint8Array {
	const header = new Uint8Array(512);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, contents.byteLength);
	writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
	for (let index = 148; index < 156; index += 1) {
		header[index] = 32;
	}
	header[156] = "0".charCodeAt(0);
	writeString(header, 257, 6, "ustar");
	writeString(header, 263, 2, "00");
	let checksum = 0;
	for (const byte of header) {
		checksum += byte;
	}
	writeOctal(header, 148, 8, checksum);
	const paddingLength = (512 - (contents.byteLength % 512)) % 512;
	return concatBytes([header, contents, new Uint8Array(paddingLength)]);
}

function writeString(buffer: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = new TextEncoder().encode(value);
	buffer.set(bytes.slice(0, length), offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	writeString(buffer, offset, length - 1, encoded);
	buffer[offset + length - 1] = 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export function parseExportedEnvelope(row: PendingRow): WireEnvelope {
	return decodeEnvelope(row.payload);
}
