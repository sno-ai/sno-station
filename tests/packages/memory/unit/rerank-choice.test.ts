import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../../../../packages/memory/src/contract/profile";
import { settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function selectedRerank(overrides: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "rerank-choice-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	writeSettingsFixture(root, overrides);
	return settingsToPluginConfig(readSettings()).retrieval;
}

describe("shared reranker configuration", () => {
	it.each(["local-first", "agent-native", "rem-enhanced"])("uses local ranking in %s even with an explicit historical GPU choice and key", (mode) => {
		const retrieval = selectedRerank({ mode, snoGpu: { apiKey: "machine-key" }, rerank: { mode: "cross-encoder", maxCandidates: 64, timeoutMs: 15000 } });
		expect(retrieval.rerank).toBe("lightweight");
		expect(retrieval.rerankTimeoutMs).toBe(2000);
		for (const field of ["rerankEndpoint", "rerankApiKey", "rerankMaxCandidates", "rerankBlendCross", "rerankBlendVector"]) expect(retrieval).not.toHaveProperty(field);
	});

	it("preserves an explicit choice to disable reranking", () => {
		expect(selectedRerank({ mode: "rem-enhanced", snoGpu: { apiKey: "machine-key" }, rerank: { mode: "none" } }).rerank).toBe("none");
	});
});
