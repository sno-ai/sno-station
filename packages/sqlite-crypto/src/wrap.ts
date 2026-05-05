import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import argon2 from "argon2";
import { WrongKeyError } from "./errors.js";
import { ARGON2ID_PARAMS, type KdfParams } from "./types.js";

/**
 * AES-256-GCM DEK wrap with AAD-bound parameters per design D5.
 *
 * AAD = `version_byte ‖ SHA-256(canonical_kdf_params_json)[:16 bytes]`. The
 * AAD is recomputed from the persisted `version` and `kdf_params` at unwrap
 * time, so a tampered version byte or kdf_params field fails GCM auth.
 */

export interface WrappedDek {
	readonly version: 1;
	readonly salt: string;
	readonly kdfParams: KdfParams;
	readonly nonce: string;
	readonly ciphertext: string;
	readonly tag: string;
}

const WRAP_VERSION = 1 as const;

function canonicalKdfJson(params: KdfParams): string {
	// Stable key order ensures the SHA-256 prefix is reproducible across writes.
	return JSON.stringify({
		algorithm: params.algorithm,
		hashLength: params.hashLength,
		memoryCost: params.memoryCost,
		parallelism: params.parallelism,
		saltLength: params.saltLength,
		timeCost: params.timeCost,
	});
}

function computeAad(version: number, params: KdfParams): Buffer {
	const versionByte = Buffer.alloc(1);
	versionByte[0] = version & 0xff;
	const paramsHash = createHash("sha256")
		.update(canonicalKdfJson(params), "utf8")
		.digest();
	return Buffer.concat([versionByte, paramsHash.subarray(0, 16)]);
}

async function deriveKek(
	passphrase: Buffer,
	salt: Buffer,
	params: KdfParams,
): Promise<Buffer> {
	const kek = await argon2.hash(passphrase, {
		type: argon2.argon2id,
		raw: true,
		salt,
		hashLength: params.hashLength,
		memoryCost: params.memoryCost,
		timeCost: params.timeCost,
		parallelism: params.parallelism,
	});
	return Buffer.from(kek);
}

export async function wrapDek(
	dek: Buffer,
	passphrase: Buffer,
): Promise<WrappedDek> {
	const params = ARGON2ID_PARAMS;
	const salt = randomBytes(params.saltLength);
	const kek = await deriveKek(passphrase, salt, params);
	try {
		const nonce = randomBytes(12);
		const aad = computeAad(WRAP_VERSION, params);
		const cipher = createCipheriv("aes-256-gcm", kek, nonce);
		cipher.setAAD(aad);
		const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
		const tag = cipher.getAuthTag();
		return {
			version: WRAP_VERSION,
			salt: salt.toString("hex"),
			kdfParams: params,
			nonce: nonce.toString("hex"),
			ciphertext: ct.toString("hex"),
			tag: tag.toString("hex"),
		};
	} finally {
		kek.fill(0);
	}
}

export async function unwrapDek(
	wrapped: WrappedDek,
	passphrase: Buffer,
): Promise<Buffer> {
	if (wrapped.version !== WRAP_VERSION) {
		throw new WrongKeyError("unsupported wrapped-dek version");
	}
	const salt = Buffer.from(wrapped.salt, "hex");
	const kek = await deriveKek(passphrase, salt, wrapped.kdfParams);
	try {
		const nonce = Buffer.from(wrapped.nonce, "hex");
		const ct = Buffer.from(wrapped.ciphertext, "hex");
		const tag = Buffer.from(wrapped.tag, "hex");
		const aad = computeAad(wrapped.version, wrapped.kdfParams);
		const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		try {
			const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
			if (dek.length !== 32) {
				throw new WrongKeyError("unwrapped DEK has unexpected length");
			}
			return dek;
		} catch (err) {
			throw new WrongKeyError("wrong passphrase or tampered wrapped state", {
				cause: err,
			});
		}
	} finally {
		kek.fill(0);
	}
}

export function dekFingerprint(dek: Buffer): string {
	return createHash("sha256").update(dek).digest("hex").slice(0, 8);
}

export function dekFingerprint4(dek: Buffer): Buffer {
	return createHash("sha256").update(dek).digest().subarray(0, 4);
}
