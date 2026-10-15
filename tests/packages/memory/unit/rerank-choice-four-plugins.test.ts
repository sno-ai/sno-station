import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInput } from "../../../../packages/memory/src/contract";
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
	for (const skinId of ["openclaw", "codex", "claude-code", "hermes"]) {
		expect(parseInput("init", {
			scope: { principal: "test", project: "/workspace", session: "session-1" },
			registration: { skinId },
		}).registration).toEqual({ skinId });
	}
	return settingsToPluginConfig(readSettings()).retrieval;
}

describe("reranker choice shared by four plugins", () => {
	it("ranks locally without a Sno GPU key, and outside REM Enhanced", () => {
		expect(selectedRerank({ mode: "rem-enhanced" })).toMatchObject({ rerank: "lightweight", rerankEndpoint: undefined });
		expect(selectedRerank({ mode: "agent-native", snoGpu: { apiKey: "machine-key" } })).toMatchObject({ rerank: "lightweight", rerankEndpoint: undefined });
	});

	it("ranks on Sno's reranker in REM Enhanced with a Sno GPU key, at the Sno GPU address", () => {
		expect(selectedRerank({ mode: "rem-enhanced", snoGpu: { baseUrl: "https://rt3-llm.sno.ai", apiKey: "machine-key" } }))
			.toMatchObject({ rerank: "cross-encoder", rerankEndpoint: "https://rt3-llm.sno.ai/rerank", rerankApiKey: "machine-key" });
	});

	it("keeps local ranking when the user chose it", () => {
		expect(selectedRerank({ mode: "rem-enhanced", snoGpu: { apiKey: "machine-key" }, rerank: { mode: "lightweight" } }))
			.toMatchObject({ rerank: "lightweight", rerankEndpoint: undefined });
	});
});
