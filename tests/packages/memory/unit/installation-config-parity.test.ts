import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bindStore, getInstallationConfigPath } from "../../../../packages/memory/src/engine/shared/paths";
import { readSnoStationMemConfig, PLUGIN_ENTRY_KEY } from "../../../../packages/memory/src/engine/bindings/embedder-config-files";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import {
	codingSkinInstallationSchema,
	createCodingSkinRegistration,
} from "../../../../packages/memory/config/coding-skin";
import { DEFAULT_MODEL_MODE } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { resolveLlmRoute } from "../../../../packages/memory/src/model/llm-mode-routing";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });

it("preserves every setting the retained REM runtime reads without persisting either model key", async () => {
	const root = mkdtempSync(join(tmpdir(), "installation-parity-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	vi.stubEnv("SNO_MEM_CLAW_LLM_INTERNAL_KEY", "zebra-extraction-private-marker");
	vi.stubEnv("SNO_STATION_MEM_RERANK_API_KEY", "zebra-rerank-private-marker");
	const original = {
		mode: "rem-enhanced" as const,
		dbPath: join(root, "existing.sqlite"),
		embedding: { provider: "local-onnx", dimensions: 1024 },
		extraction: { llm: { apiKey: "zebra-extraction-private-marker" } },
		retrieval: { recallTopK: 7, rerank: "cross-encoder", rerankProvider: "tei", rerankEndpoint: "http://127.0.0.1:19213/rerank", rerankApiKey: "zebra-rerank-private-marker" },
		memoryTelemetry: { enabled: false, currentKeyVersion: 2 },
		autoRecallTimeoutMs: 7000,
	};
	const { rerankApiKey: _secret, ...retrieval } = original.retrieval;
	await bindStore(original.dbPath, { mode: original.mode, embedding: original.embedding,
		extractionKeyRef: "SNO_MEM_CLAW_LLM_INTERNAL_KEY", retrieval,
		rerankKeyRef: "SNO_STATION_MEM_RERANK_API_KEY", memoryTelemetry: original.memoryTelemetry,
		autoRecallTimeoutMs: original.autoRecallTimeoutMs });
	const bytes = readFileSync(getInstallationConfigPath(), "utf8");
	expect(bytes).not.toContain("zebra-extraction-private-marker");
	expect(bytes).not.toContain("zebra-rerank-private-marker");
	const before = pluginConfigSchema.parse(original);
	const after = pluginConfigSchema.parse(readSnoStationMemConfig(getInstallationConfigPath()).plugins?.entries?.[PLUGIN_ENTRY_KEY]?.config);
	for (const field of ["mode", "dbPath", "embedding", "retrieval", "memoryTelemetry", "autoRecallTimeoutMs"] as const) {
		expect(after[field], field).toEqual(before[field]);
	}
	expect(after.extraction.llm.apiKey === before.extraction.llm.apiKey).toBe(true);
});

it("uses one default mode and preserves every explicit model mode for coding skins", () => {
	const storePath = join(tmpdir(), "coding-skin-mode.sqlite");
	const defaultInstall = codingSkinInstallationSchema.parse({ storePath });
	expect(defaultInstall.mode).toBe(DEFAULT_MODEL_MODE);

	for (const mode of ["local-first", "agent-native", "rem-enhanced"] as const) {
		const installed = codingSkinInstallationSchema.parse({ storePath, mode });
		const registration = createCodingSkinRegistration({
			skinId: "codex",
			installed,
			model: { baseUrl: "http://127.0.0.1:1/v1", credential: "test", model: "test" },
		});
		expect(registration.routing.mode).toBe(mode);
	}
});

it("keeps the REM Enhanced model split in the call table, not in the registration", () => {
	const installed = codingSkinInstallationSchema.parse({
		storePath: join(tmpdir(), "coding-skin-rem.sqlite"),
		mode: "rem-enhanced",
	});
	const registration = createCodingSkinRegistration({
		skinId: "codex",
		installed,
		model: { baseUrl: "http://127.0.0.1:1/v1", credential: "test", model: "test" },
	});
	expect(registration.routing).toEqual({ mode: "rem-enhanced", language: "en" });
	const destination = (callId: "E1" | "REM1" | "REM2" | "P2") => {
		const route = resolveLlmRoute({ callId, config: registration.routing });
		return "off" in route ? "off" : route.destination;
	};
	expect([destination("E1"), destination("REM1"), destination("REM2"), destination("P2")])
		.toEqual(["sno-gpu", "sno-gpu", "host", "host"]);
	expect(() => codingSkinInstallationSchema.parse({
		storePath: join(tmpdir(), "coding-skin-rem.sqlite"),
		mode: "rem-enhanced",
		remEnhanced: { occasions: { memoryExtract: "agent" } },
	})).toThrow(/occasions/);
});
