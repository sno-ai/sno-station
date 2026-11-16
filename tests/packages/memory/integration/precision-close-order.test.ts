/** Existing close behavior over real encrypted SQLite; no future judgement symbols. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeMemoryRow } from "../../../../packages/memory/src/store/memory-source-order";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";

let database: ReturnType<typeof createTestDb>;
beforeEach(() => { database = createTestDb(); });
afterEach(() => { database?.cleanup(); });

function plant(id: string, validFrom: number, turn: number, rowid: number) {
	const order = { valid_from: validFrom, session_moment: 1794351600000,
		session_ordinal: 1, global_turn_index: turn, rowid, conversation_id: "close-order-session" };
	database.sqlite.prepare(`INSERT INTO nodix_memories
		(id, text, category, project_id, timestamp, metadata, content_hash, valid_from, timezone, fact_id)
		VALUES (?, ?, 'episodic', 'close-order', ?, ?, ?, ?, 'UTC', ?)`)
		.run(id, id, 1794351600000, JSON.stringify({ source_order: order }), id, validFrom, `fact-${id}`);
	return order;
}
function stored(id: string) {
	const row = database.sqlite.prepare("SELECT metadata, valid_until AS validUntil FROM nodix_memories WHERE id = ?")
		.get(id) as { metadata: string; validUntil: number | null };
	return { metadata: JSON.parse(row.metadata), validUntil: row.validUntil };
}

it("only the later turn of one session closes an equal-valid_from statement", () => {
	const earlier = plant("earlier-turn", 1794265200000, 1, 1);
	const later = plant("later-turn", 1794265200000, 2, 2);
	expect(() => closeMemoryRow(database.runtime.db, { targetRowId: "later-turn", closingRowId: "earlier-turn",
		closingOrder: earlier, closingValidFrom: 1794265200000, supersededAt: 1794351601000 }))
		.toThrow("Closing row source_order must be strictly greater than target source_order");
	expect(stored("later-turn")).toEqual({ metadata: { source_order: later }, validUntil: null });
	expect(closeMemoryRow(database.runtime.db, { targetRowId: "earlier-turn", closingRowId: "later-turn",
		closingOrder: later, closingValidFrom: 1794265200000, supersededAt: 1794351601000 })).toBe(true);
	expect(stored("earlier-turn")).toEqual({ metadata: { source_order: earlier,
		superseded_by: "later-turn", superseded_at: 1794351601000, superseded_valid_until: null }, validUntil: null });
	expect(stored("later-turn")).toEqual({ metadata: { source_order: later }, validUntil: null });
});

it("an older statement arriving late cannot close a newer row", () => {
	const newer = plant("newer-event", 1794351600000, 1, 1);
	const older = plant("late-older-event", 1794265200000, 9, 2);
	expect(() => closeMemoryRow(database.runtime.db, { targetRowId: "newer-event", closingRowId: "late-older-event",
		closingOrder: older, closingValidFrom: 1794265200000, supersededAt: 1794438000000 }))
		.toThrow("Closing row source_order must be strictly greater than target source_order");
	expect(stored("newer-event")).toEqual({ metadata: { source_order: newer }, validUntil: null });
	expect(stored("late-older-event")).toEqual({ metadata: { source_order: older }, validUntil: null });
});

it("a second closing row throws and preserves the first close mark", () => {
	const original = plant("original", 1794178800000, 1, 1);
	const first = plant("first-close", 1794265200000, 2, 2);
	const second = plant("second-close", 1794351600000, 3, 3);
	expect(closeMemoryRow(database.runtime.db, { targetRowId: "original", closingRowId: "first-close",
		closingOrder: first, closingValidFrom: 1794265200000, supersededAt: 1794351601000 })).toBe(true);
	expect(() => closeMemoryRow(database.runtime.db, { targetRowId: "original", closingRowId: "second-close",
		closingOrder: second, closingValidFrom: 1794351600000, supersededAt: 1794438000000 }))
		.toThrow("Memory row 'original' is already closed");
	expect(stored("original")).toEqual({ metadata: { source_order: original,
		superseded_by: "first-close", superseded_at: 1794351601000, superseded_valid_until: null }, validUntil: 1794265200000 });
	expect(stored("second-close")).toEqual({ metadata: { source_order: second }, validUntil: null });
});
