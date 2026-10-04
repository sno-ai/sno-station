// Retention never deletes an unsent row; over the byte cap only the oldest already-shipped rows go.
// Real better-sqlite3 against tmpdir; zero mocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/observability/dist/internal/buffer-store.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-"));
	return { dir, store: new BufferStore(join(dir, "buffer.db")) };
}

function appendRows(store, count) {
	store.append({
		eventId: "id-0",
		eventType: "agent.identify",
		lane: "memory",
		tsEdgeMs: 1,
		consentLevel: "metadata-only",
		redacted: false,
		scope,
		payload: validPayloads["agent.identify"],
		terminal: false,
	});
	for (let i = 1; i <= count; i += 1) {
		store.append({
			eventId: `mw-${i}`,
			eventType: "memory.write",
			lane: "memory",
			tsEdgeMs: 1000 + i,
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: validPayloads["memory.write"],
			terminal: false,
		});
	}
}

describe("buffer-store retention", () => {
	it("drops shipped rows after a day but never an unshipped one by age", () => {
		const { dir, store } = makeStore();
		try {
			appendRows(store, 2);
			store.markShipped(store.getByEventId("id-0").rowid);
			store.markShipped(store.getByEventId("mw-1").rowid);
			const report = store.pruneRetention(undefined, DAY_MS, Date.now() + 2 * DAY_MS);
			assert.equal(report.deletedEvents, 2);
			assert.equal(report.overflowDeleted, 0);
			assert.deepEqual(store.getAllRows().map((row) => row.event_id), ["mw-2"]);
			assert.equal(store.countShipped(), 2);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("over the byte cap never deletes an unsent row", () => {
		const { dir, store } = makeStore();
		try {
			appendRows(store, 300);
			const report = store.pruneRetention(64 * 1024, DAY_MS);
			assert.equal(report.overflowDeleted, 0);
			assert.equal(store.getAllRows().length, 301);
			assert.equal(store.countPending(), 301);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("over the byte cap drops the oldest already-shipped rows first and keeps every unsent one", () => {
		const { dir, store } = makeStore();
		try {
			appendRows(store, 300);
			const all = store.getAllRows();
			for (const row of all.slice(0, 200)) {
				store.markShipped(row.rowid);
			}
			const report = store.pruneRetention(64 * 1024, DAY_MS);
			assert.equal(report.overflowDeleted > 0, true);
			assert.equal(report.overflowDeleted <= 200, true);
			assert.equal(store.countPending(), 101);
			const remaining = store.getAllRows();
			assert.equal(remaining.length + report.overflowDeleted, 301);
			assert.equal(remaining.at(-1).event_id, "mw-300");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
