/** @file timezone-aware-temporal-resolution.test.ts
 * @purpose Proves timestamp and timezone remain one durable value across storage paths.
 * @boundary Real encrypted SQLite, real MemoryStore writers/readers, and real ONNX embeddings.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { calculateCalendarTime } from "../../../../packages/memory/src/engine/extraction/calendar-instruction";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import type { MemoryEntry } from "../../../../packages/memory/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const PROJECT_ID = "timezone-persistence-integration";
const FIRST_TIMESTAMP = Date.UTC(2026, 5, 5, 21, 0, 0);
const SECOND_TIMESTAMP = Date.UTC(2026, 5, 6, 9, 30, 0);
const SESSION_ANCHOR = "2026-06-05T21:00:00-07:00";
const SESSION_TIMEZONE = "America/Los_Angeles";

let embedder: Embedder;
let fixture: TestDb;
let store: MemoryStore;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
});

afterEach(() => {
	store.closeSync();
	fixture.cleanup();
});

function persistedPair(id: string): { timestamp: number; timezone: string } {
	const row = fixture.sqlite
		.prepare("SELECT timestamp, timezone FROM nodix_memories WHERE id = ?")
		.get(id) as { timestamp: number; timezone: string } | undefined;
	if (!row) throw new Error(`missing persisted memory ${id}`);
	return row;
}

function profileMetadata(text: string, timestamp: number): string {
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category: "profile", timestamp },
			{ section_name: "preferences.timezone-proof", tier: "core" },
		),
	);
}

function iso(value: number): string {
	return new Date(value).toISOString();
}

describe("calendar arithmetic with explicit timezone", () => {
	it("keeps the session calendar day when UTC is already tomorrow", () => {
		const result = calculateCalendarTime({ kind: "relative", amount: 0, unit: "day", precision: "day" }, SESSION_ANCHOR, SESSION_TIMEZONE);
		expect(result?.label).toBe("2026-06-05");
		expect(iso(result?.from ?? 0)).toBe("2026-06-05T07:00:00.000Z");
	});

	it("distinguishes a full day from an explicitly supplied midnight", () => {
		const day = calculateCalendarTime({ kind: "absolute", year: 2026, month: 6, day: 5, precision: "day" }, SESSION_ANCHOR, SESSION_TIMEZONE);
		const minute = calculateCalendarTime({ kind: "absolute", year: 2026, month: 6, day: 5, hour: 0, minute: 0, precision: "minute" }, SESSION_ANCHOR, SESSION_TIMEZONE);
		expect(day?.from).toBe(minute?.from);
		expect((day?.until ?? 0) - (day?.from ?? 0)).toBe(86_400_000);
		expect((minute?.until ?? 0) - (minute?.from ?? 0)).toBe(60_000);
	});

	it("uses the source offset when no separate session timezone was supplied", () => {
		const result = calculateCalendarTime({ kind: "relative", amount: 0, unit: "day", precision: "day" }, SESSION_ANCHOR);
		expect(result?.timezone).toBe("-07:00");
		expect(result?.label).toBe("2026-06-05");
	});

	it("does not replace a missing relative anchor with the current clock", () => {
		expect(calculateCalendarTime({ kind: "relative", amount: -1, unit: "day", precision: "day" })).toBeNull();
	});

	it("stores the calculated instant and timezone as one pair", async () => {
		const result = calculateCalendarTime({ kind: "relative", amount: 0, unit: "day", precision: "day" }, SESSION_ANCHOR, SESSION_TIMEZONE);
		if (!result) throw new Error("missing calendar result");
		const row = await store.store({ text: "The user walked 8,578 steps today.", category: "episodic", projectId: PROJECT_ID, timestamp: result.from, timezone: result.timezone });
		expect(persistedPair(row.id)).toEqual({ timestamp: Date.parse("2026-06-05T07:00:00Z"), timezone: SESSION_TIMEZONE });
	});
});

describe("timestamp and timezone persistence", () => {
	it("rejects a direct SQL insert that omits timezone because the column has no default", () => {
		expect(() =>
			fixture.sqlite
				.prepare(
					"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, metadata, content_hash) VALUES (?, ?, ?, 'episodic', ?, 0.7, ?, '{}', ?)",
				)
				.run(
					"timezone-omitted",
					"timezone-omitted",
					"This insert must fail.",
					PROJECT_ID,
					FIRST_TIMESTAMP,
					"timezone-omitted-hash",
				),
		).toThrow(/timezone|NOT NULL/u);
	});

	it.each(["UTC", "America/Los_Angeles"])(
		"uses the host IANA zone for a static row under %s",
		async (hostTimezone) => {
			const previousTimezone = process.env.TZ;
			process.env.TZ = hostTimezone;
			try {
				const created = await store.store({
					text: `Static memory created under ${hostTimezone}.`,
					category: "episodic",
					projectId: PROJECT_ID,
					timestamp: FIRST_TIMESTAMP,
				});
				expect(created.timezone).toBe(hostTimezone);
				expect(persistedPair(created.id).timezone).toBe(hostTimezone);
			} finally {
				if (previousTimezone === undefined) delete process.env.TZ;
				else process.env.TZ = previousTimezone;
			}
		},
	);

	it.each(["PDT", "UTC+8", "+24:00", "", "Mars/Olympus"])(
		"rejects an invalid timezone value %j before SQL",
		async (timezone) => {
			await expect(
				store.store({
					text: `Invalid timezone ${timezone || "empty"}.`,
					category: "episodic",
					projectId: PROJECT_ID,
					timestamp: FIRST_TIMESTAMP,
					timezone,
				}),
			).rejects.toThrow(/invalid memory timezone/u);
			expect(
				fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get(),
			).toEqual({ count: 0 });
		},
	);

	it("writes and returns an explicit user wall-clock carrier through ordinary reads", async () => {
		const created = await store.store({
			text: "The user walked 8,578 steps on the local calendar day.",
			category: "episodic",
			projectId: PROJECT_ID,
			timestamp: FIRST_TIMESTAMP,
			timezone: "user",
		});

		expect(created).toMatchObject({ timestamp: FIRST_TIMESTAMP, timezone: "user" });
		expect(persistedPair(created.id)).toEqual({
			timestamp: FIRST_TIMESTAMP,
			timezone: "user",
		});
		expect(store.getById(created.id)).toMatchObject({ timezone: "user" });
		expect(store.findByContentHash(created.contentHash, PROJECT_ID)).toMatchObject({
			timezone: "user",
		});
		expect(await store.list({ projectId: PROJECT_ID })).toEqual([
			expect.objectContaining({ id: created.id, timezone: "user" }),
		]);
		expect(await store.searchKeyword("walked steps", { projectIdFilter: [PROJECT_ID] })).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({ id: created.id, timezone: "user" }),
			}),
		]);
	});

	it("updates timestamp and timezone together during import upsert", async () => {
		const id = randomUUID();
		const base: MemoryEntry & { offlineFamily: true } = {
			id,
			factId: id,
			text: "Imported memory before timezone correction.",
			category: "episodic",
			projectId: PROJECT_ID,
			importance: 0.7,
			timestamp: FIRST_TIMESTAMP,
			timezone: "+09:00",
			metadata: "{}",
			contentHash: "recomputed-by-import",
			lane: "active",
			offlineFamily: true,
		};
		await store.importEntry(base);
		expect(persistedPair(id)).toEqual({ timestamp: FIRST_TIMESTAMP, timezone: "+09:00" });

		const updated = await store.importEntry({
			...base,
			text: "Imported memory after timezone correction.",
			timestamp: SECOND_TIMESTAMP,
			timezone: "-07:00",
		});
		expect(updated).toMatchObject({ timestamp: SECOND_TIMESTAMP, timezone: "-07:00" });
		expect(persistedPair(id)).toEqual({ timestamp: SECOND_TIMESTAMP, timezone: "-07:00" });
	});

	it("keeps the old profile pair and writes the replacement pair atomically", async () => {
		const oldText = "The user previously worked in Tokyo.";
		const oldRow = await store.store({
			text: oldText,
			category: "profile",
			projectId: PROJECT_ID,
			timestamp: FIRST_TIMESTAMP,
			timezone: "+09:00",
			metadata: profileMetadata(oldText, FIRST_TIMESTAMP),
			trusted: true,
		});
		const replacementText = "The user now works in Los Angeles.";
		const replacement = await store.supersede({
			create: {
				text: replacementText,
				category: "profile",
				projectId: PROJECT_ID,
				timestamp: SECOND_TIMESTAMP,
				timezone: "-07:00",
				metadata: profileMetadata(replacementText, SECOND_TIMESTAMP),
				trusted: true,
			},
			closes: [
				{
					id: oldRow.id,
					buildMetadata: () => oldRow.metadata,
				},
			],
		});

		expect(persistedPair(oldRow.id)).toEqual({
			timestamp: FIRST_TIMESTAMP,
			timezone: "+09:00",
		});
		expect(persistedPair(replacement.id)).toEqual({
			timestamp: SECOND_TIMESTAMP,
			timezone: "-07:00",
		});
	});

	it("preserves the pair through an in-place update and a REM full-row save", async () => {
		const created = await store.store({
			text: "The user preferred tea in the morning.",
			category: "episodic",
			projectId: PROJECT_ID,
			timestamp: FIRST_TIMESTAMP,
			timezone: "user",
		});
		await store.update(created.id, { importance: 0.9 });
		expect(persistedPair(created.id)).toEqual({
			timestamp: FIRST_TIMESTAMP,
			timezone: "user",
		});

		const remResult = await store.applyRemTextVersion({
			jobId: "timezone-rem-job",
			jobType: "rem-update",
			rowId: created.id,
			plannedContentHash: created.contentHash,
			replacementText: "The user now prefers coffee in the morning.",
			historyText: created.text,
			reason: "timezone pair preservation proof",
			timestamp: "2026-06-07T08:00:00.000Z",
		});
		expect(remResult).toMatchObject({ applied: true });
		expect(persistedPair(created.id)).toEqual({
			timestamp: FIRST_TIMESTAMP,
			timezone: "user",
		});
	});
});
