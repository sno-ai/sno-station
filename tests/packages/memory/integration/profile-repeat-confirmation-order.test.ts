/** @file profile-repeat-confirmation-order.test.ts
 * @purpose Repeating the assertion a profile section already holds changes no text, but it IS a
 *   confirmation: the out-of-order guard must measure staleness from the LAST time the user said
 *   it, not the first. Otherwise a delayed message from between the two overwrites a value the
 *   user has just restated.
 * @boundary Real encrypted SQLite and the real embedder; the out-of-order guard answers before
 *   any model call, so there is no LLM boundary on this path.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { runProfileSectionUpdate } from "../../../../packages/memory/src/engine/extraction/profile-section-writer.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "profile-repeat-confirmation";
const SECTION = "preferences.hot_drink";
const TEA = "The user drinks tea in the morning.";
const COFFEE = "The user drinks coffee in the morning.";
const FIRST_SAID = Date.parse("2026-07-28T09:00:00Z");
const DELAYED_MESSAGE = FIRST_SAID + 60_000;
const SAID_AGAIN = FIRST_SAID + 120_000;

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder?.dispose?.();
});

describe("profile repeat confirmation and the out-of-order guard", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	function open(): MemoryStore {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		return store;
	}

	function liveContent(target: MemoryStore): { content: string | undefined; validFrom: unknown } {
		const row = target.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!row) return { content: undefined, validFrom: undefined };
		const metadata = parseInsightMetadata(row.metadata, row);
		return { content: metadata.l2_content, validFrom: metadata.valid_from };
	}

	async function say(target: MemoryStore, assertion: string, at: number) {
		return runProfileSectionUpdate({
			scope: SCOPE,
			sectionName: SECTION,
			newAssertion: assertion,
			source: { messageId: `repeat-confirmation-${at}` },
			store: target,
			at,
		});
	}

	it("moves the staleness bar to the repeat, so a message from before it cannot win", async () => {
		const target = open();
		await say(target, TEA, FIRST_SAID);
		expect(liveContent(target).validFrom).toBe(FIRST_SAID);

		// Said again, unchanged. No new text, but the profile is now current as of this moment.
		const repeat = await say(target, TEA, SAID_AGAIN);
		expect(repeat.outcome).toBe("no-op");
		expect(liveContent(target).validFrom).toBe(SAID_AGAIN);

		// A message from BETWEEN the two arrives late. It is older than the confirmation, so it
		// must not replace it.
		const delayed = await say(target, COFFEE, DELAYED_MESSAGE);
		expect(delayed.outcome).toBe("no-op");
		expect(liveContent(target).content).toBe(TEA);
	});

	it("never drags the bar backwards when the repeat itself is the late one", async () => {
		const target = open();
		await say(target, TEA, SAID_AGAIN);
		expect(liveContent(target).validFrom).toBe(SAID_AGAIN);

		// An older copy of the same assertion turns up afterwards. It confirms nothing new, and
		// moving the bar back to it would re-open the window this guard exists to close.
		const older = await say(target, TEA, FIRST_SAID);
		expect(older.outcome).toBe("no-op");
		expect(liveContent(target).validFrom).toBe(SAID_AGAIN);
	});

	it("leaves a row another writer closed exactly as the close left it", async () => {
		const target = open();
		await say(target, TEA, FIRST_SAID);
		const live = target.getByFactKey(SCOPE, `profile:${SECTION}`);
		if (!live) throw new Error("the first assertion wrote no profile row");
		const update = target.update.bind(target);

		// Another writer replaces and CLOSES this row while the repeat below is in flight, which
		// is what makes the repeat's compare-and-set lose. A close only rewrites metadata, so the
		// content hash the retry compares is unchanged and cannot see it.
		vi.spyOn(target, "update").mockImplementationOnce(async (id, changes) => {
			const metadata = parseInsightMetadata(live.metadata, live);
			await update(live.id, {
				writerAuthority: "profile-writer",
				metadata: stringifyInsightMetadata(
					buildInsightMetadata(live, {
						...metadata,
						invalidated_at: DELAYED_MESSAGE,
						superseded_by: "concurrent-replacement-row",
					}),
				),
				expectedContentHash: live.contentHash,
				expectedMetadata: live.metadata,
			});
			return update(id, changes);
		});

		const repeat = await say(target, TEA, SAID_AGAIN);
		expect(repeat.outcome).toBe("no-op");

		// Carrying `valid_from` past the `invalidated_at` the close wrote makes the codec DROP
		// that field, and the retired value reads as live again beside its replacement.
		const closed = target.getById(live.id);
		if (!closed) throw new Error("the closed profile row disappeared");
		const after = parseInsightMetadata(closed.metadata, closed);
		expect(after.invalidated_at).toBe(DELAYED_MESSAGE);
		expect(after.valid_from).toBe(FIRST_SAID);
	});
});
