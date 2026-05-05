/** @file export.ts
 * @purpose `.nodix` AES-256-GCM export bundle producer. Spec:
 *   `openspec/changes/add-local-aes-encryption/specs/nodix-export-format/spec.md`.
 *   Layout: `magic(7) ‖ version(1) ‖ source_dek_fingerprint(4) ‖ nonce(12) ‖
 *   ciphertext(N) ‖ tag(16)` where AAD = first 12 bytes verbatim.
 */

export const NODIX_MAGIC = Buffer.from("NODIX01", "ascii");
export const NODIX_VERSION_V1 = 0x01;
export const NODIX_HEADER_LEN = 12;
export const NODIX_NONCE_LEN = 12;
export const NODIX_TAG_LEN = 16;

export async function exportEncrypted(_targetPath: string): Promise<void> {
	throw new Error("not implemented (M3 — task 9.6)");
}
