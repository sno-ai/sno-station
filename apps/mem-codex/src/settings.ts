import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { profileRoot } from "./paths.js";

const recallSchema = z.object({
	auto: z.boolean(),
	sessionStart: z.object({ limit: z.number(), maxChars: z.number(), timeoutMs: z.number() }),
	prompt: z.object({ limit: z.number(), maxChars: z.number(), timeoutMs: z.number(), minChars: z.number(), minScore: z.number() }),
	explicitLimit: z.number(),
});

function readSettings() {
	const path = join(profileRoot(), "settings.json");
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(path, "utf8")); }
	catch { throw new Error(`settings unavailable: ${path}: file; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`); }
	const parsed = z.object({ recall: recallSchema, capture: z.object({ ambient: z.boolean() }), memoryPackage: z.object({ path: z.string().min(1), node: z.string().min(1) }) }).safeParse(raw);
	if (!parsed.success) {
		const field = parsed.error.issues[0]?.path.join(".") || "recall";
		throw new Error(`settings unavailable: ${path}: ${field}; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
	}
	return parsed.data;
}

export function readRecallSettings(): z.infer<typeof recallSchema> {
	return readSettings().recall;
}

export function readCaptureSettings(): { ambient: boolean } {
	return readSettings().capture;
}
