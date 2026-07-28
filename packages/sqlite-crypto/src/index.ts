// @snoai/sno-station-core-crypto — single audit surface for SNO Station Core SQLite encryption.
// See openspec/changes/add-local-aes-encryption/specs/sno-station-core-crypto-core/spec.md.

export {
	assertDurableKeyFilePath,
	KEY_FILE_ENV,
	resolveConfigPaths,
	resolveKeychainService,
} from "./config.js";
export {
	_readCanaryForRecovery,
	openEncryptedDb,
	openEncryptedDbReadonly,
	runIntegrityCheck,
} from "./db.js";
export { _resetDekCache, getDek, getDekSync } from "./dek.js";
export * from "./errors.js";
export {
	exportEncrypted,
	SNO_STATION_CORE_HEADER_LEN,
	SNO_STATION_CORE_MAGIC,
	SNO_STATION_CORE_NONCE_LEN,
	SNO_STATION_CORE_TAG_LEN,
	SNO_STATION_CORE_VERSION_V1,
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
