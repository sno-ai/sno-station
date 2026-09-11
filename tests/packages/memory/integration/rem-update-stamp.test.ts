/** @file rem-update-stamp.test.ts
 * @purpose Freezes source-derived REM update stamps and old job-keyed stamp migration.
 * @boundary Canonical five-field stamp input and the real encrypted MemoryStore startup migration.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { deriveRemUpdateStamp } from "../../../../packages/sno-station-mem/src/store/memory-store-rem-api.ts";
import type { RemUpdateRewriteConfig } from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

interface StampInput {
	source: string;
	implementationVersion: string;
	memoryKind: "profile" | "episodic";
	locale: string;
	localeResource: RemUpdateRewriteConfig["localeResource"];
}

type StampModule = {
	deriveRemUpdateStamp?: (input: StampInput) => string;
};

const BASE_INPUT: StampInput = {
	source: "The researcher moved from tea to coffee.",
	implementationVersion: "rem-update-v1",
	memoryKind: "episodic",
	locale: "en",
	localeResource: {
		valuePrefix: "Current preference: ",
		listPrefix: "Current items: ",
		listSeparator: ", ",
		spanSeparator: " ",
		anchorMode: "capitalized-sequence",
	},
};

let embedder: Embedder;
let fixture: TestDb | undefined;
let store: MemoryStore | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.close();
	fixture?.cleanup();
	store = undefined;
	fixture = undefined;
});

describe("ACC-23 source-derived REM update stamp", () => {
	it("refuses by name when rewriting a duplicate row onto text another row already holds", async () => {
		// Two legacy rows hold the same sentence under two planted hashes — the shape the
		// 2026-08-29 store census found 10 times, from the era when `content_hash` was derived
		// from `idempotency_key` and the text never entered it. Rewriting both to one
		// replacement would need one project to hold that text twice, which the UNIQUE index on
		// (project_id, content_hash, category) forbids. The first rewrite lands; the second is
		// refused loudly and names the row it collides with, and neither row is silently
		// collapsed or lost.
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const source = BASE_INPUT.source;
		const replacement = "The researcher now prefers coffee.";
		const stamp = deriveRemUpdateStamp(BASE_INPUT);
		const outcomes: string[] = [];
		for (const [rowId, contentHash] of [
			["duplicate-source-a", "a".repeat(64)],
			["duplicate-source-b", "b".repeat(64)],
		] as const) {
			fixture.runtime.db
				.prepare(
					`INSERT INTO nodix_memories(
						id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
					) VALUES (?, ?, 'episodic', 'persona:duplicate-source', 0.7, ?, 'UTC', ?, ?, ?)`,
				)
				.run(
					rowId,
					source,
					Date.parse("2026-08-08T12:00:00.000Z"),
					JSON.stringify({ idempotency_key: `extract:${rowId}` }),
					contentHash,
					`fact-${rowId}`,
				);
			try {
				const result = await store.applyRemTextVersion({
					rowId,
					jobId: "test-job",
					jobType: "rem-update",
					plannedContentHash: contentHash,
					replacementText: replacement,
					historyText: source,
					idempotencyKey: stamp,
					reason: "duplicate source rewrite",
					timestamp: "2026-08-08T12:01:00.000Z",
				});
				outcomes.push(`${rowId}: applied=${String(result.applied)}`);
			} catch (error) {
				outcomes.push(`${rowId}: refused ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const line of outcomes) console.log(`[duplicate rewrite] ${line}`);

		expect(outcomes[0]).toBe("duplicate-source-a: applied=true");
		expect(outcomes[1]).toContain("collides with memory duplicate-source-a");
		const rows = fixture.runtime.db
			.prepare(
				"SELECT id, text, content_hash AS contentHash FROM nodix_memories WHERE project_id = 'persona:duplicate-source' ORDER BY id",
			)
			.all() as Array<{ id: string; text: string; contentHash: string }>;
		for (const row of rows) {
			console.log(`  ${row.id} hash=${row.contentHash.slice(0, 12)} text=${JSON.stringify(row.text)}`);
		}
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.contentHash)).size).toBe(2);
		const stamped = fixture.runtime.db
			.prepare(
				"SELECT metadata FROM nodix_memories WHERE id = 'duplicate-source-a'",
			)
			.get() as { metadata: string };
		expect(JSON.parse(stamped.metadata)["rem_update_result_text_sha256"]).toBe(
			createHash("sha256").update(replacement).digest("hex"),
		);
	});

	it("rejects blank or reused idempotency keys for different text", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const rowId = "idempotency-conflict";
		const source = BASE_INPUT.source;
		fixture.runtime.db
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
				) VALUES (?, ?, 'episodic', 'persona:idempotency', 0.7, ?, 'UTC', '{}', ?, ?)`,
			)
			.run(
				rowId,
				source,
				Date.parse("2026-08-08T12:00:00.000Z"),
				"c".repeat(64),
				"fact-idempotency-conflict",
			);
		const baseWrite = {
			rowId,
			jobId: "test-job",
			jobType: "rem-update" as const,
			plannedContentHash: "c".repeat(64),
			replacementText: "The researcher now prefers coffee.",
			historyText: source,
			reason: "idempotency contract",
			timestamp: "2026-08-08T12:01:00.000Z",
		};
		await expect(store.applyRemTextVersion({ ...baseWrite, idempotencyKey: " " })).rejects.toThrow(
			/non-empty/u,
		);
		const first = await store.applyRemTextVersion({ ...baseWrite, idempotencyKey: "stable-key" });
		expect(first).toMatchObject({ applied: true });
		if (!first.applied) throw new Error(first.reason);
		await expect(
			store.applyRemTextVersion({
				...baseWrite,
				plannedContentHash: first.contentHash,
				replacementText: "The researcher now prefers espresso.",
				idempotencyKey: "stable-key",
			}),
		).rejects.toThrow(/conflicts with different replacement text/u);
	});

	it("changes when any canonical source or rewrite-configuration field changes", async () => {
		const stampModule = (await import("../../../../packages/sno-station-mem/src/store/memory-store-rem-api.ts")) as StampModule;
		expect(stampModule.deriveRemUpdateStamp).toBeTypeOf("function");
		const derive = stampModule.deriveRemUpdateStamp;
		if (!derive) return;

		const stamps = [
			derive(BASE_INPUT),
			derive({ ...BASE_INPUT, source: `${BASE_INPUT.source} Updated.` }),
			derive({ ...BASE_INPUT, implementationVersion: "rem-update-v2" }),
			derive({ ...BASE_INPUT, memoryKind: "profile" }),
			derive({ ...BASE_INPUT, locale: "zh" }),
			derive({
				...BASE_INPUT,
				localeResource: { ...BASE_INPUT.localeResource, valuePrefix: "Current: " },
			}),
		];

		expect(new Set(stamps).size).toBe(stamps.length);
		expect(stamps.every((stamp) => /^[a-f0-9]{64}$/u.test(stamp))).toBe(true);
	});

	it("migrates an old job-keyed stamp without rewriting row text", () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		store.close();
		store = undefined;

		const rowId = "row-old-job-stamp";
		const source = BASE_INPUT.source;
		fixture.runtime.db
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
				) VALUES (?, ?, 'episodic', 'persona:stamp-migration', 0.7, ?, 'UTC', ?, ?, ?)`,
			)
			.run(
				rowId,
				source,
				Date.parse("2026-08-08T12:00:00.000Z"),
				JSON.stringify({ rem_update_idempotency_key: `old-job:${rowId}` }),
				"a".repeat(64),
				"fact-old-job-stamp",
			);

		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const migrated = fixture.runtime.db
			.prepare("SELECT text, metadata FROM nodix_memories WHERE id = ?")
			.get(rowId) as { text: string; metadata: string };
		const metadata = JSON.parse(migrated.metadata) as Record<string, unknown>;
		const rewriteConfig = metadata["rem_update_rewrite_config"] as Omit<StampInput, "source">;
		const expectedStamp = deriveRemUpdateStamp({ source, ...rewriteConfig });

		expect(migrated.text).toBe(source);
		expect(metadata["rem_update_idempotency_key"]).not.toBe(`old-job:${rowId}`);
		expect(metadata).toMatchObject({
			rem_update_source_version: source,
			rem_update_idempotency_key: expectedStamp,
			rem_update_result_text_sha256: createHash("sha256").update(source).digest("hex"),
		});
	});
});
