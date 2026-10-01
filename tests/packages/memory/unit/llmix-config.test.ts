import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../../../../packages/memory/src/contract/profile";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gpuSettings(snoGpu: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "gpu-settings-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	writeSettingsFixture(root, { snoGpu });
	return readSettings().snoGpu;
}

describe("Sno GPU settings", () => {
	it("reads the user-selected address and key from the settings file", () => {
		expect(gpuSettings({ baseUrl: "https://llm.example.test", apiKey: "test-key" }))
			.toEqual({ baseUrl: "https://llm.example.test", apiKey: "test-key" });
	});

	it("rejects old per-provider routing fields", () => {
		for (const field of ["provider", "model", "gpuPath", "heliconeApiKey"]) {
			expect(() => gpuSettings({ [field]: "removed" })).toThrow(/docs\/memory-setup\.md/);
		}
	});
});
