/** @file import.ts
 * @purpose `.nodix` import — structural gate (magic, version) BEFORE GCM
 *   attempt; cross-machine fingerprint check (`SHA-256(local_DEK)[:4]`)
 *   BEFORE GCM attempt; layered errors per spec.
 */

export async function importEncrypted(_sourcePath: string): Promise<void> {
	throw new Error("not implemented (M3 — task 9.7)");
}
