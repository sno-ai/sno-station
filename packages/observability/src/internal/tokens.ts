import { logger } from "./log.js";

export interface TokenCount {
	tokens: number;
	method: "bpe" | "fast";
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
		return { tokens: countTokensFast(text), method: "fast" };
	}
	const encoder = await loadEncoder();
	if (encoder === null) {
		return { tokens: countTokensFast(text), method: "fast" };
	}
	return { tokens: encoder.encode(text).length, method: "bpe" };
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
			logger.warn("sno observe tiktoken init failed; falling back to fast counter", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		});
	return encoderPromise;
}
