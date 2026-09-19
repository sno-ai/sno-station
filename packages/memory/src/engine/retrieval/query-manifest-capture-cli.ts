/** @file query-manifest-capture-cli.ts
 * @purpose Runs reviewed query capture against an explicit store and scratch output path or stdout.
 * @boundary Caller-selected JSON input, read-only MemoryStore composition, and serialization only.
 */

import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { z } from "zod";
import { writeEmergencyDiagnostic } from "../observability/early-diagnostics";
import { createEmbedder } from "../extraction/embedding-provider-client";
import {
	captureQueryManifest,
	hashQueryManifestStorePath,
	serializeQueryManifestCapture,
	type ReviewedQueryInput,
} from "./query-manifest-capture";
import { embeddingConfigSchema } from "../../../config/plugin-config-embedding-schema";
import { retrievalConfigSchema } from "../../../config/plugin-config-retrieval-schema";
import { parseVecTableDimension } from "../../store/connection";
import { resolveSimpleTokenizerPath } from "../../store/simple-tokenizer-path";
import { loadSqliteVecExtension } from "../../store/sqlite-vec-path";
import {
	initSqliteRuntimeSync,
	openSqliteDatabase,
	type SqliteRuntimeHandle,
} from "../../store/sqlite-runtime";
import { MemoryStore } from "../../store/store";

const reviewedQuerySchema: z.ZodType<ReviewedQueryInput> = z
	.object({
		queryId: z.string().min(1),
		text: z.string().min(1),
		projectId: z.string().min(1),
		intent: z.enum(["lookup", "list-all", "recommend", "synthesis", "other"]),
		taskMode: z.enum(["current", "history", "non-task"]),
		expectedAddresses: z.array(
			z.object({
				sectionName: z.string().min(1),
				expectedLiveMatchCount: z.number().int().min(0),
			}),
		),
		requiredSupportingCarrierIds: z.array(z.string().min(1)),
		expectedActiveTaskIds: z.array(z.string().min(1)),
		expectedTerminalTaskIds: z.array(z.string().min(1)),
	})
	.strict();

const captureInputSchema = z
	.object({
		storePath: z.string().min(1),
		referenceTimeMs: z.number().int().nonnegative(),
		embedding: embeddingConfigSchema,
		retrieval: retrievalConfigSchema,
		queries: z.array(reviewedQuerySchema).min(1),
	})
	.strict();

interface CliOptions {
	inputPath: string;
	outputPath?: string;
}

interface ReadonlyStoreHandle {
	store: MemoryStore;
	close: () => void;
}

const countRowSchema = z.object({
	count: z.union([z.number(), z.bigint()]),
});

const vectorTableRowSchema = z.object({
	sql: z.string(),
});

function createReadonlyStore(
	dbPath: string,
	embedder: ReturnType<typeof createEmbedder>,
): ReadonlyStoreHandle {
	const sqlite = openSqliteDatabase(dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		initializeReadonlyExtensions(sqlite);
		const vectorRow = vectorTableRowSchema.parse(
			sqlite.db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunk_vectors' LIMIT 1",
				)
				.get(),
		);
		const vectorDim = parseVecTableDimension(vectorRow.sql);
		if (vectorDim !== embedder.dimensions) {
			throw new Error(
				`Vector dimension mismatch: store=${vectorDim} embedder=${embedder.dimensions}`,
			);
		}
		const chunkless = countRowSchema.parse(
			sqlite.db
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memories m WHERE NOT EXISTS (SELECT 1 FROM nodix_memory_chunks c WHERE c.memory_id = m.id)",
				)
				.get(),
		);
		if (Number(chunkless.count) > 0) {
			throw new Error(
				`Read-only capture refuses ${String(chunkless.count)} memories without production chunks`,
			);
		}
		const hasFtsSupport =
			sqlite.db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunks_fts' LIMIT 1",
				)
				.get() !== undefined;
		return {
			store: assembleReadonlyMemoryStore(dbPath, embedder, sqlite, vectorDim, hasFtsSupport),
			close: () => sqlite.db.close(),
		};
	} catch (error) {
		sqlite.db.close();
		throw error;
	}
}

function initializeReadonlyExtensions(sqlite: SqliteRuntimeHandle): void {
	loadSqliteVecExtension(sqlite.raw);
	const tokenizer = resolveSimpleTokenizerPath();
	sqlite.db.loadExtension(tokenizer.extensionPath);
	sqlite.db.prepare("SELECT jieba_dict(?)").get(tokenizer.dictPath);
}

function assembleReadonlyMemoryStore(
	dbPath: string,
	embedder: ReturnType<typeof createEmbedder>,
	sqlite: SqliteRuntimeHandle,
	vectorDim: number,
	hasFtsSupport: boolean,
): MemoryStore {
	const store: MemoryStore = Object.create(MemoryStore.prototype);
	Object.defineProperties(store, {
		dbPath: { value: dbPath, enumerable: true },
		hasFtsSupport: { value: hasFtsSupport, enumerable: true },
		sqlite: { value: sqlite.db },
		vectorDim: { value: vectorDim },
		embedder: { value: embedder },
		backfillComplete: { value: true, writable: true },
		backfillPromise: { value: null, writable: true },
		closed: { value: false, writable: true },
	});
	return store;
}

function parseCliOptions(): CliOptions {
	const parsed = parseArgs({
		options: {
			input: { type: "string", short: "i" },
			output: { type: "string", short: "o" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (!parsed.values.input) {
		throw new Error("Usage: query-manifest-capture --input <reviewed-input.json> [--output <scratch.json>]");
	}
	return {
		inputPath: resolve(parsed.values.input),
		...(parsed.values.output ? { outputPath: resolve(parsed.values.output) } : {}),
	};
}

async function main(): Promise<void> {
	const options = parseCliOptions();
	const rawInput: unknown = JSON.parse(await readFile(options.inputPath, "utf8"));
	const input = captureInputSchema.parse(rawInput);
	const storePath = await realpath(resolve(input.storePath));
	const storeHashBefore = hashQueryManifestStorePath(storePath);
	const { recallTopK, ...retrievalConfig } = input.retrieval;
	initSqliteRuntimeSync();
	const embedder = createEmbedder(input.embedding, dirname(storePath));
	let storeHandle: ReadonlyStoreHandle | undefined;
	let serialized: ReturnType<typeof serializeQueryManifestCapture> | undefined;
	let operationError: unknown;
	try {
		await embedder.warmup();
		storeHandle = createReadonlyStore(storePath, embedder);
		const capture = await captureQueryManifest({
			store: storeHandle.store,
			embedder,
			referenceTimeMs: input.referenceTimeMs,
			retrievalConfig,
			productionTopK: recallTopK,
			queries: input.queries,
		});
		serialized = serializeQueryManifestCapture(capture);
	} catch (error) {
		operationError = error;
	} finally {
		try {
			storeHandle?.close();
		} catch (error) {
			operationError ??= error;
		}
		try {
			await embedder.dispose();
		} catch (error) {
			operationError ??= error;
		}
	}
	const storeHashAfter = hashQueryManifestStorePath(storePath);
	if (storeHashAfter !== storeHashBefore) {
		throw new Error("Store bytes changed during read-only capture lifecycle");
	}
	if (operationError !== undefined) throw operationError;
	if (!serialized) throw new Error("Capture completed without serialized output");
	if (options.outputPath) {
		await writeFile(options.outputPath, serialized.bytes, { flag: "wx" });
		writeEmergencyDiagnostic({ level: "info", body: "Query manifest capture written", attributes: { output_path: options.outputPath, artifact_sha256: serialized.sha256, outcome: "success" }, source: { event_name: "query_manifest.capture.written", file: "packages/sno-station-mem/src/engine/retrieval/query-manifest-capture-cli.ts", function: "main", site_id: "query_manifest.capture.written" } });
	} else {
		process.stdout.write(serialized.bytes);
	}
}

void main().catch((error: unknown) => {
	writeEmergencyDiagnostic({ level: "error", body: "Query manifest capture failed", attributes: { error, exit_code: 1 }, source: { event_name: "query_manifest.capture.failed", file: "packages/sno-station-mem/src/engine/retrieval/query-manifest-capture-cli.ts", function: "<module>", site_id: "query_manifest.capture.failed" } });
	process.exitCode = 1;
});
