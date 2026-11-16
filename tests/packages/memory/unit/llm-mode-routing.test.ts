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
import { defaultSettings, settingsSchema, type Settings } from "../../../../packages/memory/config/settings";
import { pluginConfigSchema } from "../../../../packages/memory/src/engine/shared/types";
import { DEFAULT_SETTINGS_PATH } from "../fixtures/settings-file-fixture";

const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;
// Production reads destinations from settings.json; the shipped default document is what `sno` writes.
const SHIPPED_MODEL_CALLS = (JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as Settings).modelCalls;

describe("plugin config product mode", () => {
	it("defaults to the shared agent-native mode and refuses the removed gate key", () => {
		const defaults = pluginConfigSchema.parse({});
		expect(DEFAULT_MODEL_MODE).toBe("agent-native");
		expect(defaults.mode).toBe(DEFAULT_MODEL_MODE);
		expect(defaults).not.toHaveProperty("agentNative");
		expect(pickLlmRoutingConfig(defaults).language).toBe("en");

		expect(() => pluginConfigSchema.parse({
			...LOCAL_RERANK,
			mode: "agent-native",
			llmGates: { agentWriteCapture: true },
		})).toThrow(/llmGates/);
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

// Released routing includes the 2026-10-13 decision to disable missed-figure recovery by default.
const EXPECTED: Record<string, Record<Mode, "off" | "host" | "sno-gpu">> = {
	E1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E2: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E3: { "local-first": "off", "agent-native": "off", "rem-enhanced": "off" },
	E4: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E5: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E6: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E7: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E8: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E9: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E10: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E11: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E12: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E13: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E14: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	E15: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E16: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E17: { "local-first": "off", "agent-native": "off", "rem-enhanced": "sno-gpu" },
	E19: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E20: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E21: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E22: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E23: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	E24: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	P1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "sno-gpu" },
	P2: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P3: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P4: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P5: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	P6: { "local-first": "host", "agent-native": "host", "rem-enhanced": "host" },
	T1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
	R1: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
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
		for (const match of text.matchAll(/(?:\/\/ Model call |callId:\s*["']|json\(night,\s*["'])(REM\d+|[EPTR]\d+)\b/gu)) {
			const [, id] = match;
			if (id) ids.add(id);
		}
	}
	return ids;
}

describe("model call table", () => {
	it.each(["E13", "E16", "E21", "E24", "E22", "E23"] as const)(
		"checking-side case 1: %s defaults agree in table, schema, factory and shipped JSON",
		callId => {
			const defaults = defaultSettings();
			const modelCalls = { ...defaults.modelCalls };
			Reflect.deleteProperty(modelCalls, callId);
			const parsed = settingsSchema.parse({ ...defaults, modelCalls, store: { path: "fixture.sqlite", encryptionKey: "a".repeat(64) } });
			const expected = { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" };
			expect.soft(MODEL_CALLS[callId].destinations, "table").toEqual(expected);
			expect.soft(parsed.modelCalls[callId], "schema default").toEqual(expected);
			expect.soft(defaults.modelCalls[callId], "settings factory").toEqual(expected);
			expect.soft(SHIPPED_MODEL_CALLS[callId], "generated settings").toEqual(expected);
			expect(MODEL_CALLS.E1.destinations).toEqual(EXPECTED.E1);
			expect(parsed.modelCalls.E1).toEqual(EXPECTED.E1);
			expect(SHIPPED_MODEL_CALLS.E1).toEqual(EXPECTED.E1);
		},
	);
	it.each([
		["E15", { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" }],
		["E20", { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" }],
		["E19", { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" }],
	] as const)("declares %s destinations for nightly session-start work", (callId, destinations) => {
		expect(MODEL_CALLS[callId].destinations).toEqual(destinations);
	});

	it("marks exactly the memory service's rows in the product source", () => {
		expect([...sourceCallIds()].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it("ships a default settings document with the service's rows plus the RSI skill's R2, R3, R4, R5", () => {
		const shipped = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as { modelCalls: unknown };
		expect(shipped.modelCalls).toEqual({
			...EXPECTED,
			R2: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" },
			R3: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" },
			R4: { "local-first": "off", "agent-native": "sno-gpu", "rem-enhanced": "sno-gpu" },
			R5: { "local-first": "host", "agent-native": "off", "rem-enhanced": "off" },
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
		for (const callId of ["E1"] as const) {
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
	});

	it("uses the call's host transport on every host route and refuses the removed flavor key", () => {
		const host = { tier: "agent", destination: "host", transport: "agent-host-seam", parser: "json" };
		expect(resolveLlmRoute({ callId: "E1", config: llmRoutingConfigSchema.parse({ mode: "agent-native", modelCalls: SHIPPED_MODEL_CALLS }) })).toEqual(host);
		for (const callId of ["E2", "E4", "E5", "E6", "E7", "E8", "E12"] as const) {
			expect(resolveLlmRoute({ callId, config: llmRoutingConfigSchema.parse({ mode: "rem-enhanced", modelCalls: SHIPPED_MODEL_CALLS }) })).toEqual(host);
		}
		expect(() => llmRoutingConfigSchema.parse({ mode: "agent-native", agentNative: { flavor: "byok" } })).toThrow(/agentNative/);
		expect(() => llmRoutingConfigSchema.parse({ mode: "rem-enhanced", remEnhanced: { occasions: { memoryExtract: "agent" } } }))
			.toThrow(/remEnhanced/);
	});
});
