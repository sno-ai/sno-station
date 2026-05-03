// Retention pruner unit tests per tasks §22.4 / §22.6.
// Real better-sqlite3 against tmpdir; zero mocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { scope, validPayloads } from "../fixtures/temp-env.mjs";

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-retention-"));
	const store = new BufferStore(join(dir, "buffer.db"));
	return { dir, store };
}

describe("buffer-store retention pruner", () => {
	it("removes oldest shipped rows when total > maxBytes (22.4)", () => {
		const { dir, store } = makeStore();
		try {
			// Seed identify (seq=0) then a bunch of memory.write rows.
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
			for (let i = 1; i <= 30; i += 1) {
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
			const rows = store.getAllRows();
			// Mark all shipped so the pruner can act on them.
			for (const row of rows) {
				store.markShipped(row.rowid);
			}
			// With a tiny maxBytes ceiling, the pruner SHALL drop oldest shipped rows.
			const pruned = store.pruneRetention(
				/* maxBytes */ 1,
				/* maxAgeMs */ 24 * 60 * 60 * 1000,
			);
			assert.equal(pruned > 0, true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses to remove unshipped rows even when over cap (22.6)", () => {
		const { dir, store } = makeStore();
		try {
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
			for (let i = 1; i <= 20; i += 1) {
				store.append({
					eventId: `unshipped-${i}`,
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
			const before = store.getAllRows().length;
			// Even with a tiny maxBytes, unshipped rows MUST survive.
			const pruned = store.pruneRetention(/* maxBytes */ 1, /* maxAgeMs */ 1);
			assert.equal(pruned, 0);
			const after = store.getAllRows().length;
			assert.equal(after, before);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes terminal rows when total > maxBytes", () => {
		const { dir, store } = makeStore();
		try {
			store.append({
				eventId: "id-0",
				eventType: "agent.identify",
				lane: "memory",
				tsEdgeMs: 1,
				consentLevel: "off",
				redacted: true,
				scope,
				payload: validPayloads["agent.identify"],
				terminal: true,
			});
			for (let i = 1; i <= 20; i += 1) {
				store.append({
					eventId: `terminal-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "off",
					redacted: true,
					scope,
					payload: validPayloads["memory.write"],
					terminal: true,
				});
			}

			const pruned = store.pruneRetention(
				/* maxBytes */ 1,
				/* maxAgeMs */ 24 * 60 * 60 * 1000,
			);

			assert.equal(pruned > 0, true);
			assert.equal(
				store.getAllRows().every((row) => row.terminal === 1),
				true,
			);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes shipped rows older than maxAgeMs", () => {
		const { dir, store } = makeStore();
		try {
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
			const second = store.append({
				eventId: "mw-1",
				eventType: "memory.write",
				lane: "memory",
				tsEdgeMs: 2,
				consentLevel: "metadata-only",
				redacted: false,
				scope,
				payload: validPayloads["memory.write"],
				terminal: false,
			});
			store.markShipped(second.rowid);
			// Pretend "now" is 25h after creation. Default 24h horizon.
			const pruned = store.pruneRetention(
				Number.MAX_SAFE_INTEGER,
				24 * 60 * 60 * 1000,
				Date.now() + 25 * 60 * 60 * 1000,
			);
			assert.equal(pruned >= 1, true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps quarantine rows independently from shipped-event retention", () => {
		const { dir, store } = makeStore();
		try {
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
			for (let i = 1; i <= 5; i += 1) {
				const appended = store.append({
					eventId: `bad-${i}`,
					eventType: "memory.write",
					lane: "memory",
					tsEdgeMs: 1000 + i,
					consentLevel: "metadata-only",
					redacted: false,
					scope,
					payload: validPayloads["memory.write"],
					terminal: false,
				});
				const row = store
					.getPending()
					.find((pending) => pending.rowid === appended.rowid);
				assert.ok(row);
				store.quarantine(row, 400, "invalid");
			}

			const pruned = store.pruneQuarantine(2, Number.MAX_SAFE_INTEGER);

			assert.equal(pruned, 3);
			assert.equal(store.countQuarantined(), 2);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
