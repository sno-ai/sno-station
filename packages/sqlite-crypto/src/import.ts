/** @file import.ts
 * @purpose `.nodix` import — structural gate (magic, version) BEFORE GCM
 *   attempt; cross-machine fingerprint check (`SHA-256(local_DEK)[:4]`)
 *   BEFORE GCM attempt; layered errors per spec.
 */

import { createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { getDek } from "./dek.js";
import {
	ForeignDekError,
	IntegrityCheckFailed,
	InvalidExportFormat,
	UnsupportedExportVersion,
} from "./errors.js";
import {
	NODIX_HEADER_LEN,
	NODIX_MAGIC,
	NODIX_NONCE_LEN,
	NODIX_TAG_LEN,
	NODIX_VERSION_V1,
} from "./export.js";
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
	// classes from authentication failures (per nodix-export-format spec).
	if (bytes.length < NODIX_HEADER_LEN + NODIX_NONCE_LEN + NODIX_TAG_LEN) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: file is too short to be a .nodix export (got ${bytes.length} bytes)`,
		);
	}
	if (!bytes.subarray(0, NODIX_MAGIC.length).equals(NODIX_MAGIC)) {
		throw new InvalidExportFormat(
			`InvalidExportFormat: missing magic bytes 'NODIX01'`,
		);
	}
	const version = bytes[NODIX_MAGIC.length];
	if (version !== NODIX_VERSION_V1) {
		throw new UnsupportedExportVersion(
			`UnsupportedExportVersion: header version 0x${version?.toString(16) ?? "??"}, only 0x01 supported`,
		);
	}
	const header = bytes.subarray(0, NODIX_HEADER_LEN);
	const sourceFingerprint = bytes.subarray(8, NODIX_HEADER_LEN);
	const nonce = bytes.subarray(NODIX_HEADER_LEN, NODIX_HEADER_LEN + NODIX_NONCE_LEN);
	const ciphertextEnd = bytes.length - NODIX_TAG_LEN;
	const ciphertext = bytes.subarray(NODIX_HEADER_LEN + NODIX_NONCE_LEN, ciphertextEnd);
	const tag = bytes.subarray(ciphertextEnd);
	return { header, sourceFingerprint, nonce, ciphertext, tag };
}

interface TarEntry {
	name: string;
	data: Buffer;
}

function restorePathForEntry(entryName: string): string {
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
	return `/${normalized}`;
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

export async function importEncrypted(sourcePath: string): Promise<void> {
	const bytes = readFileSync(sourcePath);
	const { header, sourceFingerprint, nonce, ciphertext, tag } = parseStructure(bytes);

	// Cross-machine gate: BEFORE any GCM attempt.
	const dek = await getDek();
	const localFp = dekFingerprint4(dek);
	if (!localFp.equals(sourceFingerprint)) {
		throw new ForeignDekError(
			"ForeignDekError: this .nodix file was encrypted with a different DEK fingerprint. " +
				"Cross-machine restore requires the v1.1 `nodix lock --import-dek <hex>` workflow (deferred).",
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
	for (const e of entries) {
		const restorePath = restorePathForEntry(e.name);
		mkdirSync(dirname(restorePath), { recursive: true });
		writeFileSync(restorePath, e.data, { mode: 0o600 });
	}
}
