import { closeSync, openSync, writeSync } from "node:fs";

/**
 * Writes `head`, then `count` generated lines, in 1 MB batches, and returns the file size and the
 * byte offset where the last `tailLines` lines begin (a line boundary).
 */
export function writeLargeTranscript(
	path: string,
	head: string,
	count: number,
	lineAt: (index: number) => string,
	tailLines: number,
): { size: number; tailOffset: number } {
	const fd = openSync(path, "w");
	let size = 0;
	let tailOffset = 0;
	const write = (text: string): void => { size += writeSync(fd, text); };
	try {
		write(head);
		let batch = "";
		for (let index = 0; index < count; index++) {
			if (index === count - tailLines) { write(batch); batch = ""; tailOffset = size; }
			batch += lineAt(index);
			if (batch.length > 1_000_000) { write(batch); batch = ""; }
		}
		write(batch);
	} finally {
		closeSync(fd);
	}
	return { size, tailOffset };
}
