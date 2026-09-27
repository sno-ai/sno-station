import { createHash } from "node:crypto";

export function dekFingerprint(dek: Buffer): string {
	return createHash("sha256").update(dek).digest("hex").slice(0, 8);
}

export function dekFingerprint4(dek: Buffer): Buffer {
	return createHash("sha256").update(dek).digest().subarray(0, 4);
}
