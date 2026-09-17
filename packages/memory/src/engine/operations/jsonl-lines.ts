import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger } from "@snoai/utils/logger";

const log = createLogger("sno-station-mem:jsonl");

/** Preserve complete records without materializing an unbounded log as one string. */
export async function* readJsonlLines(file: string): AsyncGenerator<string> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) if (line.trim()) yield line;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		log.error("jsonl.read.failed", { file, error }, {
			event_name: "memory.jsonl.read.failed", file: "packages/sno-station-mem/src/engine/operations/jsonl-lines.ts",
			function: "readJsonlLines", site_id: "memory.jsonl.read.failed",
		});
	} finally {
		lines.close();
		stream.destroy();
	}
}
