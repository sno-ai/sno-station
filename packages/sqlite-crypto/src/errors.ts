import { inspect } from "node:util";

const SAFE_TOSTRING = Symbol.for("sno-station-core.errors.safeToString");

// Strip any hex sequence ≥32 chars (256 bits) from any candidate string. Belt-and-braces
// against a future maintainer accidentally interpolating a key/passphrase into a message.
const HEX_LEAK = /[0-9a-fA-F]{32,}/g;
function scrub(s: string): string {
	return s.replace(HEX_LEAK, "[redacted]");
}

export class SnoStationCoreCryptoError extends Error {
	public readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(scrub(message), options);
		this.name = "SnoStationCoreCryptoError";
		this.code = code;
	}

	override toString(): string {
		return scrub(`${this.name} [${this.code}]: ${this.message}`);
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return scrub(`${this.name} [${this.code}]: ${this.message}`);
	}

	toJSON(): { name: string; code: string; message: string } {
		return { name: this.name, code: this.code, message: scrub(this.message) };
	}

	[SAFE_TOSTRING](): string {
		return this.toString();
	}
}

export class KeychainUnavailableError extends SnoStationCoreCryptoError {
	constructor(message = "OS keychain unavailable", options?: ErrorOptions) {
		super("KEYCHAIN_UNAVAILABLE", message, options);
		this.name = "KeychainUnavailableError";
	}
}

export class WrongKeyError extends SnoStationCoreCryptoError {
	constructor(
		message = "DEK does not match this database",
		options?: ErrorOptions,
	) {
		super("WRONG_KEY", message, options);
		this.name = "WrongKeyError";
	}
}

export class IntegrityCheckFailed extends SnoStationCoreCryptoError {
	constructor(
		message = "cryptographic integrity check failed",
		options?: ErrorOptions,
	) {
		super("INTEGRITY_CHECK_FAILED", message, options);
		this.name = "IntegrityCheckFailed";
	}
}

export class CanaryMismatch extends SnoStationCoreCryptoError {
	constructor(
		message = "canary row sentinel mismatch",
		options?: ErrorOptions,
	) {
		super("CANARY_MISMATCH", message, options);
		this.name = "CanaryMismatch";
	}
}

export class DbIdMismatch extends SnoStationCoreCryptoError {
	constructor(
		message = "canary db_id does not match manifest entry",
		options?: ErrorOptions,
	) {
		super("DB_ID_MISMATCH", message, options);
		this.name = "DbIdMismatch";
	}
}

export class ManifestMissing extends SnoStationCoreCryptoError {
	constructor(
		message = "manifest file is missing despite registration marker present; run `sno-station-core lock --rebuild-manifest`",
		options?: ErrorOptions,
	) {
		super("MANIFEST_MISSING", message, options);
		this.name = "ManifestMissing";
	}
}

export class ManifestCorrupted extends SnoStationCoreCryptoError {
	constructor(
		message = "manifest file is unparseable",
		options?: ErrorOptions,
	) {
		super("MANIFEST_CORRUPTED", message, options);
		this.name = "ManifestCorrupted";
	}
}

export class MissingDekError extends SnoStationCoreCryptoError {
	constructor(
		message = "DEK source is missing; refusing implicit key creation. Provision the durable operator key explicitly with `sno-station-core lock --provision-key`",
		options?: ErrorOptions,
	) {
		super("MISSING_DEK", message, options);
		this.name = "MissingDekError";
	}
}

export class ForeignDekError extends SnoStationCoreCryptoError {
	constructor(
		message = "export was made under a different DEK; cross-machine import requires `sno-station-core lock --import-dek` (v1.1)",
		options?: ErrorOptions,
	) {
		super("FOREIGN_DEK", message, options);
		this.name = "ForeignDekError";
	}
}

export class InvalidExportFormat extends SnoStationCoreCryptoError {
	constructor(
		message = "input is not a valid .sno-station-core export",
		options?: ErrorOptions,
	) {
		super("INVALID_EXPORT_FORMAT", message, options);
		this.name = "InvalidExportFormat";
	}
}

export class UnsupportedExportVersion extends SnoStationCoreCryptoError {
	constructor(
		message = "unsupported .sno-station-core export version",
		options?: ErrorOptions,
	) {
		super("UNSUPPORTED_EXPORT_VERSION", message, options);
		this.name = "UnsupportedExportVersion";
	}
}

// Verifier helper exposed for the typed-error redaction unit test.
export function safelyStringify(err: unknown): string {
	if (err instanceof SnoStationCoreCryptoError) return err.toString();
	if (err instanceof Error) return scrub(`${err.name}: ${err.message}`);
	return scrub(inspect(err));
}
