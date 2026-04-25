/**
 * Integration test: perplexity-ai/pplx-embed-v1-0.6b (1024-d, mean pooling).
 *
 * Critical difference from the bundled Qwen3-Embedding-0.6B: pplx-embed is
 * trained with **mean pooling** and **`include_prompt: true`** (read from
 * `1_Pooling/config.json`), not last-token pooling. Wiring it as last-token
 * would silently produce useless embeddings — the test loads the model and
 * verifies that mean pooling produces unit-norm vectors with the expected
 * dimension. Quality is judged by the LoCoMo eval downstream.
 *
 * Model architecture is `PPLXQwen3Model` (`model_type:
 * bidirectional_pplx_qwen3`) — a Qwen3 with causal mask removed for
 * encoder-style embedding. ONNX inference doesn't run the architecture
 * code; the graph is fully self-contained, so transformers.js just needs
 * input/output names to match the standard feature-extraction convention.
 *
 * Skipped automatically when the model files are not present.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalEmbedProvider } from "@nodix/embedder";

const MODEL_DIR = resolve(
	import.meta.dir,
	"../../../../apps/storix-core/embedding/models",
);
const MODEL_FILE = resolve(
	MODEL_DIR,
	"perplexity-ai/pplx-embed-v1-0.6b/onnx/model.onnx",
);

const HAS_MODEL = existsSync(MODEL_FILE);

const SAMPLES = [
	"The quick brown fox jumps over the lazy dog.",
	"OpenClaw memory plugins use SQLite plus sqlite-vec for hybrid retrieval.",
	"Matryoshka representation learning trains so prefix vectors stay meaningful.",
	"在长对话中保留语义相关的记忆是评估嵌入模型质量的有效方式。",
	"四川担担面的灵魂是芽菜和花椒油的香气。",
];

function l2(v: number[]): number {
	let s = 0;
	for (const x of v) s += x * x;
	return Math.sqrt(s);
}

describe.skipIf(!HAS_MODEL)(
	"LocalEmbedProvider — pplx-embed-v1-0.6b (mean pool, 1024d)",
	() => {
		let provider: LocalEmbedProvider;

		beforeAll(() => {
			LocalEmbedProvider.resetStaticState();
			provider = new LocalEmbedProvider({
				cacheDir: MODEL_DIR,
				model: "perplexity-ai/pplx-embed-v1-0.6b",
				revision: "main",
				// q8 uses GatherBlockQuantized which onnxruntime-node 1.21 rejects.
				// fp32 (`model.onnx`) loads cleanly with the bundled ORT.
				dtype: "fp32",
				nativeDim: 1024,
				outputDim: 1024,
				pooling: "mean",
			});
		});

		afterAll(async () => {
			await provider.dispose();
		});

		it("warms up, reports outputDim=1024", async () => {
			const t0 = performance.now();
			await provider.warmup();
			const warmupMs = performance.now() - t0;
			console.log(`[pplx-embed] warmup: ${warmupMs.toFixed(0)} ms`);
			expect(provider.dimension).toBe(1024);
		});

		it("returns 1024-d unit-norm vectors", async () => {
			const v = await provider.embed(SAMPLES[0] ?? "");
			expect(v.length).toBe(1024);
			expect(Math.abs(l2(v) - 1)).toBeLessThan(1e-3);
		});

		it("query encoding stays unit-norm", async () => {
			const v = await provider.embedQuery("how does memory dedup work?");
			expect(v.length).toBe(1024);
			expect(Math.abs(l2(v) - 1)).toBeLessThan(1e-3);
		});

		it("measures per-call latency over a 5-sample batch", async () => {
			const latencies: number[] = [];
			for (const text of SAMPLES) {
				const t = performance.now();
				const v = await provider.embed(text);
				latencies.push(performance.now() - t);
				expect(v.length).toBe(1024);
			}
			const sorted = [...latencies].sort((a, b) => a - b);
			const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
			const max = sorted[sorted.length - 1] ?? 0;
			const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;
			console.log(
				`[pplx-embed] embed n=${latencies.length}: ` +
					`mean=${mean.toFixed(0)}ms p50=${p50.toFixed(0)}ms max=${max.toFixed(0)}ms`,
			);
		});

		it("paraphrase ranks above unrelated content (mean-pool sanity)", async () => {
			// pplx-embed-v1-0.6b's card claims strong open-embed quality; if mean
			// pooling is wired right, anchor↔paraphrase should clearly beat
			// anchor↔unrelated content. If this fails, suspect either pooling
			// (wrong mode) or `include_prompt` semantics in transformers.js.
			const anchor = await provider.embed(
				"OpenClaw uses SQLite plus sqlite-vec for hybrid retrieval.",
			);
			const para = await provider.embed(
				"Hybrid retrieval in OpenClaw is built on top of SQLite and sqlite-vec.",
			);
			const unrelated = await provider.embed(
				"四川担担面的灵魂是芽菜和花椒油的香气。",
			);
			const cosSim = (a: number[], b: number[]): number => {
				let s = 0;
				for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
				return s;
			};
			const simPara = cosSim(anchor, para);
			const simUnrel = cosSim(anchor, unrelated);
			console.log(
				`[pplx-embed] cos(anchor,para)=${simPara.toFixed(3)}, ` +
					`cos(anchor,unrelated_zh)=${simUnrel.toFixed(3)}`,
			);
			expect(simPara).toBeGreaterThan(simUnrel);
		});
	},
);
