import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { type Settings, settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { DEFAULT_SETTINGS_PATH } from "../fixtures/settings-file-fixture";

function threadsFor(threads: number): number | undefined {
	const shipped = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as Settings;
	return settingsToPluginConfig({ ...shipped, embedding: { ...shipped.embedding, threads } }).embedding.sessionOptions?.intraOpNumThreads;
}

describe("embedding threads", () => {
	it("leaves most cores free when the setting is 0 (automatic)", () => {
		// With no thread count ONNX uses every core: a background REM pass held all 32 cores of a workstation.
		const automatic = threadsFor(0);
		expect(automatic).toBeGreaterThanOrEqual(1);
		expect(automatic).toBeLessThanOrEqual(4);
		expect(automatic).toBeLessThanOrEqual(Math.max(1, Math.floor(availableParallelism() / 2)));
	});

	it("uses an explicit thread count as given", () => {
		expect(threadsFor(6)).toBe(6);
	});
});
