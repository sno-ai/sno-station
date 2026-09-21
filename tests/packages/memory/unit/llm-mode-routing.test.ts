/** Proves the surviving product-mode schema and atomic request routing. */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_MODE,
	llmRoutingConfigSchema,
} from "../../../../packages/sno-station-mem/config/plugin-config-mode-schema";
import { pickLlmRoutingConfig, resolveLlmRoute } from "../../../../packages/sno-station-mem/src/model/llm-mode-routing";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/engine/shared/types";

const LOCAL_RERANK = { retrieval: { rerank: "lightweight" } } as const;

describe("plugin config product mode", () => {
	it("defaults to the shared agent-native mode and strips the legacy gate key", () => {
		const defaults = pluginConfigSchema.parse({});
		expect(DEFAULT_MODEL_MODE).toBe("agent-native");
		expect(defaults.mode).toBe(DEFAULT_MODEL_MODE);
		expect(defaults.agentNative.flavor).toBe("subscription");
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

describe("atomic LLM route selection", () => {
	it("uses chat for generic and guard calls and raw completions for profile profileKeying", () => {
		const config = pluginConfigSchema.parse({ ...LOCAL_RERANK, mode: "rem-enhanced" });
		for (const callLabel of [
			"memory-extract-atomic-generic",
			"memory-extract-atomic-missing-half",
			"memory-extract-atomic-resplit",
			"memory-extract-atomic-subject-guard",
		] as const) {
			expect(resolveLlmRoute({ slot: "memory-extract", callLabel, config })).toEqual({
				tier: "snoRemMem",
				transport: "chat-completions",
				parser: "json",
			});
		}
		expect(
			resolveLlmRoute({ slot: "memory-extract", callLabel: "memory-extract-profile", config }),
		).toEqual({ tier: "snoRemMem", transport: "raw-completions", parser: "json" });
	});

	it("turns every atomic extraction request off in local-first", () => {
		const config = llmRoutingConfigSchema.parse({ mode: "local-first" });
		for (const callLabel of [
			"memory-extract-atomic-generic",
			"memory-extract-atomic-missing-half",
			"memory-extract-atomic-resplit",
			"memory-extract-atomic-subject-guard",
			"memory-extract-profile",
		] as const) {
			expect(resolveLlmRoute({ slot: "memory-extract", callLabel, config })).toEqual({
				off: true,
				reason: "mode-local-first",
			});
		}
	});

	it("uses the host seam for subscription agent-native and chat for BYOK", () => {
		for (const [flavor, transport] of [
			["subscription", "agent-host-seam"],
			["byok", "chat-completions"],
		] as const) {
			const config = llmRoutingConfigSchema.parse({ mode: "agent-native", agentNative: { flavor } });
			expect(
				resolveLlmRoute({
					slot: "memory-extract",
					callLabel: "memory-extract-atomic-generic",
					config,
				}),
			).toEqual({ tier: "agent", transport, parser: "json" });
		}
	});

	it("fails closed for unknown labels and retired slots", () => {
		const config = llmRoutingConfigSchema.parse({ mode: "rem-enhanced" });
		expect(
			resolveLlmRoute({ slot: "profile-merge", callLabel: "unknown-profile-merge", config }),
		).toEqual({ off: true, reason: "unknown-call-label" });
		expect(
			resolveLlmRoute({ slot: "compaction-merge", callLabel: "anything", config }),
		).toEqual({ off: true, reason: "slot-retired" });
		expect(() =>
			resolveLlmRoute({ slot: "date-resolution", callLabel: "wrong-date-label", config }),
		).toThrow(/Unknown LLM call label/u);
	});
});
