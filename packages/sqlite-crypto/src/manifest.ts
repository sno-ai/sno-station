import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { open as openHandle, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveConfigPaths } from "./config.js";
import { ManifestCorrupted } from "./errors.js";
import { crashAfter } from "./fault-injection.js";
import { writeNewSecretFile } from "./key-file.js";
import {
	type DbId,
	type DekFingerprint,
	MANIFEST_SCHEMA_VERSION,
	type ManifestEntry,
	type ManifestFile,
} from "./types.js";

/**
 * Returns the parsed manifest, or `undefined` if the file does not exist.
 * On any parse failure or unrecognized `schemaVersion`, throws
 * `ManifestCorrupted`. Never auto-rebuilds.
 */
export function readManifestIfPresent(): ManifestFile | undefined {
	const { manifestFile } = resolveConfigPaths();
	if (!existsSync(manifestFile)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(manifestFile, "utf8");
	} catch (err) {
		throw new ManifestCorrupted(
			`failed to read manifest at ${manifestFile}: ${(err as Error).message}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ManifestCorrupted(
			`manifest at ${manifestFile} is not valid JSON`,
			{
				cause: err,
			},
		);
	}
	return validateManifest(parsed, manifestFile);
}

export function isManifestPresent(): boolean {
	return existsSync(resolveConfigPaths().manifestFile);
}

export function isMarkerPresent(): boolean {
	return existsSync(resolveConfigPaths().markerFile);
}

function validateManifest(input: unknown, path: string): ManifestFile {
	if (typeof input !== "object" || input === null) {
		throw new ManifestCorrupted(`manifest at ${path} is not an object`);
	}
	const obj = input as Record<string, unknown>;
	if (obj["schemaVersion"] !== MANIFEST_SCHEMA_VERSION) {
		throw new ManifestCorrupted(
			`manifest at ${path} has unsupported schemaVersion ${String(obj["schemaVersion"])}`,
		);
	}
	const createdAt = obj["createdAt"];
	if (typeof createdAt !== "string") {
		throw new ManifestCorrupted(`manifest at ${path} missing string createdAt`);
	}
	const dbsRaw = obj["dbs"];
	if (!Array.isArray(dbsRaw)) {
		throw new ManifestCorrupted(`manifest at ${path} missing dbs array`);
	}
	const dbs: ManifestEntry[] = [];
	for (const e of dbsRaw) {
		if (typeof e !== "object" || e === null) {
			throw new ManifestCorrupted(
				`manifest at ${path} contains a non-object dbs entry`,
			);
		}
		const ent = e as Record<string, unknown>;
		const entPath = ent["path"];
		const entDbId = ent["dbId"];
		const entFp = ent["dekFingerprint"];
		if (
			typeof entPath !== "string" ||
			typeof entDbId !== "string" ||
			typeof entFp !== "string"
		) {
			throw new ManifestCorrupted(
				`manifest at ${path} contains an entry missing required fields`,
			);
		}
		dbs.push({
			path: entPath,
			dbId: entDbId as DbId,
			dekFingerprint: entFp as DekFingerprint,
		});
	}
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		createdAt,
		dbs,
	};
}

/**
 * Create the marker file via the canonical recipe. No-op if already present.
 */
export function ensureMarker(): void {
	const { markerFile, configDir } = resolveConfigPaths();
	if (existsSync(markerFile)) return;
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	writeNewSecretFile(markerFile, Buffer.alloc(0));
	// Test fault-injection hook (design D18). Default off.
	crashAfter("after-marker-before-manifest");
}

/**
 * Atomically write a fresh manifest file. Caller is responsible for ordering
 * (must call `ensureMarker()` before the FIRST manifest rename per the
 * round-7 ordering rule).
 */
export async function atomicWriteManifest(next: ManifestFile): Promise<void> {
	const { manifestFile, configDir } = resolveConfigPaths();
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const serialized = JSON.stringify(next);
	const tmp = `${manifestFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
	// We accept temp-files at mode 0644 for the manifest (it is not secret —
	// dbIds and dekFingerprints are one-way values), but write via the canonical
	// recipe still for crash-safe semantics.
	// fsync the tmp file before rename so the directory entry installed by
	// rename can never point at unflushed pages on a power loss.
	const fd = openSync(tmp, "w", 0o644);
	try {
		const payload = Buffer.from(serialized, "utf8");
		let written = 0;
		while (written < payload.length) {
			const n = writeSync(
				fd,
				payload,
				written,
				payload.length - written,
				written,
			);
			if (n <= 0) {
				throw new Error(
					`writeSync returned ${n} for ${tmp} after ${written}/${payload.length} bytes`,
				);
			}
			written += n;
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// We cannot literally interrupt the rename syscall from JS; the fault
	// model here is "killed before rename completes." Exit before rename.
	crashAfter("during-manifest-rename");
	await rename(tmp, manifestFile);
	const dirHandle = await openHandle(dirname(manifestFile), "r");
	try {
		await dirHandle.sync();
	} finally {
		await dirHandle.close();
	}
}

export function emptyManifest(): ManifestFile {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		createdAt: new Date().toISOString(),
		dbs: [],
	};
}

/**
 * Find a database's entry by the id the database carries inside itself.
 *
 * Identity is the id in the canary row, never the file's location. A store that
 * is moved, copied to a new machine, or served from a different mount is the
 * same database and must still open; keying this lookup on the path is what
 * made a relocated store unopenable while its contents were perfectly intact.
 * `entry.path` remains as bookkeeping — it records where the database was last
 * seen, and `openEncryptedDb` uses it to tell a move apart from a duplicate.
 */
export function findEntry(
	manifest: ManifestFile,
	dbId: string,
): ManifestEntry | undefined {
	return manifest.dbs.find((d) => d.dbId === dbId);
}

/** Same manifest with one entry's last-seen path updated. */
export function withEntryPath(
	manifest: ManifestFile,
	dbId: DbId,
	path: string,
): ManifestFile {
	return {
		schemaVersion: manifest.schemaVersion,
		createdAt: manifest.createdAt,
		dbs: manifest.dbs.map((d) => (d.dbId === dbId ? { ...d, path } : d)),
	};
}

export function appendEntry(
	manifest: ManifestFile,
	entry: ManifestEntry,
): ManifestFile {
	return {
		schemaVersion: manifest.schemaVersion,
		createdAt: manifest.createdAt,
		dbs: [...manifest.dbs, entry],
	};
}
