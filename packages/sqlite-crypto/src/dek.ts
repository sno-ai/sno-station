import { WrongKeyError } from "./errors.js";
import type { Dek } from "./types.js";

export function getDek(hex: string): Dek {
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		throw new WrongKeyError("store.encryptionKey must be 64 hexadecimal characters");
	}
	return Buffer.from(hex, "hex") as Dek;
}
