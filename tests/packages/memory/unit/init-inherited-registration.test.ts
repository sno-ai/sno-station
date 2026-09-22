import { describe, expect, it } from "vitest";
import { createCodingSkinRegistration } from "../../../../packages/memory/config/coding-skin";
import { parseInput } from "../../../../packages/memory/src/contract";

const scope = { principal: "test", project: "/workspace", session: "session-1" };

describe("inherited init registration", () => {
	it("accepts the closed inherited-settings shape", () => {
		expect(parseInput("init", {
			scope,
			registration: { skinId: "hermes", inheritInstalled: true },
		})).toEqual({
			scope,
			registration: { skinId: "hermes", inheritInstalled: true },
		});
	});

	it.each(["settings", "routing"])("rejects inherited registration carrying %s", field => {
		expect(() => parseInput("init", {
			scope,
			registration: { skinId: "hermes", inheritInstalled: true, [field]: {} },
		})).toThrow("invalid-input");
	});

	it("derives registration from installed settings without a host model", () => {
		const registration = createCodingSkinRegistration({
			skinId: "hermes",
			installed: {
				storePath: "/tmp/memory.sqlite",
				embedding: { provider: "local-onnx" },
				extractionKeyRef: "SNO_STATION_MEM_LLM_INTERNAL_KEY",
				mode: "local-first",
				retrieval: { rerank: "none", vectorWeight: 0.61 },
				rerankKeyRef: "SNO_STATION_MEM_RERANK_API_KEY",
			},
		});

		expect(registration.routing.mode).toBe("local-first");
		expect(registration.settings.retrieval).toMatchObject({
			rerank: "none",
			vectorWeight: 0.61,
			rerankApiKey: "${SNO_STATION_MEM_RERANK_API_KEY}",
		});
		expect(registration.model).toBeUndefined();
	});

	it("fills the local ranker for a keyless install that named no reranker", () => {
		const registration = createCodingSkinRegistration({
			skinId: "codex",
			installed: {
				storePath: "/tmp/memory.sqlite",
				embedding: { provider: "local-onnx" },
				extractionKeyRef: "SNO_STATION_MEM_LLM_INTERNAL_KEY",
				mode: "local-first",
				retrieval: {},
			},
		});

		expect(registration.settings.retrieval.rerank).toBe("lightweight");
	});

	const installed = {
		storePath: "/tmp/memory.sqlite",
		embedding: { provider: "local-onnx" as const },
		extractionKeyRef: "SNO_STATION_MEM_LLM_INTERNAL_KEY",
		mode: "local-first" as const,
		retrieval: { rerank: "none" as const },
	};

	it.each(["hermes", "claude-code", "codex"])("reports observe events as the %s agent", skinId => {
		const registration = createCodingSkinRegistration({ skinId, installed });
		expect(registration.settings.observe.agentId).toBe(skinId);
		expect(registration.settings.observe.enabled).toBe(process.env.SNO_OBSERVE_ENABLED !== "false");
	});

	it("refuses a skin id the observe SDK does not know instead of counting it as openclaw", () => {
		expect(() => createCodingSkinRegistration({ skinId: "default", installed })).toThrow(/observe.agentId/);
	});
});
