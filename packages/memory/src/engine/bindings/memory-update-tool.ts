/** @file memory-update-tool.ts
 * @purpose Registers the memory_update tool.
 * @boundary One host tool registration and its handler logic.
 */

import type { resolveAgentAccess } from "./memory-tool-access";
import type { MemoryCategory } from "./memory-tool-dependencies";
import { appendAuditEntry, clamp01, DEFAULT_LOCALE, deriveFactKey, normalizeCategory, StorageError, serializeIntervalMetadata, stripEnvelopeMetadata } from "./memory-tool-dependencies";
import { resolveMemoryDate } from "../extraction/date-resolution";
import { parseEntryMetadata } from "./memory-tool-formatting";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { type ToolContext, type ToolResult, updateParamsSchema } from "./memory-tool-schemas";

export async function executeMemoryUpdateTool(ctx: ToolContext, _access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					// Centralize the tool execution fallback value at the boundary of this helper.
					return runWithAudit(ctx, "memory_update", undefined, async () => {
						const parsed = updateParamsSchema.parse(params);
						const existing = ctx.store.getById(parsed.id);
						// Handle the absent-value case explicitly before the happy path depends on it.
						if (!existing) {
							return makeResult(`Memory entry not found: ${parsed.id}`, {}, true);
						}
						// Guard this branch early so the remaining tool execution path works with normalized inputs.
						const existingCategory = normalizeCategory(existing.category) ?? "episodic";

						const changes: {
							text?: string;
							vector?: Float32Array;
							category?: MemoryCategory;
							importance?: number;
							timestamp?: number;
							timezone?: string;
							metadata?: string;
							expectedMetadata?: string;
							writerAuthority?: "offline-family";
						} = { writerAuthority: "offline-family" };
						let strippedNewText: string | undefined;
						// Guard parsed.text here so the remaining tool execution path works with normalized inputs.
						if (parsed.text !== undefined) {
							// Strip envelope metadata before hashing, embedding, and
							// classification so store/update dedup semantics match.
							strippedNewText = stripEnvelopeMetadata(parsed.text);
							// Guard stripped new text.length here so the remaining tool execution path works with normalized inputs.
							if (strippedNewText.length !== parsed.text.length) {
								// Persist the decision breadcrumb so later debugging can reconstruct this path.
								appendAuditEntry(ctx.stateDir, {
									event: "envelope_strip",
									tool: "memory_update",
									resultStatus: "ok",
									decision: "stripped",
									details: {
										beforeChars: parsed.text.length,
										afterChars: strippedNewText.length,
									},
								});
							}
							// Guard stripped new text.trim here so the remaining tool execution path works with normalized inputs.
							if (!strippedNewText.trim()) {
								return makeResult("Skipped: updated text is purely envelope metadata.", {
									resultStatus: "skipped",
								});
							}
							// Round B-2: MemoryStore re-chunks + re-embeds when text changes.
							changes.text = strippedNewText;
						}
						const requestedCategory =
							parsed.category !== undefined
								? normalizeCategory(parsed.category)
								: undefined;
						if (requestedCategory !== undefined) changes.category = requestedCategory;
						// Guard parsed.importance here so the remaining tool execution path works with normalized inputs.
						if (parsed.importance !== undefined) {
							changes.importance = clamp01(parsed.importance, existing.importance);
						}
						if (parsed.timestamp !== undefined) {
							// The store moves timestamp and timezone as one; the moment keeps the row's zone.
							changes.timestamp = parsed.timestamp;
							changes.timezone = existing.timezone;
						}
						const effectiveCategory: MemoryCategory =
							requestedCategory ??
							existingCategory;
						if (parsed.metadata !== undefined || parsed.text !== undefined) {
							const nextMeta =
								parsed.metadata !== undefined
									? {
											...parseEntryMetadata(existing),
											...parsed.metadata,
										}
									: parseEntryMetadata(existing);

							// Rebuild deterministic temporal metadata when text changes. LLM
							// summary fields require InsightDistiller and are preserved here.
							// Explicit user metadata overrides the derived values.
							if (strippedNewText !== undefined) {
								const dateResolution = await resolveMemoryDate({
									text: strippedNewText,
									sessionTimestamp: ctx.sessionTimestamp,
									sessionTimezone: ctx.sessionTimezone,
									locale: ctx.language ?? DEFAULT_LOCALE,
									llm: ctx.profileToolLlm,
									routing: ctx.llmRouting,
								});
								const userProvidedTemporalType =
									parsed.metadata !== undefined && "memory_temporal_type" in parsed.metadata;
								const userProvidedTemporalStatus =
									parsed.metadata !== undefined && "temporal_resolution_status" in parsed.metadata;
								const userProvidedTemporalPhrase =
									parsed.metadata !== undefined && "temporal_phrase" in parsed.metadata;
								const userProvidedValidUntil =
									parsed.metadata !== undefined && "valid_until" in parsed.metadata;
								const userProvidedValidFrom =
									parsed.metadata !== undefined && "valid_from" in parsed.metadata;
								const userProvidedEventAt =
									parsed.metadata !== undefined && "event_at" in parsed.metadata;
								const temporalMetadata = serializeIntervalMetadata(
									effectiveCategory,
									dateResolution.interval,
								);
								for (const field of ["temporal_date", "temporal_precision", "temporal_timezone"] as const) {
									if (parsed.metadata !== undefined && field in parsed.metadata) continue;
									if (temporalMetadata[field] !== undefined) nextMeta[field] = temporalMetadata[field];
									else delete nextMeta[field];
								}
								if (!userProvidedTemporalType)
									nextMeta.memory_temporal_type = temporalMetadata.memory_temporal_type;
								if (!userProvidedTemporalStatus)
									nextMeta.temporal_resolution_status = temporalMetadata.temporal_resolution_status;
								if (!userProvidedTemporalPhrase) {
									if (temporalMetadata.temporal_phrase) {
										nextMeta.temporal_phrase = temporalMetadata.temporal_phrase;
									} else {
										delete nextMeta.temporal_phrase;
									}
								}
								if (!userProvidedValidUntil) {
									if (temporalMetadata.valid_until !== undefined) {
										nextMeta.valid_until = temporalMetadata.valid_until;
									} else {
										delete nextMeta.valid_until;
									}
								}
								if (!userProvidedValidFrom) {
									if (temporalMetadata.valid_from !== undefined) nextMeta.valid_from = temporalMetadata.valid_from;
									else delete nextMeta.valid_from;
								}
								if (!userProvidedEventAt) {
									if (temporalMetadata.event_at !== undefined) {
										nextMeta.event_at = temporalMetadata.event_at;
									} else {
										delete nextMeta.event_at;
									}
								}

								// PORT af079fd (#544): Truncation rebuild of L0/L1/L2 +
								// fact_key when text changes. We deliberately do NOT call
								// InsightDistiller here — that's the expensive ambient-learning
								// path the user opts into separately. Caller-supplied
								// metadata wins via the override gate below: parsed.metadata
								// has already been spread into nextMeta above (line 1212-1216),
								// so we only rebuild fields the caller has not explicitly set.
								const userProvidedL0 =
									parsed.metadata !== undefined && "l0_abstract" in parsed.metadata;
								const userProvidedL1 =
									parsed.metadata !== undefined && "l1_overview" in parsed.metadata;
								const userProvidedL2 =
									parsed.metadata !== undefined && "l2_content" in parsed.metadata;
								const userProvidedFactKey =
									parsed.metadata !== undefined && "fact_key" in parsed.metadata;

								if (!userProvidedL0) nextMeta.l0_abstract = strippedNewText;
								if (!userProvidedL1) nextMeta.l1_overview = `- ${strippedNewText}`;
								if (!userProvidedL2) nextMeta.l2_content = strippedNewText;
								if (!userProvidedFactKey) {
									const derivedFactKey = deriveFactKey({
										kind: effectiveCategory,
										section_name: nextMeta.section_name,
										anti_pattern_signature: nextMeta.anti_pattern_signature,
									});
									if (derivedFactKey) {
										nextMeta.fact_key = derivedFactKey;
									} else {
										delete nextMeta.fact_key;
									}
								}
							}

							// PORT af079fd (#544): Sync confidence whenever the metadata-
							// rebuild path owns changes.metadata AND importance is supplied.
							// Covers text-change+importance, preference-category transition+
							// importance, and caller-supplied metadata+importance with
							// unrelated fields. Without this, that last case would write
							// changes.importance to the row but leave metadata.confidence stale.
							const userProvidedConfidence =
								parsed.metadata !== undefined && "confidence" in parsed.metadata;
							if (parsed.importance !== undefined && !userProvidedConfidence) {
								nextMeta.confidence = clamp01(parsed.importance, existing.importance);
							}

							// Serialize metadata once at the boundary so storage receives a stable payload.
							changes.metadata = JSON.stringify(nextMeta);
							changes.expectedMetadata = existing.metadata;
						}

						// PORT af079fd (#544): Sync confidence on importance-only updates.
						// The metadata-rebuild block above only fires when text or
						// metadata changes, so a pure importance update would
						// otherwise leave metadata.confidence stale.
						if (
							parsed.importance !== undefined &&
							parsed.text === undefined &&
							parsed.metadata === undefined
						) {
							const meta = parseEntryMetadata(existing);
							meta.confidence = clamp01(parsed.importance, existing.importance);
							changes.metadata = JSON.stringify(meta);
							changes.expectedMetadata = existing.metadata;
						}

						const updated = await ctx.store.update(parsed.id, changes);
						// Guard updated here so the remaining tool execution path works with normalized inputs.
						if (!updated) {
							// Surface this invalid tool execution state as an explicit typed failure.
							throw new StorageError(`Failed to update memory: ${parsed.id}`);
						}
						// Centralize the tool execution fallback value at the boundary of this helper.
						return makeResult(`Updated memory: ${parsed.id}`, {
							id: updated.id,
						});
					});
				}
