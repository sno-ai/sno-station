// Branded primitive types for sno-station-core-crypto. Branding prevents accidental cross-mixing
// (e.g. passing a raw string where a fingerprint is expected) without runtime cost.

declare const __dekBrand: unique symbol;
declare const __dbIdBrand: unique symbol;
declare const __fpBrand: unique symbol;

export type Dek = Buffer & { readonly [__dekBrand]: "Dek" };
export type DbId = string & { readonly [__dbIdBrand]: "DbId" };
export type DekFingerprint = string & {
	readonly [__fpBrand]: "DekFingerprint";
};

export interface KdfParams {
	readonly algorithm: "argon2id";
	readonly memoryCost: number;
	readonly timeCost: number;
	readonly parallelism: number;
	readonly hashLength: number;
	readonly saltLength: number;
}

export interface KeyStateFilePlain {
	readonly version: 1;
	readonly mode: "plain";
	readonly dek: string;
	readonly wrappedDek: null;
	readonly wrapNonce: null;
	readonly wrapTag: null;
	readonly kdfParams: null;
	readonly salt: null;
	readonly createdAt: string;
	readonly host: string;
}

export interface KeyStateFileWrapped {
	readonly version: 1;
	readonly mode: "wrapped";
	readonly dek: null;
	readonly wrappedDek: string;
	readonly wrapNonce: string;
	readonly wrapTag: string;
	readonly kdfParams: KdfParams;
	readonly salt: string;
	readonly createdAt: string;
	readonly host: string;
}

export type KeyStateFile = KeyStateFilePlain | KeyStateFileWrapped;

export interface ManifestEntry {
	readonly path: string;
	readonly dbId: DbId;
	readonly dekFingerprint: DekFingerprint;
}

export interface ManifestFile {
	readonly schemaVersion: 1;
	readonly createdAt: string;
	readonly dbs: readonly ManifestEntry[];
}

export interface SnoStationCoreConfigPaths {
	readonly configDir: string;
	readonly keyFile: string;
	readonly manifestFile: string;
	readonly markerFile: string;
}

export interface OpenEncryptedDbResult {
	readonly db: import("better-sqlite3").Database;
	readonly dbId: DbId;
	readonly registered: boolean;
}

export const CANARY_TABLE = "_sno_station_core_canary" as const;
export const CANARY_SENTINEL = "sno-station-core-v1-canary-ok" as const;
export const KEYCHAIN_ACCOUNT = "default-user" as const;
export const KEYCHAIN_SERVICE_DEFAULT = "ai.sno.sno-station-core" as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const KEY_STATE_VERSION = 1 as const;
export const EXPORT_MAGIC = "SNO_STATION_CORE01" as const;
export const EXPORT_VERSION = 0x01 as const;

export const ARGON2ID_PARAMS: KdfParams = {
	algorithm: "argon2id",
	memoryCost: 65536,
	timeCost: 3,
	parallelism: 4,
	hashLength: 32,
	saltLength: 16,
};
