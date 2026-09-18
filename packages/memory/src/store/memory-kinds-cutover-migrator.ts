import { PERSISTED_CONTENT_HASH_V1 } from "../model/signed-registry-constants";
/** @file memory-kinds-cutover-migrator.ts
 * @purpose Offline one-time memory-kind cutover and startup invariants.
 * @boundary Raw SQLite migration path only; runtime startup may call the guard.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { readManifestIfPresent, resolveConfigPaths } from "@snoai/sno-station-core-crypto";
import { buildInsightMetadata, parseInsightMetadata, stringifyInsightMetadata } from "../engine/extraction/memory-metadata-codec";
import type { InsightMetadataPatch } from "../engine/extraction/memory-metadata-types";
import {
	getSnoStationMemStateDir,
	runWithMemoryAuditSync,
} from "../engine/operations/runtime-audit-log";
import { StorageError } from "../engine/shared/errors";
import { MEMORY_CATEGORIES, type MemoryCategory } from "../engine/shared/types";
import { stableHash } from "../engine/shared/utils";
import { openSqliteDatabase, type SqliteDatabaseLike } from "./sqlite-runtime";

export const MEMORY_KINDS_FOUNDATION_MARKER = "nodix_memory_kinds_foundation_v1";

const OLD_MEMORY_CATEGORIES = ["identity", "preference", "entity", "event"] as const;
const FOUNDATION_CATEGORY_SET = new Set<string>(MEMORY_CATEGORIES);
const OLD_CATEGORY_SET = new Set<string>(OLD_MEMORY_CATEGORIES);
const MIGRATABLE_SOURCE_VALUES = [
	"manual",
	"ambient-learning",
	"reflection",
	"session-summary",
] as const;
type MigratableSource = (typeof MIGRATABLE_SOURCE_VALUES)[number];
const MIGRATABLE_SOURCES = new Set<string>(MIGRATABLE_SOURCE_VALUES);

type OldMemoryCategory = (typeof OLD_MEMORY_CATEGORIES)[number];

interface MemoryRow {
	id: string;
	text: string;
	category: string;
	projectId: string;
	importance: number;
	timestamp: number;
	metadata: string | null;
	content_hash: string;
}

export interface MemoryKindsCutoverResult {
	status: "migrated" | "noop";
	rewrittenRows: number;
	checkedRows: number;
}

export interface ResetMemoryKindsCutoverDatabaseOptions {
	dbPath: string;
	projectId: string;
	args: string[];
	timestamp?: number;
	log?: (record: Record<string, unknown>) => void;
}

export interface ResetMemoryKindsCutoverDatabaseResult {
	removedFiles: number;
	dbPath: string;
	projectId: string;
	timestamp: number;
}

function createMarkerTable(db: SqliteDatabaseLike): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)",
	);
}

function markerExists(db: SqliteDatabaseLike): boolean {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get("nodix_memory_migration_markers");
	if (!table) return false;
	const row = db
		.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name = ? LIMIT 1")
		.get(MEMORY_KINDS_FOUNDATION_MARKER);
	return row !== undefined;
}

function readRows(db: SqliteDatabaseLike): MemoryRow[] {
	return db
		.prepare(
			"SELECT id, text, category, project_id AS projectId, importance, timestamp, metadata, content_hash FROM nodix_memories ORDER BY id ASC",
		)
		.all() as MemoryRow[];
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function metadataWithoutCategoryFields(metadata: Record<string, unknown>): Record<string, unknown> {
	const sanitized = { ...metadata };
	delete sanitized.kind;
	delete sanitized.memory_category;
	delete sanitized.category;
	return sanitized;
}

function safeTimestamp(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isMigratableSource(value: string): value is MigratableSource {
	return MIGRATABLE_SOURCES.has(value);
}

function migratableSource(value: unknown): InsightMetadataPatch["source"] {
	const source = optionalString(value);
	if (!source || source === "legacy") return "ambient-learning";
	return isMigratableSource(source) ? source : "ambient-learning";
}

function numericOr(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function countOr(value: unknown, fallback: number): number {
	const n = numericOr(value, fallback);
	return n >= 0 ? Math.floor(n) : fallback;
}

function slugSectionToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function stripPrefix(value: string, prefix: string): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function resolvePreferenceSection(metadata: Record<string, unknown>): string | undefined {
	const sectionName = optionalString(metadata.section_name);
	if (sectionName?.startsWith("preferences.")) return sectionName;
	const topic = optionalString(metadata.topic ?? metadata.preference_topic ?? metadata.preferenceTopic);
	if (topic) {
		const slug = slugSectionToken(topic);
		return slug ? `preferences.${slug}` : undefined;
	}
	const factKey = optionalString(metadata.fact_key);
	if (factKey) {
		const profileSection = stripPrefix(factKey, "profile:");
		if (profileSection?.startsWith("preferences.")) return profileSection;
		const preferenceTopic = stripPrefix(factKey, "preference:");
		if (preferenceTopic) {
			const slug = slugSectionToken(preferenceTopic);
			return slug ? `preferences.${slug}` : undefined;
		}
	}
	return undefined;
}

function resolveEntitySection(metadata: Record<string, unknown>): string | undefined {
	const sectionName = optionalString(metadata.section_name);
	if (sectionName?.startsWith("entities.")) return sectionName;
	const factKey = optionalString(metadata.fact_key);
	if (factKey) {
		const profileSection = stripPrefix(factKey, "profile:");
		if (profileSection?.startsWith("entities.")) return profileSection;
		const entityFactKey = stripPrefix(factKey, "entity:");
		if (entityFactKey) {
			const slug = slugSectionToken(entityFactKey);
			return slug ? `entities.${slug}` : undefined;
		}
	}
	for (const key of ["entity_id", "entityId", "canonical_id", "entity_name", "entityName", "name"]) {
		const value = optionalString(metadata[key]);
		if (!value) continue;
		const slug = slugSectionToken(value);
		if (slug) return `entities.${slug}`;
	}
	return undefined;
}

function resolveLessonSignature(metadata: Record<string, unknown>): string | undefined {
	const signature = optionalString(metadata.anti_pattern_signature);
	if (signature) return signature;
	const factKey = optionalString(metadata.fact_key);
	const factSignature = factKey ? stripPrefix(factKey, "lesson:") : undefined;
	return optionalString(factSignature);
}

function mapRowCategory(row: MemoryRow, metadata: Record<string, unknown>): {
	category: MemoryCategory;
	variantPatch: InsightMetadataPatch;
	changed: boolean;
} {
	if (FOUNDATION_CATEGORY_SET.has(row.category)) {
		return { category: row.category as MemoryCategory, variantPatch: {}, changed: false };
	}
	if (!OLD_CATEGORY_SET.has(row.category)) {
		throw new StorageError(
			`memory-kinds-foundation offline migrator cannot map row ${row.id}: unknown category "${row.category}"`,
		);
	}

	const oldCategory = row.category as OldMemoryCategory;
	if (oldCategory === "identity") {
		return { category: "profile", variantPatch: { section_name: "identity" }, changed: true };
	}
	if (oldCategory === "preference") {
		const sectionName = resolvePreferenceSection(metadata);
		if (!sectionName) {
			throw new StorageError(
				`memory-kinds-foundation offline migrator cannot map row ${row.id}: missing preference topic/section_name`,
			);
		}
		return { category: "profile", variantPatch: { section_name: sectionName }, changed: true };
	}
	if (oldCategory === "entity") {
		const sectionName = resolveEntitySection(metadata);
		if (sectionName) {
			return { category: "profile", variantPatch: { section_name: sectionName }, changed: true };
		}
		return {
			category: "episodic",
			variantPatch: { entity_kind: optionalString(metadata.entity_kind) },
			changed: true,
		};
	}
	if (oldCategory === "event") {
		return { category: "episodic", variantPatch: { event_at: metadata.event_at }, changed: true };
	}

	throw new StorageError(
		`memory-kinds-foundation offline migrator cannot map row ${row.id}: unsupported category "${row.category}"`,
	);
}

function buildBasePatch(
	row: MemoryRow,
	metadata: Record<string, unknown>,
	category: MemoryCategory,
	migrationStartTime: number,
): InsightMetadataPatch {
	const rowTimestamp = safeTimestamp(row.timestamp, migrationStartTime);
	const source = optionalString(metadata.source);
	const patch: InsightMetadataPatch = {
		kind: category,
		memory_category: category,
		l0_abstract: optionalString(metadata.l0_abstract) ?? row.text,
		l1_overview: optionalString(metadata.l1_overview) ?? `- ${row.text}`,
		l2_content: optionalString(metadata.l2_content) ?? row.text,
		tier: "core",
		access_count: countOr(metadata.access_count ?? metadata.accessCount, 0),
		confidence: numericOr(metadata.confidence, 0.5),
		last_accessed_at: rowTimestamp,
		asserted_at: rowTimestamp,
		valid_from: rowTimestamp,
		state: "confirmed",
		source: migratableSource(metadata.source),
		injected_count: countOr(metadata.injected_count, 0),
		bad_recall_count: countOr(metadata.bad_recall_count, 0),
		suppressed_until_turn: countOr(metadata.suppressed_until_turn, 0),
	};
	if (source === "legacy") {
		patch.migrated_from_source = "legacy";
	}
	return patch;
}

function buildMigratedRow(
	row: MemoryRow,
	migrationStartTime: number,
): { category: MemoryCategory; metadata: string; contentHash: string; changed: boolean } {
	const parsedMetadata = parseJsonObject(row.metadata);
	const mapped = mapRowCategory(row, parsedMetadata);
	const patch: InsightMetadataPatch = {
		...buildBasePatch(row, parsedMetadata, mapped.category, migrationStartTime),
		...mapped.variantPatch,
	};
	if (mapped.category === "lesson") {
		const antiPatternSignature =
			resolveLessonSignature(parsedMetadata) ?? optionalString(mapped.variantPatch.anti_pattern_signature);
		if (!antiPatternSignature) {
			throw new StorageError(
				`memory-kinds-foundation offline migrator cannot map row ${row.id}: missing anti_pattern_signature`,
			);
		}
		patch.anti_pattern_signature = antiPatternSignature;
	}
	const timestamp = safeTimestamp(row.timestamp, migrationStartTime);
	let metadata: ReturnType<typeof buildInsightMetadata>;
	try {
		const sanitizedMetadata = metadataWithoutCategoryFields(parsedMetadata);
		metadata = buildInsightMetadata(
			{
				text: row.text,
				category: mapped.category,
				timestamp,
				metadata: JSON.stringify(sanitizedMetadata),
			},
			patch,
		);
	} catch (error) {
		throw new StorageError(
			`memory-kinds-foundation offline migrator failed row ${row.id}: ${(error as Error).message}`,
			error,
		);
	}
	const serialized = stringifyInsightMetadata(metadata);
	return {
		category: mapped.category,
		metadata: serialized,
		contentHash: stableHash(hashInputForMigratedEntry(row.text, serialized)),
		changed:
			mapped.changed ||
			row.metadata !== serialized ||
			row.content_hash !== stableHash(hashInputForMigratedEntry(row.text, serialized)),
	};
}

function hashInputForMigratedEntry(text: string, metadata: string): string {
	const parsed = parseJsonObject(metadata);
	const mergeLineage = Array.isArray(parsed.merge_lineage)
		? parsed.merge_lineage.filter((item): item is string => typeof item === "string")
		: [];
	if (mergeLineage.length > 0) {
		return JSON.stringify([PERSISTED_CONTENT_HASH_V1, text, { merge_lineage: mergeLineage }]);
	}
	const mappedKind = parsed.mappedKind;
	if (typeof mappedKind === "string" && mappedKind.length > 0) {
		return JSON.stringify([PERSISTED_CONTENT_HASH_V1, text, mappedKind]);
	}
	return text;
}

function validateFoundationInvariants(db: SqliteDatabaseLike): number {
	const rows = readRows(db);
	for (const row of rows) {
		if (!FOUNDATION_CATEGORY_SET.has(row.category)) {
			throw new StorageError(
				`memory-kinds-foundation startup guard failed row ${row.id}: category "${row.category}" is not a foundation kind; run the offline migrator`,
			);
		}
		try {
			parseInsightMetadata(row.metadata ?? undefined, {
				text: row.text,
				category: row.category as MemoryCategory,
				timestamp: row.timestamp,
			});
		} catch (error) {
			throw new StorageError(
				`memory-kinds-foundation startup guard failed row ${row.id}: ${(error as Error).message}; run the offline migrator`,
				error,
			);
		}
	}
	return rows.length;
}

function countNonFoundationRows(db: SqliteDatabaseLike): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS count FROM nodix_memories WHERE category NOT IN (${MEMORY_CATEGORIES.map(() => "?").join(", ")})`,
		)
		.get(...MEMORY_CATEGORIES) as { count?: number | bigint } | undefined;
	const rawCount = row?.count ?? 0;
	return typeof rawCount === "bigint" ? Number(rawCount) : Number(rawCount);
}

export function assertMemoryKindsCutoverStartupGuard(db: SqliteDatabaseLike): void {
	if (markerExists(db)) {
		// Marker present = the cutover ran and validated its invariants at
		// migration time. The former per-boot validateFoundationInvariants() here
		// re-read and JSON-parsed EVERY memory row on EVERY startup — a linear
		// boot cost that re-proved an already-proven state. The marker check
		// alone is the steady-state guard; the full validation still runs inside
		// runMemoryKindsCutoverMigration itself.
		return;
	}
	const nonFoundationRows = countNonFoundationRows(db);
	if (nonFoundationRows > 0) {
		throw new StorageError(
			`memory-kinds-foundation startup guard found ${nonFoundationRows} old/unknown category row(s) without marker ${MEMORY_KINDS_FOUNDATION_MARKER}; run the offline migrator before starting the runtime`,
		);
	}
}

export function runMemoryKindsCutoverMigration(args: {
	dbPath: string;
	now?: number;
}): MemoryKindsCutoverResult {
	return runWithMemoryAuditSync({
		stateDir: getSnoStationMemStateDir(),
		event: "memory_updated",
		operation: "runMemoryKindsCutoverMigration",
		run: () => runMemoryKindsCutoverMigrationUnaudited(args),
		completedDetails: (result) => ({
			migration_status: result.status,
			rewritten_rows: result.rewrittenRows,
			checked_rows: result.checkedRows,
		}),
	});
}

function runMemoryKindsCutoverMigrationUnaudited(args: {
	dbPath: string;
	now?: number;
}): MemoryKindsCutoverResult {
	const migrationStartTime = args.now ?? Date.now();
	const sqlite = openSqliteDatabase(args.dbPath);
	try {
		const tx = sqlite.db.transaction((): MemoryKindsCutoverResult => {
			createMarkerTable(sqlite.db);
			if (markerExists(sqlite.db)) {
				return { status: "noop", rewrittenRows: 0, checkedRows: validateFoundationInvariants(sqlite.db) };
			}

			// Known limitation (host adversarial review 2026-07-13, not fixed
			// here): two legacy rows that remap to the same (project, category)
			// and hash to the same content_hash after migration collide on the
			// UNIQUE(project_id, content_hash, category) index. This UPDATE then
			// throws and the whole transaction rolls back — fails safe (no
			// corruption, migration just doesn't complete), but blocks startup
			// until an operator resolves the source rows. A real fix needs
			// precomputed uniqueness keys and either a deterministic merge or an
			// explicit per-row collision report; deferred as a follow-up rather
			// than rushed into this offline, operator-run migration.
			const rows = readRows(sqlite.db);
			let rewrittenRows = 0;
			for (const row of rows) {
				const migrated = buildMigratedRow(row, migrationStartTime);
				if (migrated.changed) rewrittenRows += 1;
				sqlite.db
					.prepare(
						"UPDATE nodix_memories SET category = ?, metadata = ?, content_hash = ? WHERE id = ?",
					)
					.run(migrated.category, migrated.metadata, migrated.contentHash, row.id);
			}
			sqlite.db
				.prepare(
					"INSERT INTO nodix_memory_migration_markers (name, applied_at, payload) VALUES (?, ?, ?)",
				)
				.run(
					MEMORY_KINDS_FOUNDATION_MARKER,
					migrationStartTime,
					JSON.stringify({ rewrittenRows, checkedRows: rows.length }),
				);
			const checkedRows = validateFoundationInvariants(sqlite.db);
			return { status: "migrated", rewrittenRows, checkedRows };
		}) as { immediate: () => MemoryKindsCutoverResult };
		return tx.immediate();
	} finally {
		sqlite.db.close();
	}
}

function removeDbManifestEntry(dbPath: string): void {
	const manifest = readManifestIfPresent();
	if (!manifest) return;
	const normalizedDbPath = resolvePath(dbPath);
	const nextDbs = manifest.dbs.filter((entry) => entry.path !== normalizedDbPath);
	if (nextDbs.length === manifest.dbs.length) return;
	const { manifestFile, configDir } = resolveConfigPaths();
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const tmp = `${manifestFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
	writeFileSync(
		tmp,
		JSON.stringify({
			schemaVersion: manifest.schemaVersion,
			createdAt: manifest.createdAt,
			dbs: nextDbs,
		}),
	);
	renameSync(tmp, manifestFile);
}

export function resetMemoryKindsCutoverDatabase(
	options: ResetMemoryKindsCutoverDatabaseOptions,
): ResetMemoryKindsCutoverDatabaseResult {
	let memoryCount: number | undefined;
	return runWithMemoryAuditSync({
		stateDir: getSnoStationMemStateDir(),
		event: "memory_deleted",
		operation: "resetMemoryKindsCutoverDatabase",
		scope: options.projectId,
		startedDetails: {
			scope: options.projectId,
			delete_reason: "memory_kinds_cutover_reset",
		},
		run: () => {
			memoryCount = readResetMemoryCount(options.dbPath);
			return resetMemoryKindsCutoverDatabaseUnaudited(options);
		},
		completedDetails: (result) => {
			const outcome: "deleted" | "noop" = result.removedFiles > 0 ? "deleted" : "noop";
			return {
				scope: options.projectId,
				delete_reason: "memory_kinds_cutover_reset",
				outcome,
				removed_files: result.removedFiles,
				...(memoryCount === undefined ? {} : { count: memoryCount }),
			};
		},
	});
}

function readResetMemoryCount(dbPath: string): number | undefined {
	if (!existsSync(dbPath)) return 0;
	let sqlite: ReturnType<typeof openSqliteDatabase> | undefined;
	try {
		sqlite = openSqliteDatabase(dbPath);
		const row = sqlite.db.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get() as
			| { count?: number | bigint }
			| undefined;
		const count = row?.count;
		if (typeof count === "bigint") return Number(count);
		return typeof count === "number" ? count : undefined;
	} catch {
		return undefined;
	} finally {
		sqlite?.db.close();
	}
}

function resetMemoryKindsCutoverDatabaseUnaudited(
	options: ResetMemoryKindsCutoverDatabaseOptions,
): ResetMemoryKindsCutoverDatabaseResult {
	const timestamp = options.timestamp ?? Date.now();
	const record = {
		event: "memory_kinds_foundation_destructive_reset",
		dbPath: options.dbPath,
		projectId: options.projectId,
		timestamp,
		args: options.args,
	};
	options.log?.(record);

	removeDbManifestEntry(options.dbPath);
	let removedFiles = 0;
	for (const suffix of ["", "-shm", "-wal"]) {
		const target = `${options.dbPath}${suffix}`;
		if (!existsSync(target)) continue;
		rmSync(target);
		removedFiles += 1;
	}
	return { removedFiles, dbPath: options.dbPath, projectId: options.projectId, timestamp };
}
