import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSettings } from "../../../../packages/memory/src/contract/profile";
import { resolveLlmRoute } from "../../../../packages/memory/src/model/llm-mode-routing";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reads store, recall, rerank and telemetry from one settings file", () => {
	const root = mkdtempSync(join(tmpdir(), "settings-parity-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	const { settings } = writeSettingsFixture(root, {
		mode: "rem-enhanced",
		store: { path: join(root, "existing.sqlite") },
		recall: { prompt: { limit: 7, timeoutMs: 7000 } },
		rerank: { mode: "cross-encoder", provider: "tei", endpoint: "http://127.0.0.1:19213/rerank", apiKey: "rerank-key-present" },
		telemetry: { memoryUsage: { enabled: false } },
	});
	const read = readSettings();
	expect(read.mode).toBe("rem-enhanced");
	expect(read.store.path).toBe(join(root, "existing.sqlite"));
	expect(read.recall.prompt).toMatchObject({ limit: 7, timeoutMs: 7000 });
	expect(read.rerank).toMatchObject({ mode: "cross-encoder", provider: "tei", apiKey: "rerank-key-present" });
	expect(read.telemetry.memoryUsage.enabled).toBe(false);
	expect(read).toEqual(settings);
});

it.each(["local-first", "agent-native", "rem-enhanced"] as const)("uses %s routing from settings", mode => {
	const root = mkdtempSync(join(tmpdir(), "settings-routing-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	writeSettingsFixture(root, { mode });
	const settings = readSettings();
	const destination = (callId: "E1" | "REM1" | "REM2" | "P2") => {
		const route = resolveLlmRoute({ callId, config: settings });
		return "off" in route ? "off" : route.destination;
	};
	if (mode === "rem-enhanced") {
		expect([destination("E1"), destination("REM1"), destination("REM2"), destination("P2")])
			.toEqual(["sno-gpu", "sno-gpu", "host", "host"]);
	} else {
		expect(settings.mode).toBe(mode);
	}
});
