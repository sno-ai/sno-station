/** @file install-manifest.ts
 * @purpose Schema, atomic write, and read+validate for `install.json`. The
 *   manifest is the single source of truth that lets a reinstalled plugin
 *   reattach to the user's existing memory library.
 * @boundary File I/O on a single JSON file. No SQLite, no DEK access.
 */

import {
	closeSync,
	chmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createUUIDv7, isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import { z } from "zod";

export const CURRENT_DATA_FORMAT_VERSION = 1;
export const INSTALL_MANIFEST_TEMP_SUFFIX = ".tmp-";

/** Manifest shape, named so the schema can be annotated without restating it. */
export interface InstallManifestShape {
	schemaVersion: 1;
	dataFormatVersion: 1;
	installationId: string;
	createdAt: string;
	dbPath: string;
	keyServiceName: string;
	keyAccount: string;
}

/** PRD §3.2 schema. No `lastSeenVersion` / `lastSeenAt`. */
export const InstallManifestSchema: z.ZodType<InstallManifestShape, unknown> = z.object({
	schemaVersion: z.literal(1),
	dataFormatVersion: z.literal(CURRENT_DATA_FORMAT_VERSION),
	installationId: z.string().refine(isLowercaseCanonicalUUIDv7, {
		message: "installationId must be a lowercase canonical UUID-v7",
	}),
	createdAt: z.string().datetime(),
	dbPath: z.string().min(1),
	keyServiceName: z.string().min(1),
	keyAccount: z.string().min(1),
});

export type InstallManifest = z.infer<typeof InstallManifestSchema>;

/** Thrown when the on-disk manifest fails Zod validation or JSON parsing. */
export class ManifestSchemaError extends Error {
	readonly kind = "ManifestSchemaError" as const;
	constructor(
		readonly path: string,
		cause: unknown,
	) {
		super(
			`install manifest at ${path} is corrupt or has unexpected schema: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause: cause instanceof Error ? cause : undefined },
		);
		this.name = "ManifestSchemaError";
	}
}

/**
 * Thrown when the data dir contains user data (DB / audit log / cost log) but
 * `install.json` is missing. Per PRD §3.3 we refuse to do anything destructive
 * here; the user must restore `install.json` from backup or move the data aside.
 */
export class ManifestMissingButDataPresentError extends Error {
	readonly kind = "ManifestMissingButDataPresentError" as const;
	constructor(readonly dataDir: string) {
		super(
			`install.json is missing but the data dir at ${dataDir} contains user data; ` +
				"refusing to overwrite. Restore install.json from backup or move the data aside.",
		);
		this.name = "ManifestMissingButDataPresentError";
	}
}

/** Read + Zod-validate `install.json`. Throws `ManifestSchemaError` on any failure. */
export function readInstallManifest(path: string): InstallManifest {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		throw new ManifestSchemaError(path, err);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ManifestSchemaError(path, err);
	}
	const result = InstallManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new ManifestSchemaError(path, result.error);
	}
	return result.data;
}

/**
 * Atomic write: tmp → fsync(tmp) → rename(tmp, target) → fsync(parent dir).
 * POSIX rename is atomic on local FS; the parent fsync makes the rename
 * durable across a power loss. Mode 0644 (no secrets in the manifest).
 */
export function writeInstallManifestAtomic(path: string, manifest: InstallManifest): void {
	const validated = InstallManifestSchema.parse(manifest);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}${INSTALL_MANIFEST_TEMP_SUFFIX}${process.pid}-${Date.now().toString(36)}`;
	writeFileSync(tmp, JSON.stringify(validated), { mode: 0o644 });
	chmodSync(tmp, 0o644);
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const dirFd = openSync(dir, 0);
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/** Build a fresh manifest at first-install time. UUIDv7 for time-ordering. */
export function freshInstallManifest(args: {
	dbPath: string;
	keyServiceName: string;
	keyAccount: string;
	createdAt?: string;
}): InstallManifest {
	return InstallManifestSchema.parse({
		schemaVersion: 1,
		dataFormatVersion: CURRENT_DATA_FORMAT_VERSION,
		installationId: createUUIDv7(),
		createdAt: args.createdAt ?? new Date().toISOString(),
		dbPath: args.dbPath,
		keyServiceName: args.keyServiceName,
		keyAccount: args.keyAccount,
	});
}

/**
 * Resolve `manifest.dbPath` against `dataDir`. Relative paths join with the
 * manifest's data dir; absolute paths are honored verbatim (PRD §3.2 — only
 * when the user explicitly configured a custom `config.dbPath`).
 */
export function resolveDbPath(manifest: InstallManifest, dataDir: string): string {
	return isAbsolute(manifest.dbPath) ? manifest.dbPath : join(dataDir, manifest.dbPath);
}
