// @snoai/nodix-crypto — single audit surface for Nodix-family SQLite encryption.
// See openspec/changes/add-local-aes-encryption/specs/nodix-crypto-core/spec.md.

export { resolveConfigPaths, resolveKeychainService } from "./config.js";
export {
	_readCanaryForRecovery,
	openEncryptedDb,
	openEncryptedDbReadonly,
} from "./db.js";
export { _resetDekCache, getDek, getDekSync } from "./dek.js";
export * from "./errors.js";
export {
	exportEncrypted,
	NODIX_HEADER_LEN,
	NODIX_MAGIC,
	NODIX_NONCE_LEN,
	NODIX_TAG_LEN,
	NODIX_VERSION_V1,
} from "./export.js";
export { importEncrypted } from "./import.js";
export {
	isManifestPresent,
	isMarkerPresent,
	readManifestIfPresent,
} from "./manifest.js";
export { removePassphrase, setPassphrase } from "./passphrase.js";
export * from "./types.js";
export { dekFingerprint } from "./wrap.js";
