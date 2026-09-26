import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { createCodingSkinRegistration } from "../../../../packages/memory/config/coding-skin";

// OpenClaw parses its own plugin config; Codex, Claude Code and Hermes are registered from the
// installed settings. The reranker a user gets must not depend on which of the four they use.
const TEI_ENDPOINT = "http://127.0.0.1:19213/rerank";

type Retrieval = Record<string, unknown>;

function outcome(run: () => { rerank: string; rerankProvider?: string | undefined }): string {
	try {
		const retrieval = run();
		return `ok:${retrieval.rerank}:${retrieval.rerankProvider ?? "-"}`;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		if (text.includes("rerankApiKey")) return "refused:rerankApiKey";
		if (text.includes("rerankProvider")) return "refused:rerankProvider";
		return `refused:${text}`;
	}
}

function openClaw(retrieval: Retrieval, key: string | undefined): string {
	return outcome(() => pluginConfigSchema.parse({
		mode: "agent-native",
		retrieval: { ...retrieval, ...(key ? { rerankApiKey: key } : {}) },
	}).retrieval);
}

function registeredSkin(skinId: string, retrieval: Retrieval, key: string | undefined): string {
	if (key) vi.stubEnv("SNO_STATION_MEM_RERANK_API_KEY", key);
	return outcome(() => createCodingSkinRegistration({
		skinId,
		installed: {
			storePath: "/tmp/rerank-choice-memory.sqlite",
			embedding: { provider: "local-onnx" },
			extractionKeyRef: "SNO_MEM_CLAW_LLM_INTERNAL_KEY",
			mode: "agent-native",
			retrieval,
			...(key ? { rerankKeyRef: "SNO_STATION_MEM_RERANK_API_KEY" as const } : {}),
		},
	}).settings.retrieval);
}

function allFour(retrieval: Retrieval, key?: string): Record<string, string> {
	return {
		openclaw: openClaw(retrieval, key),
		codex: registeredSkin("codex", retrieval, key),
		"claude-code": registeredSkin("claude-code", retrieval, key),
		hermes: registeredSkin("hermes", retrieval, key),
	};
}

function same(expected: string): Record<string, string> {
	return { openclaw: expected, codex: expected, "claude-code": expected, hermes: expected };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("reranker choice is identical in all four plugins", () => {
	it("ranks locally when nothing is configured", () => {
		expect(allFour({})).toEqual(same("ok:lightweight:-"));
	});

	it("ranks locally when only a key is present", () => {
		expect(allFour({}, "rerank-key-present")).toEqual(same("ok:lightweight:-"));
	});

	it("refuses a remote ranker that names no provider", () => {
		expect(allFour({ rerank: "cross-encoder" }, "rerank-key-present"))
			.toEqual(same("refused:rerankProvider"));
	});

	it("refuses a remote ranker with no key", () => {
		expect(allFour({ rerank: "cross-encoder", rerankProvider: "tei", rerankEndpoint: TEI_ENDPOINT }))
			.toEqual(same("refused:rerankApiKey"));
	});

	it("uses the named remote ranker when provider, endpoint and key are given", () => {
		expect(allFour(
			{ rerank: "cross-encoder", rerankProvider: "tei", rerankEndpoint: TEI_ENDPOINT },
			"rerank-key-present",
		)).toEqual(same("ok:cross-encoder:tei"));
	});
});
