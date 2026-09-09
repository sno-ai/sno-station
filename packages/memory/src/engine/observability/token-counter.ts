/** @file token-counter.ts
 * @purpose Selects the token counter labels accepted by sno.ai analytics.
 * @boundary Counts metadata only; never affects embedding or retrieval behavior.
 */

import { LOCAL_EMBEDDING_MODEL } from "@snoai/embedder";
import { encodingForModel, getEncoding, type TiktokenModel } from "js-tiktoken";
import type { EmbeddingConfig } from "../extraction/embedding-provider-client";

export type TokensMethod =
	| "qwen_tokenizer"
	| "tiktoken"
	| "provider_reported"
	| "char_approximation";

export type TokenCount = {
	count: number;
	method: TokensMethod;
};

type QwenTokenizer = {
	encode(input: string, options?: { add_special_tokens?: boolean }): number[];
};

type QwenTokenizerLoader = (model: string) => Promise<QwenTokenizer>;

const qwenTokenizerPromises = new Map<string, Promise<QwenTokenizer>>();

async function defaultQwenTokenizerLoader(model: string): Promise<QwenTokenizer> {
	const { AutoTokenizer } = await import("@huggingface/transformers");
	return AutoTokenizer.from_pretrained(model);
}

let qwenTokenizerLoader: QwenTokenizerLoader = defaultQwenTokenizerLoader;

function hasProviderUsage(providerUsageTokens: number | undefined): providerUsageTokens is number {
	return providerUsageTokens !== undefined && Number.isFinite(providerUsageTokens);
}

function isQwenEmbedding(config: Pick<EmbeddingConfig, "provider" | "model">): boolean {
	const model = config.model ?? LOCAL_EMBEDDING_MODEL;
	return (config.provider ?? "local-onnx") === "local-onnx" && /qwen/i.test(model);
}

async function getQwenTokenizer(model: string): Promise<QwenTokenizer> {
	const cached = qwenTokenizerPromises.get(model);
	if (cached) return cached;
	const tokenizer = qwenTokenizerLoader(model).catch((error: unknown) => {
		qwenTokenizerPromises.delete(model);
		throw error;
	});
	qwenTokenizerPromises.set(model, tokenizer);
	return tokenizer;
}

/** @internal */
export function setQwenTokenizerLoaderForTests(loader?: QwenTokenizerLoader): void {
	qwenTokenizerPromises.clear();
	qwenTokenizerLoader = loader ?? defaultQwenTokenizerLoader;
}

function countWithTiktoken(text: string, model: string | undefined): number {
	try {
		return encodingForModel((model ?? "text-embedding-3-small") as TiktokenModel).encode(text)
			.length;
	} catch {
		return getEncoding("cl100k_base").encode(text).length;
	}
}

function charApproximation(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export async function countEmbeddingTokens(
	text: string,
	config: Pick<EmbeddingConfig, "provider" | "model">,
	providerUsageTokens?: number,
): Promise<TokenCount> {
	if (hasProviderUsage(providerUsageTokens)) {
		return {
			count: Math.max(0, Math.trunc(providerUsageTokens)),
			method: "provider_reported",
		};
	}
	if (isQwenEmbedding(config)) {
		const tokenizer = await getQwenTokenizer(config.model ?? LOCAL_EMBEDDING_MODEL);
		return {
			count: tokenizer.encode(text, { add_special_tokens: false }).length,
			method: "qwen_tokenizer",
		};
	}
	return { count: charApproximation(text), method: "char_approximation" };
}

export async function countManyEmbeddingTokens(
	values: string[],
	config: Pick<EmbeddingConfig, "provider" | "model">,
): Promise<TokenCount> {
	const counts = await Promise.all(values.map((value) => countEmbeddingTokens(value, config)));
	return {
		count: counts.reduce((sum, item) => sum + item.count, 0),
		method: counts[0]?.method ?? "char_approximation",
	};
}

export function countTextTokens(text: string, model: string | undefined): TokenCount {
	if (model?.startsWith("gpt-") || model?.startsWith("text-") || /qwen/i.test(model ?? "")) {
		return { count: countWithTiktoken(text, model), method: "tiktoken" };
	}
	return { count: charApproximation(text), method: "char_approximation" };
}
