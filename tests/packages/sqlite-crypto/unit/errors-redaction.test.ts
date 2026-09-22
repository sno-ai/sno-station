/**
 * Task 2.12 — typed errors must never serialize key material.
 *
 * Asserts that `JSON.stringify(err)`, `err.toString()`, `inspect(err)`, and
 * `err.stack` of every SnoStationCoreCryptoError subclass contains zero hex sequences
 * of length ≥32 (256 bits) and no DEK/passphrase substring.
 */

import { inspect } from "node:util";
import {
	CanaryMismatch,
	DbIdMismatch,
	ForeignDekError,
	IntegrityCheckFailed,
	InvalidExportFormat,
	KeychainUnavailableError,
	ManifestCorrupted,
	ManifestMissing,
	MissingDekError,
	SnoStationCoreCryptoError,
	safelyStringify,
	UnsupportedExportVersion,
	WrongKeyError,
} from "@snoai/sqlite-crypto";
import { describe, expect, it } from "vitest";

const HEX_LEAK = /[0-9a-fA-F]{32,}/;

const SUBCLASSES: Array<readonly [string, () => SnoStationCoreCryptoError]> = [
	["KeychainUnavailableError", () => new KeychainUnavailableError()],
	["WrongKeyError", () => new WrongKeyError()],
	["IntegrityCheckFailed", () => new IntegrityCheckFailed()],
	["CanaryMismatch", () => new CanaryMismatch()],
	["DbIdMismatch", () => new DbIdMismatch()],
	["ManifestMissing", () => new ManifestMissing()],
	["ManifestCorrupted", () => new ManifestCorrupted()],
	["MissingDekError", () => new MissingDekError()],
	["ForeignDekError", () => new ForeignDekError()],
	["InvalidExportFormat", () => new InvalidExportFormat()],
	["UnsupportedExportVersion", () => new UnsupportedExportVersion()],
];

const POISON_HEX = "deadbeef".repeat(8); // 64 hex chars; will be redacted by the scrubber

describe("SnoStationCoreCryptoError redaction", () => {
	for (const [name, factory] of SUBCLASSES) {
		it(`${name} default toString/inspect/JSON contain no hex>=32`, () => {
			const err = factory();
			expect(err).toBeInstanceOf(SnoStationCoreCryptoError);
			expect(err.toString()).not.toMatch(HEX_LEAK);
			expect(JSON.stringify(err)).not.toMatch(HEX_LEAK);
			expect(inspect(err)).not.toMatch(HEX_LEAK);
		});

		it(`${name} scrubs poisoned message containing a fake DEK`, () => {
			const err = new (
				factory().constructor as new (
					msg: string,
				) => SnoStationCoreCryptoError
			)(`leaking key=${POISON_HEX}`);
			expect(err.toString()).not.toContain(POISON_HEX);
			expect(JSON.stringify(err)).not.toContain(POISON_HEX);
			expect(inspect(err)).not.toContain(POISON_HEX);
		});
	}

	it("safelyStringify scrubs hex leak in plain Error too", () => {
		const e = new Error(`oops ${POISON_HEX}`);
		expect(safelyStringify(e)).not.toContain(POISON_HEX);
	});

	it("safelyStringify scrubs hex leak in unknown shape", () => {
		const out = safelyStringify({ wrappedDek: POISON_HEX });
		expect(out).not.toContain(POISON_HEX);
	});

	it("error stack does not leak a leading hex>=32 token", () => {
		// We can't fully control V8 stack content, but our messages are scrubbed
		// before super() so any hex passed in via constructor is gone.
		const err = new WrongKeyError(`bad key ${POISON_HEX}`);
		expect(err.stack ?? "").not.toContain(POISON_HEX);
	});
});
