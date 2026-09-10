/** @file memory-cli-shared.ts
 * @purpose Shares memory CLI context, parsing, serialization, and prompt helpers.
 * @boundary Pure CLI helper logic only; command registration lives in dedicated modules.
 */

import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface as createPrompt } from "node:readline/promises";
import type { Writable } from "node:stream";
import { DEFAULT_IMPORTANCE, DEFAULT_SCOPE } from "../../../config/index";
import type { Embedder } from "../extraction/embedding-provider-client";
import type { MemoryRetriever } from "../retrieval/retriever";
import { SnoStationMemError } from "../shared/errors";
import { MEMORY_CATEGORIES, type MemoryCategory } from "../shared/types";
import { stableHash } from "../shared/utils";
import type { MemoryStore } from "../../store/store";
import type { MemoryTelemetryUsageOutbox } from "../telemetry/memory-telemetry-outbox";

export interface CliContext {
	store: MemoryStore;
	retriever: MemoryRetriever;
	embedder: Embedder;
	stateDir: string;
	usageOutbox?: MemoryTelemetryUsageOutbox;
}

export type ImportSpoolRow = {
	id: string;
	text: string;
	category: MemoryCategory;
	scope: string;
	importance: number;
	timestamp: string | undefined;
	metadata: Record<string, unknown>;
	vector: number[] | undefined;
	hash: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeImportSpoolRow(writer: Writable, row: ImportSpoolRow): Promise<void> {
	if (!writer.write(`${JSON.stringify(row)}\n`)) {
		await once(writer, "drain");
	}
}

export function createImportSpoolPath(filePath: string): string {
	const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
	return path.join(tmpdir(), `sno-station-mem-import-${process.pid}-${Date.now()}-${safeName}.jsonl`);
}

export function parseImportSpoolRow(line: string): ImportSpoolRow {
	const parsed = JSON.parse(line) as unknown;
	if (!isRecord(parsed)) {
		throw new SnoStationMemError("invalid_import_spool", "Internal import spool row was not an object.");
	}
	const category = parseCategory(typeof parsed.category === "string" ? parsed.category : undefined);
	if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || !category) {
		throw new SnoStationMemError(
			"invalid_import_spool",
			"Internal import spool row was missing required fields.",
		);
	}
	const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
	const vector = Array.isArray(parsed.vector) ? parsed.vector : undefined;
	if (vector && !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
		throw new SnoStationMemError(
			"invalid_import_spool",
			"Internal import spool row had an invalid vector.",
		);
	}
	return {
		id: parsed.id,
		text: parsed.text,
		category,
		scope: typeof parsed.scope === "string" ? parsed.scope : DEFAULT_SCOPE,
		importance: typeof parsed.importance === "number" ? parsed.importance : DEFAULT_IMPORTANCE,
		timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
		metadata,
		vector,
		hash: typeof parsed.hash === "string" ? parsed.hash : stableHash(parsed.text),
	};
}

/** Parses category into the normalized shape used by slash-command registration. */
export function parseCategory(value: string | undefined): MemoryCategory | undefined {
	if (!value) return undefined;
	if ((MEMORY_CATEGORIES as readonly string[]).includes(value)) {
		return value as MemoryCategory;
	}
	// Surface this invalid CLI handling state as an explicit typed failure.
	throw new SnoStationMemError("invalid_category", `Invalid category: ${value}`);
}

/** Implements serialize entry as the local slash-command registration operation. */
export function serializeEntry(entry: {
	id: string;
	text: string;
	category: string;
	projectId: string;
	importance: number;
	timestamp: number;
	metadata: string;
}): Record<string, unknown> {
	return {
		id: entry.id,
		text: entry.text,
		category: entry.category,
		scope: entry.projectId,
		importance: entry.importance,
		timestamp: new Date(entry.timestamp).toISOString(),
		metadata: safeParseMetadata(entry.metadata),
	};
}

/** Parses metadata defensively and returns a safe fallback on bad input. */
export function safeParseMetadata(raw: string): unknown {
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		return JSON.parse(raw);
	} catch {
		return { _invalidMetadata: raw };
	}
}

/** Implements confirm destructive action as the local slash-command registration operation. */
export async function confirmDestructiveAction(message: string): Promise<boolean> {
	const prompt = createPrompt({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (await prompt.question(message)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		prompt.close();
	}
}
