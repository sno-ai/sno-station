// @snoai/nodix-crypto — single audit surface for Nodix-family SQLite encryption.
// See openspec/changes/add-local-aes-encryption/specs/nodix-crypto-core/spec.md.

export { resolveConfigPaths, resolveKeychainService } from "./config.js";
export { openEncryptedDb, openEncryptedDbReadonly } from "./db.js";
export { _resetDekCache, getDek } from "./dek.js";
export * from "./errors.js";
export {
	isManifestPresent,
	isMarkerPresent,
	readManifestIfPresent,
} from "./manifest.js";
export { removePassphrase, setPassphrase } from "./passphrase.js";
export * from "./types.js";
export { dekFingerprint } from "./wrap.js";

// Stubbed export/import — implemented in M3.
export async function exportEncrypted(_targetPath: string): Promise<void> {
	throw new Error("not implemented (M3 — task 9.6)");
}

export async function importEncrypted(_sourcePath: string): Promise<void> {
	throw new Error("not implemented (M3 — task 9.7)");
}
