import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

it.runIf(process.platform === "linux")("an embedder with no thread count leaves most cores free", async () => {
	// With no thread count ONNX starts one compute thread per core: a background REM pass held all 32 cores of a
	// workstation. Its compute threads carry the name MainThread.
	const database = createTestDb();
	const embedder = createEmbedder({ provider: "local-onnx" }, dirname(database.dbPath));
	try {
		await embedder.embed("the editor the user prefers");
		const computeThreads = readdirSync("/proc/self/task")
			.filter(task => readFileSync(`/proc/self/task/${task}/comm`, "utf8").trim() === "MainThread").length;
		expect(computeThreads).toBeGreaterThanOrEqual(1);
		expect(computeThreads).toBeLessThanOrEqual(4);
	} finally {
		await embedder.dispose();
		database.cleanup();
	}
}, 120_000);
