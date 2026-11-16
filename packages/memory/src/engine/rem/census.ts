import { createHash } from "node:crypto";

export function deriveRemWriteIdentity(input: {
 rowId: string;
 text: string;
 contentHash: string;
 timestamp: number;
}): string {
 return createHash("sha256").update(JSON.stringify([input.rowId, input.text, input.contentHash, input.timestamp])).digest("hex");
}
