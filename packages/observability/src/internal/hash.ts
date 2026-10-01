import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

export function uint64HashModulo(input: string, modulo: number): number {
	const digest = createHash("sha256").update(input, "utf8").digest();
	const value = digest.readBigUInt64BE(0);
	return Number(value % BigInt(modulo));
}
