import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("sno-station-mem:reflection-mapped-memory-loop");
/** @file reflection-mapped-memory-loop.ts
 * @purpose Stores mapped reflection bullets as semantic memories.
 */

import type { createEmbedder } from "../extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../extraction/memory-metadata-codec";
import {
	createRetireByNameRunBudget,
	runProfileSectionUpdate,
} from "../extraction/profile-section-writer";
import {
	buildReflectionAntiPatternSignature,
	buildReflectionMappedMetadata,
	type ReflectionMappedKind,
} from "./mapped-memory-metadata-builder";
import type { LlmClient } from "../../model/llm-client";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";
import { extractInjectableReflectionMappedMemoryItems } from "./markdown-slice-parser";
import type { MemoryCategory } from "../shared/types";
import type { MemoryStore } from "../../store/store";

const MAX_MAPPED_ENTRIES = 100;
const MAPPED_DEDUP_THRESHOLD = 0.95;

export interface ReflectionLogger {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	debug?: (msg: string) => void;
}

interface PendingEntry {
	text: string;
	category: MemoryCategory;
	offlineFamily: true;
	projectId: string;
	importance: number;
	metadata: string;
	timestamp: number;
}

interface PendingEntryWithVector {
	entry: PendingEntry;
	vector: Float32Array;
	category: MemoryCategory;
	mappedKind: ReflectionMappedKind;
}

interface PendingVector {
	vector: Float32Array;
	category: MemoryCategory;
	mappedKind: ReflectionMappedKind;
}

/**
 * Cosine similarity. Falls back to the raw dot product when either operand
 * has zero norm — that is a degenerate, fail-open path so a model that
 * returns an all-zero vector cannot crash the batch dedup scan.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const length = Math.min(a.length, b.length);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i += 1) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return dot;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RunMappedMemoryLoopParams {
	reflectionText: string;
	store: MemoryStore;
	embedder: ReturnType<typeof createEmbedder>;
	llm: LlmClient;
	routing?: LlmRoutingConfig;
	targetScope: string;
	sourceAgentId: string;
	sessionKey: string;
	sessionId: string;
	runAt: number;
	usedFallback: boolean;
	toolErrorSignals: Array<{ signatureHash: string }>;
	eventId: string;
	logger: ReflectionLogger;
}

export async function runMappedMemoryLoop(params: RunMappedMemoryLoopParams): Promise<void> {
	const allMapped = extractInjectableReflectionMappedMemoryItems(params.reflectionText);
	const seen = new Map<string, (typeof allMapped)[number]>();
	for (const m of allMapped) {
		const k = JSON.stringify([m.category, m.heading, m.text]);
		if (!seen.has(k)) seen.set(k, m);
	}
	const deduped = [...seen.values()];
	if (deduped.length < allMapped.length) {
		diagnosticLog.info("Reflection duplicate input removed", { input_count: allMapped.length, output_count: deduped.length }, { event_name: "memory.reflection_mapped_memory_loop.reflection.duplicate.input.removed", file: "packages/sno-station-mem/src/engine/reflection/reflection-mapped-memory-loop.ts", function: "runMappedMemoryLoop", site_id: "reflection.reflection-mapped-memory-loop.runMappedMemoryLoop.d4cb1a8408" });
	}

	if (deduped.length > MAX_MAPPED_ENTRIES) {
		diagnosticLog.warn("Reflection input count limited", { input_count: deduped.length, limit: MAX_MAPPED_ENTRIES }, { event_name: "memory.reflection_mapped_memory_loop.reflection.input.count.limited", file: "packages/sno-station-mem/src/engine/reflection/reflection-mapped-memory-loop.ts", function: "runMappedMemoryLoop", site_id: "reflection.reflection-mapped-memory-loop.runMappedMemoryLoop.4f891b1d21" });
	}
	const mapped = deduped.slice(0, MAX_MAPPED_ENTRIES);
	if (mapped.length === 0) return;

	const pending: PendingEntryWithVector[] = [];
	const pendingVectors: PendingVector[] = [];
	const retireByNameBudget = createRetireByNameRunBudget();

	for (const m of mapped) {
		try {
			const probeVector = await params.embedder.embed(m.text);
			const existing = await params.store.searchSemantic(probeVector, {
				limit: 8,
				minScore: 0.1,
				projectIdFilter: [params.targetScope],
				category: m.category,
			});
			const dup = existing.find((hit) => {
				if (hit.score <= MAPPED_DEDUP_THRESHOLD) return false;
				let hitKind: string | undefined;
				try {
					const meta = JSON.parse(hit.entry.metadata ?? "{}") as {
						mappedKind?: unknown;
					};
					hitKind = typeof meta.mappedKind === "string" ? meta.mappedKind : undefined;
				} catch {
					hitKind = undefined;
				}
				if (hitKind !== undefined && hitKind !== m.mappedKind) return false;
				return true;
			});
			if (dup) continue;

			// In-batch near-duplicate guard. bulkStore's own dedup is content-hash
			// only, so two paraphrased items that DB dedup did not catch (neither
			// exists yet) would otherwise both land as separate rows. Scan every
			// prior pending vector, not just the most recent — a paraphrase pair
			// may straddle an unrelated entry.
			//
			// Scope by both `category` and `mappedKind` to mirror the DB pre-check
			// above (searchSemantic filters by category; the `.find()` predicate
			// rejects mismatched mappedKind). Without this scoping, an `error`
			// paraphrase could suppress a distinct `decision` candidate and cause
			// silent memory loss.
			let skipped = false;
			for (const prior of pendingVectors) {
				if (prior.category !== m.category) continue;
				if (prior.mappedKind !== m.mappedKind) continue;
				const cosine = cosineSimilarity(probeVector, prior.vector);
				if (cosine >= MAPPED_DEDUP_THRESHOLD) {
					// Reflection bullets are user content; do not surface raw text
					// (even truncated) in logs. Emit only non-reversible diagnostics.
					diagnosticLog.debug("Reflection duplicate candidate skipped", { cosine, category: m.category, mapped_kind: m.mappedKind, input_size: m.text.length }, { event_name: "memory.reflection_mapped_memory_loop.reflection.duplicate.candidate.skipped", file: "packages/sno-station-mem/src/engine/reflection/reflection-mapped-memory-loop.ts", function: "runMappedMemoryLoop", site_id: "reflection.reflection-mapped-memory-loop.runMappedMemoryLoop.78a7536d17" });
					skipped = true;
					break;
				}
			}
			if (skipped) continue;

			const importance = m.mappedKind === "decision" ? 0.85 : 0.8;
			const baseMetadata = buildReflectionMappedMetadata({
				mappedItem: m,
				eventId: params.eventId,
				agentId: params.sourceAgentId,
				sessionKey: params.sessionKey,
				sessionId: params.sessionId,
				runAt: params.runAt,
				usedFallback: params.usedFallback,
				toolErrorSignals: params.toolErrorSignals,
			});
			const metadataPatch = {
				...baseMetadata,
				_reflectionHeading: m.heading,
			};
			if (m.category === "profile") {
				await runProfileSectionUpdate({
					scope: params.targetScope,
					sectionName: "preferences.general",
					newAssertion: m.text,
					evidence: m.text,
					source: {
						sessionKey: params.sessionKey,
						source: "reflection",
					},
					metadataPatch,
					store: params.store,
					llm: params.llm,
					...(params.routing ? { routing: params.routing } : {}),
					at: params.runAt,
					retireByNameBudget,
				});
				pendingVectors.push({
					vector: probeVector,
					category: m.category,
					mappedKind: m.mappedKind,
				});
				continue;
			}
			const metadata = buildInsightMetadata(
				{ text: m.text, category: m.category, timestamp: params.runAt },
				{
					...metadataPatch,
					...(m.category === "lesson"
						? {
								anti_pattern_signature: buildReflectionAntiPatternSignature(
									m.mappedKind,
									m.text,
								),
							}
						: {}),
				},
			);
			pending.push({
				entry: {
					text: m.text,
					category: m.category,
					offlineFamily: true,
					projectId: params.targetScope,
					importance,
					metadata: stringifyInsightMetadata(metadata),
					// Anchor each mapped row to the reflection run time. Without
					// it bulkStore's persistence falls back to a per-row
					// `Date.now()`, scattering siblings across ms-level drift.
					timestamp: params.runAt,
				},
				vector: probeVector,
				category: m.category,
				mappedKind: m.mappedKind,
			});
			pendingVectors.push({
				vector: probeVector,
				category: m.category,
				mappedKind: m.mappedKind,
			});
		} catch (err) {
			diagnosticLog.warn("Reflection candidate failed", { error: err }, { event_name: "memory.reflection_mapped_memory_loop.reflection.candidate.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-mapped-memory-loop.ts", function: "runMappedMemoryLoop", site_id: "reflection.reflection-mapped-memory-loop.runMappedMemoryLoop.38fe983443" });
		}
	}

	if (pending.length === 0) return;
	const entries = pending.map((p) => p.entry);
	try {
		await params.store.bulkStore(entries);
	} catch (err) {
		diagnosticLog.warn("Reflection batch write failed", { error: err, input_count: entries.length, committed_count: 0 }, { event_name: "memory.reflection_mapped_memory_loop.reflection.batch.write.failed", file: "packages/sno-station-mem/src/engine/reflection/reflection-mapped-memory-loop.ts", function: "runMappedMemoryLoop", site_id: "reflection.reflection-mapped-memory-loop.runMappedMemoryLoop.b692a46de7" });
	}
}

export function governanceEntryType(area: string | undefined): "learning" | "error" | "feature" {
	const a = area?.trim().toLowerCase() ?? "";
	if (a === "error" || a === "errors" || a.includes("err")) return "error";
	if (a === "feature" || a === "features" || a.includes("feat")) return "feature";
	return "learning";
}
