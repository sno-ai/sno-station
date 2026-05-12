import { inspect } from "node:util";

const SAFE_TOSTRING = Symbol.for("nodix.errors.safeToString");

// Strip any hex sequence ≥32 chars (256 bits) from any candidate string. Belt-and-braces
// against a future maintainer accidentally interpolating a key/passphrase into a message.
const HEX_LEAK = /[0-9a-fA-F]{32,}/g;
function scrub(s: string): string {
	return s.replace(HEX_LEAK, "[redacted]");
}

export class NodixCryptoError extends Error {
	public readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(scrub(message), options);
		this.name = "NodixCryptoError";
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

export class KeychainUnavailableError extends NodixCryptoError {
	constructor(message = "OS keychain unavailable", options?: ErrorOptions) {
		super("KEYCHAIN_UNAVAILABLE", message, options);
		this.name = "KeychainUnavailableError";
	}
}

export class WrongKeyError extends NodixCryptoError {
	constructor(
		message = "DEK does not match this database",
		options?: ErrorOptions,
	) {
		super("WRONG_KEY", message, options);
		this.name = "WrongKeyError";
	}
}

export class IntegrityCheckFailed extends NodixCryptoError {
	constructor(
		message = "cryptographic integrity check failed",
		options?: ErrorOptions,
	) {
		super("INTEGRITY_CHECK_FAILED", message, options);
		this.name = "IntegrityCheckFailed";
	}
}

export class CanaryMismatch extends NodixCryptoError {
	constructor(
		message = "canary row sentinel mismatch",
		options?: ErrorOptions,
	) {
		super("CANARY_MISMATCH", message, options);
		this.name = "CanaryMismatch";
	}
}

export class DbIdMismatch extends NodixCryptoError {
	constructor(
		message = "canary db_id does not match manifest entry",
		options?: ErrorOptions,
	) {
		super("DB_ID_MISMATCH", message, options);
		this.name = "DbIdMismatch";
	}
}

export class ManifestMissing extends NodixCryptoError {
	constructor(
		message = "manifest file is missing despite registration marker present; run `nodix lock --rebuild-manifest`",
		options?: ErrorOptions,
	) {
		super("MANIFEST_MISSING", message, options);
		this.name = "ManifestMissing";
	}
}

export class ManifestCorrupted extends NodixCryptoError {
	constructor(
		message = "manifest file is unparseable",
		options?: ErrorOptions,
	) {
		super("MANIFEST_CORRUPTED", message, options);
		this.name = "ManifestCorrupted";
	}
}

export class MissingDekError extends NodixCryptoError {
	constructor(
		message = "DEK source is missing while encrypted databases are registered; refusing to auto-generate",
		options?: ErrorOptions,
	) {
		super("MISSING_DEK", message, options);
		this.name = "MissingDekError";
	}
}

export class ForeignDekError extends NodixCryptoError {
	constructor(
		message = "export was made under a different DEK; cross-machine import requires `nodix lock --import-dek` (v1.1)",
		options?: ErrorOptions,
	) {
		super("FOREIGN_DEK", message, options);
		this.name = "ForeignDekError";
	}
}

export class InvalidExportFormat extends NodixCryptoError {
	constructor(
		message = "input is not a valid .nodix export",
		options?: ErrorOptions,
	) {
		super("INVALID_EXPORT_FORMAT", message, options);
		this.name = "InvalidExportFormat";
	}
}

export class UnsupportedExportVersion extends NodixCryptoError {
	constructor(
		message = "unsupported .nodix export version",
		options?: ErrorOptions,
	) {
		super("UNSUPPORTED_EXPORT_VERSION", message, options);
		this.name = "UnsupportedExportVersion";
	}
}

// Verifier helper exposed for the typed-error redaction unit test.
export function safelyStringify(err: unknown): string {
	if (err instanceof NodixCryptoError) return err.toString();
	if (err instanceof Error) return scrub(`${err.name}: ${err.message}`);
	return scrub(inspect(err));
}
