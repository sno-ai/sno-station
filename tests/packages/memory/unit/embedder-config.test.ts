import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { embeddingConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-embedding-schema.ts";
import { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { DEFAULT_MAX_CONTEXT_TOKENS } from "../../../../packages/sno-station-mem/config/index.ts";

describe("Embedder config validation", () => {
	it.each(["openai-compatible", "voyage-multimodal"])(
		"rejects removed provider %s",
		(provider) => {
			expect(embeddingConfigSchema.safeParse({ provider }).success).toBe(false);
		},
	);

	it("rejects batch embedding provider responses with the wrong vector count", async () => {
		const stateDir = mkdtempSync(
			join(tmpdir(), "mem-claw-embedder-config-"),
		);
		try {
			const embedder = new Embedder(
				{ provider: "local-onnx", chunking: false },
				stateDir,
			);
			Object.defineProperty(embedder, "provider", {
				value: {
					dispose: async () => undefined,
					embed: async () => new Array(1024).fill(0),
					embedDocuments: async () => [new Array(1024).fill(0)],
				},
			});

			await expect(embedder.embedMany(["alpha", "beta"])).rejects.toThrow(
				"Embedding provider returned 1 vectors for 2 inputs",
			);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("chunks oversized passages through the package-backed safety path", async () => {
		const stateDir = mkdtempSync(
			join(tmpdir(), "mem-claw-embedder-config-"),
		);
		try {
			const embedder = new Embedder({ provider: "local-onnx" }, stateDir);
			const embeddedPassages: string[] = [];
			Object.defineProperty(embedder, "provider", {
				value: {
					dispose: async () => undefined,
					// One token per whitespace-separated word keeps the ceiling arithmetic readable.
					countTokens: (text: string) => text.split(/\s+/).filter(Boolean).length,
					embed: async (text: string) => {
						embeddedPassages.push(text);
						return new Array(1024).fill(0);
					},
					embedDocuments: async (texts: string[]) => {
						embeddedPassages.push(...texts);
						return texts.map(() => new Array(1024).fill(0));
					},
				},
			});

			const words = DEFAULT_MAX_CONTEXT_TOKENS * 2;
			const vector = await embedder.embed("Alpha package chunk. ".repeat(Math.ceil(words / 3)));

			expect(vector).toHaveLength(1024);
			expect(embeddedPassages.length).toBeGreaterThan(1);
			expect(embeddedPassages.join("\n")).toContain("Alpha package chunk.");
			expect(embeddedPassages.every((text) => text.trim().length > 0)).toBe(true);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
});
