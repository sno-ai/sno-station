/** @file export.ts
 * @purpose `.sno-station-core` AES-256-GCM export bundle producer. Spec:
 *   `openspec/changes/add-local-aes-encryption/specs/sno-station-core-export-format/spec.md`.
 *   Layout: `magic(18) ‖ version(1) ‖ source_dek_fingerprint(4) ‖ nonce(12) ‖
 *   ciphertext(N) ‖ tag(16)` where AAD is the complete header.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { getDek } from "./dek.js";
import { readManifestIfPresent } from "./manifest.js";
import { dekFingerprint4 } from "./wrap.js";

export const SNO_STATION_CORE_MAGIC = Buffer.from("SNO_STATION_CORE01", "ascii");
export const SNO_STATION_CORE_VERSION_V1 = 0x01;
export const SNO_STATION_CORE_HEADER_LEN = SNO_STATION_CORE_MAGIC.length + 1 + 4;
export const SNO_STATION_CORE_NONCE_LEN = 12;
export const SNO_STATION_CORE_TAG_LEN = 16;

function buildHeader(fingerprint: Buffer): Buffer {
	if (fingerprint.length !== 4) {
		throw new Error(`source_dek_fingerprint must be 4 bytes, got ${fingerprint.length}`);
	}
	const versionByte = Buffer.alloc(1);
	versionByte[0] = SNO_STATION_CORE_VERSION_V1;
	return Buffer.concat([SNO_STATION_CORE_MAGIC, versionByte, fingerprint]);
}

async function tarballRegisteredDbs(): Promise<Buffer> {
	const manifest = readManifestIfPresent();
	const entries = manifest?.dbs ?? [];
	const tarPack = pack();
	const chunks: Buffer[] = [];
	tarPack.on("data", (c: Buffer) => chunks.push(c));
	const done = new Promise<void>((resolve, reject) => {
		tarPack.on("end", () => resolve());
		tarPack.on("error", (err: Error) => reject(err));
	});

	for (const entry of entries) {
		const data = readFileSync(entry.path);
		// Use a stable archive path: full source path, with the leading slash
		// stripped so tar interprets it as relative.
		const archivePath = entry.path.replace(/^\/+/, "");
		await new Promise<void>((resolve, reject) => {
			tarPack.entry({ name: archivePath, size: data.length }, data, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
	tarPack.finalize();
	await done;
	return gzipSync(Buffer.concat(chunks));
}

export async function exportEncrypted(targetPath: string): Promise<void> {
	const dek = await getDek();
	const fp = dekFingerprint4(dek);
	const header = buildHeader(fp);
	const plaintext = await tarballRegisteredDbs();

	const nonce = randomBytes(SNO_STATION_CORE_NONCE_LEN);
	const cipher = createCipheriv("aes-256-gcm", dek, nonce);
	cipher.setAAD(header);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();

	const out = Buffer.concat([header, nonce, ciphertext, tag]);
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, out, { mode: 0o600 });
}

// `relative` reserved for future cross-host import path remapping.
void relative;
