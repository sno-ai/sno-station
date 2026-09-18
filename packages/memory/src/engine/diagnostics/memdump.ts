/** @file memdump.ts
 * @purpose Read encrypted sno-station-mem memory rows as JSON Lines without changing the source store.
 * @boundary External sno-memdump command; it uses the storage runtime's encrypted readonly open.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveConfigPaths } from "@snoai/sno-station-core-crypto";
import { writeEmergencyDiagnostic } from "../observability/early-diagnostics";
import { initSqliteRuntime, openSqliteDatabaseReadonly } from "../../store/sqlite-runtime";

export interface MemdumpOptions {
	dbPath: string;
	scope?: string;
	id?: string;
	grep?: string;
	limit?: number;
	manifestPath?: string;
	metadata?: boolean;
}

interface RelocationManifestEntry {
	path: string;
	dbId: string;
	dekFingerprint: string;
}

interface RelocationManifest {
	schemaVersion: 1;
	createdAt: string;
	dbs: RelocationManifestEntry[];
}

interface MemoryRow {
	id: string;
	scope: string;
	text: string;
	category: string;
	timestamp: number;
	timezone: string;
	metadata: string | null;
	lane: string;
	disposition_reason: string | null;
	dispositioned_at_ms: number | null;
}

export interface DumpedMemoryRow {
	id: string;
	scope: string;
	text: string;
	category: string;
	tier: string | null;
	timestamp: number;
	timezone: string;
	lane: string;
	disposition_reason: string | null;
	dispositioned_at_ms: number | null;
	/** Supersession and validity live inside the metadata JSON, not in columns.
	 * They are what decide whether a row is still the current statement of a fact. */
	state: string | null;
	fact_key: string | null;
	section_name: string | null;
	supersedes: string | null;
	superseded_by: string | null;
	invalidated_at: string | number | null;
	/** The whole parsed metadata object, only when --metadata is passed. Receipts,
	 * l2_content and the supersession chain live here and nowhere else. */
	metadata?: Record<string, unknown> | null;
}

export function parseMemdumpOptions(args: string[]): MemdumpOptions {
	const parsed = parseArgs({
		args,
		options: {
			db: { type: "string" },
			manifest: { type: "string" },
			scope: { type: "string" },
			id: { type: "string" },
			grep: { type: "string" },
			limit: { type: "string" },
			metadata: { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (!parsed.values.db) throw new Error("--db <path> is required");
	// A blank value used to be dropped, so an unset shell variable turned a scoped dump into a
	// dump of every row — silently, and with --metadata that is every receipt too.
	for (const name of ["db", "manifest", "scope", "id", "grep"] as const) {
		const value = parsed.values[name];
		if (value !== undefined && value.trim() === "") {
			throw new Error(`--${name} was given an empty value`);
		}
	}
	const limit = parsed.values.limit === undefined ? undefined : Number(parsed.values.limit);
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
		throw new Error("--limit must be a positive integer");
	}
	return {
		dbPath: parsed.values.db,
		...(parsed.values.manifest ? { manifestPath: parsed.values.manifest } : {}),
		...(parsed.values.scope ? { scope: parsed.values.scope } : {}),
		...(parsed.values.id ? { id: parsed.values.id } : {}),
		...(parsed.values.grep ? { grep: parsed.values.grep } : {}),
		...(limit === undefined ? {} : { limit }),
		...(parsed.values.metadata ? { metadata: true } : {}),
	};
}

function readRelocationManifest(path: string): RelocationManifest {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`--manifest ${path} is not a manifest object`);
	}
	const source = parsed as Record<string, unknown>;
	const dbs = source["dbs"];
	if (source["schemaVersion"] !== 1 || typeof source["createdAt"] !== "string" || !Array.isArray(dbs)) {
		throw new Error(`--manifest ${path} has an unsupported schema`);
	}
	if (dbs.length !== 1) {
		throw new Error(`--manifest ${path} must register exactly one database`);
	}
	const entry = dbs[0];
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new Error(`--manifest ${path} has an invalid database entry`);
	}
	const fields = entry as Record<string, unknown>;
	if (
		typeof fields["path"] !== "string" ||
		typeof fields["dbId"] !== "string" ||
		typeof fields["dekFingerprint"] !== "string"
	) {
		throw new Error(`--manifest ${path} has an invalid database entry`);
	}
	return {
		schemaVersion: 1,
		createdAt: source["createdAt"],
		dbs: [
			{
				path: fields["path"],
				dbId: fields["dbId"],
				dekFingerprint: fields["dekFingerprint"],
			},
		],
	};
}

function installRelocatedManifest(manifestPath: string, dbPath: string): () => void {
	const manifest = readRelocationManifest(manifestPath);
	const temporaryConfigHome = mkdtempSync(resolve(tmpdir(), "sno-memdump-config-"));
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	try {
		process.env.XDG_CONFIG_HOME = temporaryConfigHome;
		const relocatedManifestPath = resolveConfigPaths().manifestFile;
		mkdirSync(dirname(relocatedManifestPath), { recursive: true, mode: 0o700 });
		writeFileSync(
			relocatedManifestPath,
			JSON.stringify({
				...manifest,
				dbs: [{ ...manifest.dbs[0], path: resolve(dbPath) }],
			}),
			{ mode: 0o644 },
		);
	} catch (error) {
		if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousConfigHome;
		rmSync(temporaryConfigHome, { recursive: true, force: true });
		throw error;
	}
	return () => {
		if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousConfigHome;
		rmSync(temporaryConfigHome, { recursive: true, force: true });
	};
}

export function buildMemdumpQuery(options: MemdumpOptions): { sql: string; params: string[] } {
	const conditions: string[] = [];
	const params: string[] = [];
	if (options.scope !== undefined) {
		conditions.push("project_id = ?");
		params.push(options.scope);
	}
	if (options.id !== undefined) {
		conditions.push("id = ?");
		params.push(options.id);
	}
	if (options.grep !== undefined) {
		conditions.push("instr(text, ?) > 0");
		params.push(options.grep);
	}
	const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
	const limit = options.limit === undefined ? "" : ` LIMIT ${String(options.limit)}`;
	return {
		sql: `SELECT id, project_id AS scope, text, category, timestamp, timezone, metadata, lane, disposition_reason, dispositioned_at_ms FROM nodix_memories${where} ORDER BY timestamp DESC, id DESC${limit}`,
		params,
	};
}

interface MetadataFields {
	tier: string | null;
	state: string | null;
	fact_key: string | null;
	section_name: string | null;
	supersedes: string | null;
	superseded_by: string | null;
	invalidated_at: string | number | null;
}

const EMPTY_METADATA_FIELDS: MetadataFields = {
	tier: null,
	state: null,
	fact_key: null,
	section_name: null,
	supersedes: null,
	superseded_by: null,
	invalidated_at: null,
};

function readString(source: Record<string, unknown>, key: string): string | null {
	const value: unknown = source[key];
	return typeof value === "string" ? value : null;
}

function readMetadataFields(metadata: string | null): MetadataFields {
	if (metadata === null) return EMPTY_METADATA_FIELDS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch {
		return EMPTY_METADATA_FIELDS;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return EMPTY_METADATA_FIELDS;
	}
	const source = parsed as Record<string, unknown>;
	const invalidatedAt: unknown = source["invalidated_at"];
	return {
		tier: readString(source, "tier"),
		state: readString(source, "state"),
		fact_key: readString(source, "fact_key"),
		section_name: readString(source, "section_name"),
		supersedes: readString(source, "supersedes"),
		superseded_by: readString(source, "superseded_by"),
		invalidated_at:
			typeof invalidatedAt === "string" || typeof invalidatedAt === "number"
				? invalidatedAt
				: null,
	};
}

function parseMetadataObject(metadata: string | null): Record<string, unknown> | null {
	if (metadata === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

export function serializeMemoryRow(row: MemoryRow, includeMetadata = false): DumpedMemoryRow {
	const fields = readMetadataFields(row.metadata);
	return {
		id: row.id,
		scope: row.scope,
		text: row.text,
		category: row.category,
		tier: fields.tier,
		timestamp: row.timestamp,
		timezone: row.timezone,
		lane: row.lane,
		disposition_reason: row.disposition_reason,
		dispositioned_at_ms: row.dispositioned_at_ms,
		state: fields.state,
		fact_key: fields.fact_key,
		section_name: fields.section_name,
		supersedes: fields.supersedes,
		superseded_by: fields.superseded_by,
		invalidated_at: fields.invalidated_at,
		...(includeMetadata ? { metadata: parseMetadataObject(row.metadata) } : {}),
	};
}

export async function main(args: string[]): Promise<void> {
	const options = parseMemdumpOptions(args);
	const cleanupManifest = options.manifestPath
		? installRelocatedManifest(options.manifestPath, options.dbPath)
		: undefined;
	try {
		await initSqliteRuntime();
		const handle = openSqliteDatabaseReadonly(options.dbPath);
		try {
			const query = buildMemdumpQuery(options);
			const rows = handle.db.prepare(query.sql).all(...query.params) as MemoryRow[];
			for (const row of rows) {
				process.stdout.write(
					`${JSON.stringify(serializeMemoryRow(row, options.metadata === true))}\n`,
				);
			}
		} finally {
			handle.db.close();
		}
	} finally {
		cleanupManifest?.();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		writeEmergencyDiagnostic({ level: "error", body: "Memory dump failed", attributes: { error, exit_code: 1 }, source: { event_name: "memdump.main.failed", file: "packages/sno-station-mem/src/engine/diagnostics/memdump.ts", function: "<module>", site_id: "memdump.main.failed" } });
		process.exitCode = 1;
	});
}
