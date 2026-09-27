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
	writeSettingsFixture(root, { rerank: overrides });
	for (const skinId of ["openclaw", "codex", "claude-code", "hermes"]) {
		expect(parseInput("init", {
			scope: { principal: "test", project: "/workspace", session: "session-1" },
			registration: { skinId },
		}).registration).toEqual({ skinId });
	}
	return settingsToPluginConfig(readSettings()).retrieval;
}

describe("reranker choice shared by four plugins", () => {
	it("ranks locally by default and with only a key", () => {
		expect(selectedRerank({}).rerank).toBe("lightweight");
		expect(selectedRerank({ apiKey: "rerank-key-present" }).rerank).toBe("lightweight");
	});

	it("refuses a remote ranker without a provider", () => {
		expect(() => selectedRerank({ mode: "cross-encoder", provider: "", apiKey: "rerank-key-present" }))
			.toThrow();
	});

	it("refuses a remote ranker without a key", () => {
		expect(() => selectedRerank({ mode: "cross-encoder", provider: "tei", endpoint: "http://127.0.0.1:19213/rerank" }))
			.toThrow();
	});

	it("uses the named remote ranker and key", () => {
		expect(selectedRerank({ mode: "cross-encoder", provider: "tei", endpoint: "http://127.0.0.1:19213/rerank", apiKey: "rerank-key-present" }))
			.toMatchObject({ rerank: "cross-encoder", rerankProvider: "tei", rerankEndpoint: "http://127.0.0.1:19213/rerank", rerankApiKey: "rerank-key-present" });
	});
});
