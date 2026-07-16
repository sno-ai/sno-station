/** @file import.ts
 * @purpose `.sno-station-core` import — structural gate (magic, version) BEFORE GCM
 *   attempt; cross-machine fingerprint check (`SHA-256(local_DEK)[:4]`)
 *   BEFORE GCM attempt; layered errors per spec.
 */

import { createDecipheriv } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { _readCanaryForRecovery } from "./db.js";
import { getDek } from "./dek.js";
import {
	ForeignDekError,
	IntegrityCheckFailed,
	InvalidExportFormat,
	UnsupportedExportVersion,
} from "./errors.js";
import {
	SNO_STATION_CORE_HEADER_LEN,
	SNO_STATION_CORE_MAGIC,
	SNO_STATION_CORE_NONCE_LEN,
	SNO_STATION_CORE_TAG_LEN,
	SNO_STATION_CORE_VERSION_V1,
} from "./export.js";
import { readManifestIfPresent } from "./manifest.js";
import { CANARY_SENTINEL, type Dek, type ManifestEntry } from "./types.js";
import { dekFingerprint4 } from "./wrap.js";

interface ParsedHeader {
	header: Buffer;
	sourceFingerprint: Buffer;
	nonce: Buffer;
	ciphertext: Buffer;
	tag: Buffer;
}

function parseStructure(bytes: Buffer): ParsedHeader {
	// Structural gate: magic + version. These are the only checks before any
	// fingerprint comparison or GCM attempt. They MUST raise distinct error
	// classes from authentication failures (per sno-station-core-export-format spec).
	if (bytes.length < SNO_STATION_CORE_HEADER_LEN + SNO_STATION_CORE_NONCE_LEN + SNO_STATION_CORE_TAG_LEN) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: file is too short to be a .sno-station-core export (got ${bytes.length} bytes)`,
		);
	}
	if (!bytes.subarray(0, SNO_STATION_CORE_MAGIC.length).equals(SNO_STATION_CORE_MAGIC)) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: missing magic bytes 'SNO_STATION_CORE01'`,
		);
	}
	const version = bytes[SNO_STATION_CORE_MAGIC.length];
	if (version !== SNO_STATION_CORE_VERSION_V1) {
		throw new UnsupportedExportVersion(
			`UnsupportedExportVersion: header version 0x${version?.toString(16) ?? "??"}, only 0x01 supported`,
		);
	}
	const header = bytes.subarray(0, SNO_STATION_CORE_HEADER_LEN);
	const sourceFingerprint = bytes.subarray(
		SNO_STATION_CORE_MAGIC.length + 1,
		SNO_STATION_CORE_HEADER_LEN,
	);
	const nonce = bytes.subarray(
		SNO_STATION_CORE_HEADER_LEN,
		SNO_STATION_CORE_HEADER_LEN + SNO_STATION_CORE_NONCE_LEN,
	);
	const ciphertextEnd = bytes.length - SNO_STATION_CORE_TAG_LEN;
	const ciphertext = bytes.subarray(
		SNO_STATION_CORE_HEADER_LEN + SNO_STATION_CORE_NONCE_LEN,
		ciphertextEnd,
	);
	const tag = bytes.subarray(ciphertextEnd);
	return { header, sourceFingerprint, nonce, ciphertext, tag };
}

interface TarEntry {
	name: string;
	data: Buffer;
}

function normalizeArchiveEntryName(entryName: string): string {
	const parts = entryName.split("/");
	if (
		entryName.length === 0 ||
		entryName.startsWith("/") ||
		entryName.includes("\0") ||
		parts.includes("..")
	) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: unsafe archive entry path '${entryName}'`,
		);
	}
	const normalized = posix.normalize(entryName);
	if (normalized === ".") {
		throw new InvalidExportFormat(
			`InvalidExportFormat: unsafe archive entry path '${entryName}'`,
		);
	}
	return normalized;
}

function restoreEntriesByArchiveEntry(): ReadonlyMap<string, ManifestEntry> {
	const manifest = readManifestIfPresent();
	const entries = new Map<string, ManifestEntry>();
	for (const entry of manifest?.dbs ?? []) {
		const archivePath = normalizeArchiveEntryName(
			entry.path.replace(/^\/+/, ""),
		);
		entries.set(archivePath, entry);
	}
	return entries;
}

function restoreEntryForArchiveEntry(
	entryName: string,
	restoreEntries: ReadonlyMap<string, ManifestEntry>,
): ManifestEntry {
	const normalized = normalizeArchiveEntryName(entryName);
	const entry = restoreEntries.get(normalized);
	if (!entry) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: archive entry is not registered in local manifest '${entryName}'`,
		);
	}
	return entry;
}

async function extractTarball(plaintext: Buffer): Promise<TarEntry[]> {
	const tarBytes = gunzipSync(plaintext);
	return new Promise<TarEntry[]>((resolve, reject) => {
		const entries: TarEntry[] = [];
		const ext = extract();
		ext.on("entry", (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on("data", (c: Buffer) => chunks.push(c));
			stream.on("end", () => {
				entries.push({ name: header.name, data: Buffer.concat(chunks) });
				next();
			});
			stream.on("error", reject);
			stream.resume();
		});
		ext.on("finish", () => resolve(entries));
		ext.on("error", reject);
		ext.end(tarBytes);
	});
}

function verifyRestoredDb(
	dbPath: string,
	entry: ManifestEntry,
	dek: Dek,
): void {
	let row: { sentinel: string; db_id: string } | undefined;
	try {
		row = _readCanaryForRecovery(dbPath, dek);
	} catch (err) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: restored archive entry '${entry.path}' is not a readable encrypted DB`,
			{ cause: err },
		);
	}
	if (!row) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: restored archive entry '${entry.path}' has no canary row`,
		);
	}
	if (row.sentinel !== CANARY_SENTINEL) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: restored archive entry '${entry.path}' has an invalid canary sentinel`,
		);
	}
	if (row.db_id !== entry.dbId) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: restored archive entry '${entry.path}' has db_id ${row.db_id}, expected ${entry.dbId}`,
		);
	}
}

export async function importEncrypted(sourcePath: string): Promise<void> {
	const bytes = readFileSync(sourcePath);
	const { header, sourceFingerprint, nonce, ciphertext, tag } =
		parseStructure(bytes);

	// Cross-machine gate: BEFORE any GCM attempt.
	const dek = await getDek();
	const localFp = dekFingerprint4(dek);
	if (!localFp.equals(sourceFingerprint)) {
		throw new ForeignDekError(
			"ForeignDekError: this .sno-station-core file was encrypted with a different DEK fingerprint. " +
				"Cross-machine restore requires the v1.1 `sno-station-core lock --import-dek <hex>` workflow (deferred).",
		);
	}

	const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
	decipher.setAAD(header);
	decipher.setAuthTag(tag);
	let plaintext: Buffer;
	try {
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch (err) {
		throw new IntegrityCheckFailed(
			"IntegrityCheckFailed: GCM authentication failed — header AAD or ciphertext tampered",
			{ cause: err },
		);
	}

	const entries = await extractTarball(plaintext);
	const restoreEntries = restoreEntriesByArchiveEntry();
	for (const e of entries) {
		const manifestEntry = restoreEntryForArchiveEntry(e.name, restoreEntries);
		const restorePath = manifestEntry.path;
		const tmpPath = `${restorePath}.import-${process.pid}-${Date.now().toString(36)}`;
		mkdirSync(dirname(restorePath), { recursive: true });
		try {
			writeFileSync(tmpPath, e.data, { mode: 0o600 });
			verifyRestoredDb(tmpPath, manifestEntry, dek);
			renameSync(tmpPath, restorePath);
		} catch (err) {
			rmSync(tmpPath, { force: true });
			throw err;
		}
	}
}
