// Branded primitive types for sqlite-crypto. Branding prevents accidental cross-mixing
// (e.g. passing a raw string where a fingerprint is expected) without runtime cost.

declare const __dekBrand: unique symbol;
declare const __dbIdBrand: unique symbol;
declare const __fpBrand: unique symbol;

export type Dek = Buffer & { readonly [__dekBrand]: "Dek" };
export type DbId = string & { readonly [__dbIdBrand]: "DbId" };
export type DekFingerprint = string & {
	readonly [__fpBrand]: "DekFingerprint";
};

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
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const EXPORT_MAGIC = "SNO_STATION_CORE01" as const;
export const EXPORT_VERSION = 0x01 as const;
