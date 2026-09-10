/** @file timezone-aware-temporal-resolution.test.ts
 * @purpose Proves timestamp and timezone remain one durable value across storage paths.
 * @boundary Real encrypted SQLite, real MemoryStore writers/readers, and real ONNX embeddings.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { resolveDateLocally } from "../../../../packages/sno-station-mem/src/engine/extraction/date-resolution";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec";
import type { MemoryEntry } from "../../../../packages/sno-station-mem/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
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

describe("timezone-aware temporal resolution", () => {
	it("keeps today on the session wall-clock date without converting it to UTC", () => {
		const resolved = resolveDateLocally({
			text: "The user walked 8,578 steps today.",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});

		expect(resolved.needsModel).toBe(false);
		expect(resolved.result).toMatchObject({
			timezone: "user",
			stage: { selectedParser: "en", ambiguityGateFired: false, modelCalled: false },
			interval: { type: "bounded", resolutionStatus: "resolved" },
		});
		if (resolved.result.interval.type !== "bounded") {
			throw new Error("today must resolve to a bounded day");
		}
		expect(iso(resolved.result.interval.from)).toBe("2026-06-05T00:00:00.000Z");
		expect(iso(resolved.result.interval.until)).toBe("2026-06-06T00:00:00.000Z");
	});

	it("stores a source-named PDT time as an instant with its fixed offset", () => {
		const resolved = resolveDateLocally({
			text: "The deploy ran 2026-06-04 15:00 PDT.",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});

		expect(resolved.result).toMatchObject({
			timezone: "-07:00",
			stage: { selectionReason: "tie-agreed", winningScore: 7 },
			interval: { type: "instant", resolutionStatus: "resolved" },
		});
		if (resolved.result.interval.type !== "instant") {
			throw new Error("source-named exact time must resolve to an instant");
		}
		expect(iso(resolved.result.interval.at)).toBe("2026-06-04T22:00:00.000Z");
	});

	it("distinguishes a date-only value from exact midnight", () => {
		const dateOnly = resolveDateLocally({
			text: "2026-06-05",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});
		const midnight = resolveDateLocally({
			text: "2026-06-05 at midnight",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});

		expect(dateOnly.result.interval.type).toBe("bounded");
		expect(midnight.result.interval.type).toBe("instant");
		expect(dateOnly.result.timestamp).toBe(midnight.result.timestamp);
		expect(dateOnly.result.timezone).toBe("user");
		expect(midnight.result.timezone).toBe("user");
	});

	it("uses the configured locale only to settle a disagreeing local-first tie", () => {
		const english = resolveDateLocally({
			text: "03/04/2026",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});
		const spanish = resolveDateLocally({
			text: "03/04/2026",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "es",
			localFirst: true,
		});

		expect(english.result.stage).toMatchObject({
			selectedParser: "en",
			selectionReason: "locale-tiebreak",
		});
		expect(spanish.result.stage).toMatchObject({
			selectedParser: "es",
			selectionReason: "locale-tiebreak",
		});
		expect(iso(english.result.timestamp ?? 0).slice(0, 10)).toBe("2026-03-04");
		expect(iso(spanish.result.timestamp ?? 0).slice(0, 10)).toBe("2026-04-03");
	});

	it("keeps an ambiguous hour as a full-day partial while requesting model help", () => {
		const resolved = resolveDateLocally({
			text: "yesterday at 3",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: false,
		});

		expect(resolved.needsModel).toBe(true);
		expect(resolved.partial).toBeDefined();
		expect(resolved.result).toMatchObject({
			timezone: "user",
			stage: { ambiguityGateFired: true },
			interval: { type: "bounded", resolutionStatus: "resolved" },
		});
	});

	it("separates static text from a named expression that nothing resolves", () => {
		const staticText = resolveDateLocally({
			text: "The user likes quiet workspaces.",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
		});
		const unresolved = resolveDateLocally({
			text: "The event happened on glorpday.",
			expression: "glorpday",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
		});

		expect(staticText.needsModel).toBe(false);
		expect(staticText.result).toMatchObject({
			timezone: SESSION_TIMEZONE,
			interval: { type: "static", resolutionStatus: "static" },
		});
		expect(unresolved.needsModel).toBe(true);
		expect(unresolved.result).toMatchObject({
			timezone: SESSION_TIMEZONE,
			interval: { type: "unresolved", resolutionStatus: "unresolved", phrase: "glorpday" },
		});
	});

	it("uses the Korean phrase table after every parser misses regardless of configured locale", () => {
		const resolved = resolveDateLocally({
			text: "모레 배포를 확인해.",
			sessionDateTime: SESSION_ANCHOR,
			sessionTimezone: SESSION_TIMEZONE,
			locale: "en",
			localFirst: true,
		});

		expect(resolved.needsModel).toBe(false);
		expect(resolved.result).toMatchObject({
			timezone: "user",
			stage: {
				selectedParser: "ko-table",
				selectionReason: "korean-anchor",
			},
			interval: {
				type: "bounded",
				resolutionStatus: "resolved",
				from: Date.parse("2026-06-07T00:00:00.000Z"),
			},
		});
	});

	it.each([
		["오늘", "today", "bounded", "2026-06-05T00:00:00.000Z"],
		["어제", "yesterday", "bounded", "2026-06-04T00:00:00.000Z"],
		["내일", "tomorrow", "bounded", "2026-06-06T00:00:00.000Z"],
		["모레", "day_after_tomorrow", "bounded", "2026-06-07T00:00:00.000Z"],
		["이번 주", "this_week", "bounded", "2026-06-01T00:00:00.000Z"],
		["다음 주", "next_week", "bounded", "2026-06-08T00:00:00.000Z"],
		["지난 주", "last_week", "bounded", "2026-05-25T00:00:00.000Z"],
		["이번 달", "this_month", "bounded", "2026-06-01T00:00:00.000Z"],
		["다음 달", "next_month", "bounded", "2026-07-01T00:00:00.000Z"],
		["오늘 밤", "tonight", "bounded", "2026-06-05T18:00:00.000Z"],
		["오늘 아침", "this_morning", "bounded", "2026-06-05T00:00:00.000Z"],
		["최근", "recent", "ongoing", "2026-05-22T21:00:00.000Z"],
	] as const)(
		"resolves Korean %s with the shared Temporal %s anchor",
		(phrase, _anchor, intervalType, expectedFrom) => {
			const resolved = resolveDateLocally({
				text: phrase,
				sessionDateTime: SESSION_ANCHOR,
				sessionTimezone: SESSION_TIMEZONE,
				locale: "ko",
				localFirst: true,
			});
			expect(resolved.needsModel).toBe(false);
			expect(resolved.result).toMatchObject({
				timezone: "user",
				stage: { selectedParser: "ko-table", selectionReason: "korean-anchor" },
				interval: { type: intervalType, resolutionStatus: "resolved" },
			});
			const interval = resolved.result.interval;
			if (interval.type !== "bounded" && interval.type !== "ongoing") {
				throw new Error("Korean anchor must resolve to a range");
			}
			expect(iso(interval.from)).toBe(expectedFrom);
		},
	);
});

/**
 * The ordinary case, and the one nothing covered until 2026-08-29: the user says nothing about a
 * timezone. Every other resolution case in this file hands `resolveDateLocally` an explicit
 * `sessionTimezone`, which is the one situation the product can rely on least. With none supplied
 * the resolver falls back to the host zone (`date-resolution.ts`, `sessionAnchor`), and the whole
 * question is whether it really does — a silent assumption of UTC gives the wrong calendar day for
 * every user west of Greenwich for part of each day, and reads as correct in a UTC test container.
 *
 * The assertions are therefore on the resolved interval rather than on any label: the same input,
 * resolved under two host zones, must land on two different instants. A UTC-assuming resolver
 * returns the same answer both times and fails here.
 */
describe("no timezone stated — the ordinary path", () => {
	function withHostTimezone<T>(timezone: string, body: () => T): T {
		const previous = process.env.TZ;
		process.env.TZ = timezone;
		try {
			return body();
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	}

	/**
	 * The async form, and it has to exist: the synchronous helper restores `TZ` as soon as the body
	 * returns, which for an async body is at its first `await`. Everything after that await would
	 * run under the original zone, so the test would be pinned to where the product happens to read
	 * the clock rather than to what it reads.
	 */
	async function withHostTimezoneAsync<T>(timezone: string, body: () => Promise<T>): Promise<T> {
		const previous = process.env.TZ;
		process.env.TZ = timezone;
		try {
			return await body();
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	}

	// 2026-06-06T04:00Z is 2026-06-05 21:00 in Los Angeles. One instant, two calendar days — which
	// is the only input shape that can tell a host-zone reader apart from a UTC-assuming one, since
	// day-granular results are carried as wall-clock values by design.
	const SESSION_INSTANT = Date.UTC(2026, 5, 6, 4, 0, 0);

	function resolveTodayWithNoStatedZone(): ReturnType<typeof resolveDateLocally> {
		return resolveDateLocally({
			text: "The user walked 8,578 steps today.",
			// An instant and nothing else — no `sessionTimezone`, which is what arrives when nobody
			// has said anything about a timezone.
			sessionTimestamp: SESSION_INSTANT,
			locale: "en",
			localFirst: true,
		});
	}

	it("puts today on the host's calendar day, not on the UTC one", () => {
		const pacific = withHostTimezone("America/Los_Angeles", resolveTodayWithNoStatedZone);
		expect(pacific.needsModel).toBe(false);
		if (pacific.result.interval.type !== "bounded") {
			throw new Error("today must resolve to a bounded day");
		}
		// Late evening in Los Angeles is already the next day in UTC. A resolver that assumed UTC
		// files this memory under the 6th, one day off, for every user west of Greenwich.
		expect(iso(pacific.result.interval.from)).toBe("2026-06-05T00:00:00.000Z");
		expect(iso(pacific.result.interval.until)).toBe("2026-06-06T00:00:00.000Z");

		const utc = withHostTimezone("UTC", resolveTodayWithNoStatedZone);
		if (utc.result.interval.type !== "bounded") {
			throw new Error("today must resolve to a bounded day");
		}
		expect(iso(utc.result.interval.from)).toBe("2026-06-06T00:00:00.000Z");

		// The two host zones must disagree. If they agree, the fallback never read the host at all
		// and both numbers above are accidents of the container's clock.
		expect(pacific.result.interval.from).not.toBe(utc.result.interval.from);
	});

	it("stores the timestamp the resolver produced, under the zone it resolved it in", async () => {
		// The two halves of this feature are settled in different files, and nothing checked the
		// join. Discarding the resolved value and writing a constant would prove only that each
		// half has a sane default — so the resolved instant is what gets written here, and the
		// assertion is that the stored pair is that value and not something re-derived.
		await withHostTimezoneAsync("America/Los_Angeles", async () => {
			const resolved = resolveTodayWithNoStatedZone();
			expect(resolved.needsModel).toBe(false);
			if (resolved.result.interval.type !== "bounded") {
				throw new Error("today must resolve to a bounded day");
			}
			const resolvedTimestamp = resolved.result.interval.from;
			const created = await store.store({
				text: "The user walked 8,578 steps today.",
				category: "episodic",
				projectId: PROJECT_ID,
				timestamp: resolvedTimestamp,
			});
			expect(created.timestamp).toBe(resolvedTimestamp);
			expect(created.timezone).toBe("America/Los_Angeles");
			expect(persistedPair(created.id)).toEqual({
				timestamp: resolvedTimestamp,
				timezone: "America/Los_Angeles",
			});
		});
	});

	it("falls back to the host's own clock when nothing anchors the session", async () => {
		// No session instant and no timezone: the resolver anchors on the host's current day rather
		// than refusing, and the write must still produce a row whose timezone is a real zone,
		// because the column rejects an empty one.
		const resolved = withHostTimezone("America/Los_Angeles", () =>
			resolveDateLocally({
				text: "The user walked 8,578 steps today.",
				locale: "en",
				localFirst: true,
			}),
		);
		if (resolved.result.interval.type !== "bounded") {
			throw new Error("today must resolve to a bounded day");
		}
		const hostToday = new Date().toLocaleDateString("en-CA", {
			timeZone: "America/Los_Angeles",
		});
		expect(iso(resolved.result.interval.from)).toBe(`${hostToday}T00:00:00.000Z`);

		const created = await store.store({
			text: "A memory captured with no session anchor at all.",
			category: "episodic",
			projectId: PROJECT_ID,
			timestamp: FIRST_TIMESTAMP,
		});
		expect(created.timezone).toBeTruthy();
		expect(persistedPair(created.id).timezone).toBe(created.timezone);
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
