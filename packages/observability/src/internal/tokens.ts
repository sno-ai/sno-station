import { logger } from "./log.js";

export interface TokenCount {
	tokens: number;
	method: "tiktoken" | "char_approximation";
}

interface Encoder {
	encode(input: string): unknown[];
}

interface TokenModule {
	encodingForModel?: (model: string) => Encoder;
	getEncoding?: (name: string) => Encoder;
}

let encoderPromise: Promise<Encoder | null> | null = null;

export async function countTokens(text: string): Promise<TokenCount> {
	if (text.length > 100_000) {
		return { tokens: countTokensFast(text), method: "char_approximation" };
	}
	const encoder = await loadEncoder();
	if (encoder === null) {
		return { tokens: countTokensFast(text), method: "char_approximation" };
	}
	return { tokens: encoder.encode(text).length, method: "tiktoken" };
}

export function countTokensFast(text: string): number {
	return Math.ceil(new TextEncoder().encode(text).byteLength / 3.7);
}

async function loadEncoder(): Promise<Encoder | null> {
	encoderPromise ??= import("js-tiktoken")
		.then((module) => {
			const tokenModule = module as TokenModule;
			if (tokenModule.encodingForModel !== undefined) {
				return tokenModule.encodingForModel("gpt-4o");
			}
			if (tokenModule.getEncoding !== undefined) {
				return tokenModule.getEncoding("o200k_base");
			}
			return null;
		})
		.catch((error: unknown) => {
			logger.warn("sno observe tiktoken init failed; falling back to char approximation", {
				error,
			}, {
				event_name: "sno.observe.internal.tokens.loadencoder",
				file: "packages/sno-observe/src/internal/tokens.ts",
				function: "loadEncoder",
				site_id: "sno.observe.internal.tokens.loadencoder.1",
			});
			return null;
		});
	return encoderPromise;
}
