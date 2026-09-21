import { z } from "zod";

import { VECTOR_DIMENSION_DEFAULT } from "./index";

const localEmbedSessionOptionsSchema = z
	.object({
		graphOptimizationLevel: z
			.enum(["disabled", "basic", "extended", "all"])
			.default("extended"),
		enableMemPattern: z.boolean().default(false),
		enableCpuMemArena: z.boolean().default(false),
		executionMode: z.enum(["sequential", "parallel"]).optional(),
		interOpNumThreads: z.number().int().positive().optional(),
		intraOpNumThreads: z.number().int().positive().optional(),
	})
	.strict()
	.prefault({});

export const embeddingConfigSchema: z.ZodType<
	{
		provider: "local-onnx";
		model?: string | undefined;
		dimensions: number;
		nativeDim?: number | undefined;
		revision?: string | undefined;
		pooling?: "last_token" | "mean" | "cls" | undefined;
		normalized?: boolean | undefined;
		cacheDir?: string | undefined;
		dtype: "q4" | "q8" | "fp16" | "fp32";
		sessionOptions: {
			graphOptimizationLevel: "disabled" | "basic" | "extended" | "all";
			enableMemPattern: boolean;
			enableCpuMemArena: boolean;
			executionMode?: "sequential" | "parallel" | undefined;
			interOpNumThreads?: number | undefined;
			intraOpNumThreads?: number | undefined;
		};
		chunking: boolean;
	},
	unknown
> = z
	.object({
		provider: z.enum(["local-onnx"]).default("local-onnx"),
		/** Hugging Face model id. Defaults to the bundled PPLX INT8 model. */
		model: z.string().optional(),
		/** Output dimension after optional truncation and re-normalization. */
		dimensions: z.number().int().positive().default(VECTOR_DIMENSION_DEFAULT),
		/** Native dimension produced by the local model. */
		nativeDim: z.number().int().positive().optional(),
		/** Pinned HuggingFace revision (commit SHA) for local-onnx supply-chain integrity. */
		revision: z.string().optional(),
		/**
		 * Pooling strategy for local-onnx. Read from the model's
		 * `1_Pooling/config.json`. Omit to use the provider default; the bundled
		 * PPLX model uses `mean`.
		 */
		pooling: z.enum(["last_token", "mean", "cls"]).optional(),
		normalized: z.boolean().optional(),
		/** Local ONNX model cache directory */
		cacheDir: z.string().optional(),
		/** Quantization dtype: q4 | q8 | fp16 | fp32 */
		dtype: z.enum(["q4", "q8", "fp16", "fp32"]).default("q8"),
		/** ONNX Runtime session options for local low-memory operation. */
		sessionOptions: localEmbedSessionOptionsSchema,
		/** Enable text chunking for long passages (default: true) */
		chunking: z.boolean().default(true),
	})
	.prefault({});
