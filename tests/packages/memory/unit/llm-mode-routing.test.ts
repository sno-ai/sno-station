/** Proves the surviving product-mode schema and the model call table's released routing. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_MODE,
	llmRoutingConfigSchema,
} from "../../../../packages/memory/config/plugin-config-mode-schema";
import { pickLlmRoutingConfig, resolveLlmRoute } from "../../../../packages/memory/src/model/llm-mode-routing";
import {
	MODEL_CALLS,
	modelCallDestination,
	type ModelCallId,
} from "../../../../packages/memory/src/model/model-call-table";
import type { Settings } from "../../../../packages/memory/config/settings";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types";
import { DEFAULT_SETTINGS_PATH } from "../fixtures/settings-file-fixture";

const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;
// Production reads destinations from settings.json; the shipped default document is what `sno` writes.
const SHIPPED_MODEL_CALLS = (JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as Settings).modelCalls;

describe("plugin config product mode", () => {
	it("defaults to the shared agent-native mode and strips the legacy gate key", () => {
		const defaults = pluginConfigSchema.parse({});
		expect(DEFAULT_MODEL_MODE).toBe("agent-native");
		expect(defaults.mode).toBe(DEFAULT_MODEL_MODE);
		expect(defaults).not.toHaveProperty("agentNative");
		expect(pickLlmRoutingConfig(defaults).language).toBe("en");

		const parsed = pluginConfigSchema.parse({
			...LOCAL_RERANK,
			mode: "agent-native",
			llmGates: { agentWriteCapture: true },
		});
		expect("llmGates" in parsed).toBe(false);
	});

	it("rejects the retired extraction selector", () => {
		const removedValue = ["llm", "distill"].join("-");
		expect(() =>
			pluginConfigSchema.parse({
				...LOCAL_RERANK,
				mode: "agent-native",
				extraction: { mode: removedValue },
			}),
		).toThrow();
	});

	it("applies the shared default when an LLM route omits the mode", () => {
		const parsed = pluginConfigSchema.parse({
			...LOCAL_RERANK,
			extraction: { llm: { preset: "mem_claw/sno_ai_extract" } },
		});
		expect(parsed.mode).toBe(DEFAULT_MODEL_MODE);
	});
});

const SOURCE_ROOT = fileURLToPath(new URL("../../../../packages/memory/src/", import.meta.url));
const MODES = ["local-first", "agent-native", "rem-enhanced"] as const;
type Mode = (typeof MODES)[number];

// The released PRD's call table, written out literally so a changed row in the product fails here.
const EXPECTED: Record<string, Record<Mode, "off" | "host" | "sno-gpu">> = {
	E1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E2: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E3: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E4: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E5: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E6: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E7: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E8: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E9: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E10: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E11: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E12: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	P1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	P2: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P3: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P4: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P5: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P6: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	T1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	R1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	REM1: { "local-first": "host", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	REM2: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	REM3: { "local-first": "host", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	REM4: { "local-first": "host", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	REM5: { "local-first": "host", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	REM6: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	REM7: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	REM8: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
};

function column(read: (id: ModelCallId) => string): Record<string, string> {
	return Object.fromEntries(
		(Object.keys(EXPECTED) as ModelCallId[]).map((id) => [id, read(id)]),
	);
}

function expectedColumn(mode: Mode): Record<string, string> {
	return Object.fromEntries(Object.entries(EXPECTED).map(([id, row]) => [id, row[mode]]));
}

function sourceCallIds(): Set<string> {
	const ids = new Set<string>();
	for (const entry of readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
		for (const match of text.matchAll(/\/\/ Model call (REM\d+|[EPTR]\d+)\b/gu)) {
			const [, id] = match;
			if (id) ids.add(id);
		}
	}
	return ids;
}

describe("model call table", () => {
	it("marks exactly the memory service's rows in the product source", () => {
		expect([...sourceCallIds()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it("ships a default settings document with the service's rows plus the RSI skill's R2, R3, R4", () => {
		const shipped = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as { modelCalls: unknown };
		expect(shipped.modelCalls).toEqual({
			...EXPECTED,
			R2: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
			R3: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" },
			R4: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" },
		});
	});

	it("gives every row a destination in all three modes", () => {
		for (const [id, call] of Object.entries(MODEL_CALLS)) {
			expect(Object.keys(call.destinations).sort(), id).toEqual([...MODES].sort());
			for (const destination of Object.values(call.destinations)) {
				expect(["off", "host", "sno-gpu"], id).toContain(destination);
			}
		}
	});

	for (const mode of MODES) {
		it(`routes the ${mode} column as released`, () => {
			expect(column((id) => modelCallDestination(id, mode, SHIPPED_MODEL_CALLS))).toEqual(expectedColumn(mode));
		});

		it(`resolves every call under default ${mode} settings to the released destination`, () => {
			const config = llmRoutingConfigSchema.parse({ mode, modelCalls: SHIPPED_MODEL_CALLS });
			expect(
				column((id) => {
					const route = resolveLlmRoute({ callId: id, config });
					return "off" in route ? "off" : route.destination;
				}),
			).toEqual(expectedColumn(mode));
		});
	}
});

describe("model call transport", () => {
	it("uses chat for generic and guard calls and raw completions for profile keying on the GPU", () => {
		const config = pluginConfigSchema.parse({
			...LOCAL_RERANK,
			mode: "rem-enhanced",
			modelCalls: SHIPPED_MODEL_CALLS,
		});
		for (const callId of ["E1", "E4", "E5", "E6"] as const) {
			expect(resolveLlmRoute({ callId, config })).toEqual({
				tier: "snoRemMem",
				destination: "sno-gpu",
				transport: "chat-completions",
				parser: "json",
			});
		}
		expect(resolveLlmRoute({ callId: "E9", config })).toEqual({
			tier: "snoRemMem",
			destination: "sno-gpu",
			transport: "raw-completions",
			parser: "json",
		});
		expect(resolveLlmRoute({ callId: "REM1", config })).toEqual({
			tier: "snoRemMem",
			destination: "sno-gpu",
			transport: "raw-completions",
			parser: "single-token-verdict",
		});
	});

	it("uses the call's host transport on every host route and refuses the removed flavor key", () => {
		const host = { tier: "agent", destination: "host", transport: "agent-host-seam", parser: "json" };
		expect(resolveLlmRoute({ callId: "E1", config: llmRoutingConfigSchema.parse({ mode: "agent-native", modelCalls: SHIPPED_MODEL_CALLS }) })).toEqual(host);
		expect(resolveLlmRoute({ callId: "REM2", config: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: SHIPPED_MODEL_CALLS }) })).toEqual(host);
		expect(() => llmRoutingConfigSchema.parse({ mode: "agent-native", agentNative: { flavor: "byok" } })).toThrow(/agentNative/);
		expect(() => llmRoutingConfigSchema.parse({ mode: "rem-enhanced", remEnhanced: { occasions: { memoryExtract: "agent" } } }))
			.toThrow(/remEnhanced/);
	});
});
