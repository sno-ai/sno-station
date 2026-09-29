/** Fresh correction successors and closure share one SQLite transaction. */
import { MemoryStore, type CorrectMemoryInput, type CorrectMemoryResult, type MemoryStoreInternals } from "./memory-store-base";
import { randomUUID, stableHash, type MemoryCategory } from "./memory-store-shared";
import { normalizeForCompare } from "../engine/shared/i18n-text";
import { deriveRemWriteIdentity } from "../engine/rem/index";
import { closeMemoryRow, readMemorySourceOrderOrOldest, type MemorySourceOrder } from "./memory-source-order";
import { checkMemoryOperation } from "../engine/operation-cancellation";

interface CorrectionRow {
	id: string;
	text: string;
	category: MemoryCategory;
	project_id: string;
	importance: number;
	timestamp: number;
	timezone: string;
	metadata: string;
	fact_id: string | null;
	lane: string;
	disposition_reason: string | null;
	subject: string | null;
	attribute: string | null;
	valid_from: number | null;
	valid_until: number | null;
}

function correctionTarget(store: MemoryStoreInternals, input: CorrectMemoryInput): CorrectionRow | undefined {
	return store.sqlite.prepare(`SELECT * FROM nodix_memories
		WHERE id = ? AND project_id IN (SELECT value FROM json_each(?))`)
		.get(input.id, JSON.stringify(input.projectIdFilter)) as CorrectionRow | undefined;
}

function refusal(store: MemoryStoreInternals, row: CorrectionRow | undefined): CorrectMemoryResult | undefined {
	if (!row) return { corrected: false, errorCode: "not-found" };
	const metadata = store.parseMetadataObject(row.metadata);
	if (typeof metadata.superseded_by === "string") {
		return { corrected: false, errorCode: "already-superseded", successorId: metadata.superseded_by };
	}
	if (row.lane !== "active" || row.disposition_reason !== null || metadata.invalidated_at != null
		|| metadata.active_task_kind !== undefined || metadata.memory_layer === "reflection"
		|| (typeof metadata.type === "string" && metadata.type.startsWith("memory-reflection"))) {
		return { corrected: false, errorCode: "invalid-input" };
	}
	return undefined;
}

function correctedMetadata(store: MemoryStoreInternals, row: CorrectionRow, input: CorrectMemoryInput, timestamp: number): Record<string, unknown> {
	const old = store.parseMetadataObject(row.metadata);
	const identity = Object.fromEntries(Object.entries(old).filter(([key]) =>
		["kind", "memory_category", "section_name", "fact_key", "canonical_id",
			"subject", "attribute", "tier", "confidence", "memory_layer"].includes(key)
		|| key.startsWith("entity_") || key.startsWith("category_")));
	const temporal = input.temporalMetadata ?? {};
	const newEvidence = typeof temporal.valid_from === "number" || typeof temporal.event_at === "number";
	const event = newEvidence ? {} : Object.fromEntries(["event_at", "valid_from", "valid_until"]
		.flatMap(key => old[key] === undefined ? [] : [[key, old[key]]]));
	return { ...identity, ...event, ...temporal,
		l0_abstract: input.content, l1_overview: input.content, l2_content: input.content,
		source: "manual", source_session: input.session, state: "active", asserted_at: timestamp,
		access_count: 0, injected_count: 0, bad_recall_count: 0, last_accessed_at: 0,
		suppressed_until_turn: 0 };
}

Object.assign(MemoryStore.prototype, {
	async correct(this: MemoryStoreInternals, input: CorrectMemoryInput): Promise<CorrectMemoryResult> {
		if (!input.id.trim() || !input.content.trim()) return { corrected: false, errorCode: "invalid-input" };
		const early = refusal(this, correctionTarget(this, input));
		if (early) return early;
		const id = randomUUID();
		const chunks = await this.prepareChunkInserts(id, input.content);
		return this.writeMutex.runExclusive(() => {
			checkMemoryOperation();
			return this.sqlite.transaction((): CorrectMemoryResult => {
				const row = correctionTarget(this, input);
				const refused = refusal(this, row);
				if (refused) return refused;
				if (!row) return { corrected: false, errorCode: "not-found" };
				const hash = stableHash(input.content);
				const normalized = normalizeForCompare(input.content);
				if (normalizeForCompare(row.text) === normalized) {
					return { corrected: false, errorCode: "invalid-input", duplicate: { id: row.id, state: "unchanged" } };
				}
				const peers = this.sqlite.prepare("SELECT id, text, content_hash, metadata FROM nodix_memories WHERE project_id = ? AND category = ?")
					.all(row.project_id, row.category) as Array<{ id: string; text: string; content_hash: string; metadata: string }>;
				const duplicate = peers.find(peer => peer.content_hash === hash || normalizeForCompare(peer.text) === normalized);
				if (duplicate) {
					const retired = typeof this.parseMetadataObject(duplicate.metadata).superseded_by === "string";
					return { corrected: false, errorCode: "invalid-input", duplicate: { id: duplicate.id, state: retired ? "retired" : "current" } };
				}
				const oldOrder = readMemorySourceOrderOrOldest(row.metadata);
				const timestamp = Math.max(Date.now(), (oldOrder.valid_from ?? oldOrder.session_moment ?? row.timestamp) + 1);
				const metadata = correctedMetadata(this, row, input, timestamp);
				const newEvent = typeof input.temporalMetadata?.valid_from === "number" || typeof input.temporalMetadata?.event_at === "number";
				const validFrom = typeof metadata.valid_from === "number" ? metadata.valid_from : newEvent ? null : row.valid_from;
				const validUntil = typeof metadata.valid_until === "number" ? metadata.valid_until : newEvent ? null : row.valid_until;
				this.sqlite.prepare(`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata,
					content_hash, fact_id, lane, subject, attribute, valid_from, valid_until,
					maturity, source, extractor_version
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'extracted', 'manual', 'memory-correction-v1')`)
					.run(id, input.content, row.category, row.project_id, row.importance, timestamp, row.timezone,
						JSON.stringify(metadata), hash, row.fact_id, row.subject, row.attribute, validFrom, validUntil);
				const inserted = this.sqlite.prepare("SELECT rowid FROM nodix_memories WHERE id = ?").get(id) as { rowid: number };
				const sessions = this.sqlite.prepare("SELECT COUNT(DISTINCT conversation_id) AS count FROM nodix_atomic_extraction_ledger").get() as { count: number };
				const order: MemorySourceOrder = { valid_from: null, session_moment: timestamp,
					session_ordinal: sessions.count, global_turn_index: 0, rowid: inserted.rowid,
					conversation_id: input.session, correction: true };
				metadata.source_order = order;
				this.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), id);
				this.sqlite.prepare("INSERT INTO nodix_rem_census_rows(row_id, write_identity_sha256) VALUES (?, ?)")
					.run(id, deriveRemWriteIdentity({ rowId: id, text: input.content, contentHash: hash, timestamp }));
				this.writeChunkRowsSync(chunks, row.project_id);
				this.telemetryEvents.writeReceiptEvent({ eventType: "create", factId: row.fact_id ?? id,
					memoryKind: row.category, projectId: row.project_id, contentHash: hash, timestampMs: timestamp,
					metadata: { operation_source: "correct" } });
				closeMemoryRow(this.sqlite, { targetRowId: row.id, closingRowId: id, closingOrder: order,
					closingValidFrom: timestamp, supersededAt: new Date(timestamp).toISOString() });
				if (row.category === "profile" || row.category === "state") {
					const closed = this.getById(row.id);
					const prior = this.parseMetadataObject(closed?.metadata ?? row.metadata);
					this.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
						.run(JSON.stringify({ ...prior, invalidated_at: Math.max(timestamp, row.valid_from ?? 0,
							typeof prior.valid_from === "number" ? prior.valid_from : 0) }), row.id);
				}
				return { corrected: true, id };
			}).immediate() as CorrectMemoryResult;
		});
	},
});
