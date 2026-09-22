/** Real encrypted SQLite, real audit filesystem, and deterministic model-boundary responses. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { InsightDistiller } from "@/extraction/memory-extraction-pipeline";
import type { LlmClient } from "../../../../packages/memory/src/model/llm-client";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import { createTestLlmClient } from "../../../apps/mem-claw/helpers/llm-client.ts";

const PROJECT_ID = "extraction-drop-audit-ledger";
const SESSION_KEY = "agent:test:drop-ledger";

let embedder: Embedder;
let fixture: TestDb;
let stateDir: string;
let store: MemoryStore;
/** Rows the last `runAndRestart` left in the store, printed above and read by the cases. */
let kept: Awaited<ReturnType<MemoryStore["list"]>> = [];

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	fixture = createTestDb();
	stateDir = mkdtempSync(join(tmpdir(), "mem-claw-drop-ledger-"));
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
});

afterEach(async () => {
	await store.close();
	fixture.cleanup();
	rmSync(stateDir, { recursive: true, force: true });
});

function auditRows(): Array<Record<string, unknown>> {
	const path = join(stateDir, "audit.jsonl");
	// No audit file means nothing was written, which is now the ordinary outcome: most refused
	// candidates are kept rather than dropped, and a kept candidate writes no drop entry.
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runAndRestart(llm: LlmClient, conversation: string): Promise<void> {
	const distiller = new InsightDistiller(store, embedder, llm, {
		defaultScope: PROJECT_ID,
		stateDir,
	});
	await distiller.extractAndPersist(conversation, SESSION_KEY, {
		scope: PROJECT_ID,
		sessionDateTime: "2026-07-31T08:00:00.000Z",
	});
	await store.close();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	const rows = await store.list({ projectId: PROJECT_ID });
	kept = rows;
	process.stdout.write(
		`\nDROP_LEDGER_ROWS_BEGIN\n${JSON.stringify(
			rows.map((row) => ({
				category: row.category,
				lane: row.lane,
				disposition: row.dispositionReason ?? null,
				text: row.text,
			})),
			null,
			1,
		)}\nDROP_LEDGER_ROWS_END\n`,
	);
	process.stdout.write(
		`DROP_LEDGER_AUDIT_BEGIN\n${JSON.stringify(
			auditRows()
				.filter((entry) => entry.decision === "extraction_candidate_dropped")
				.map((entry) => entry.details),
			null,
			1,
		)}\nDROP_LEDGER_AUDIT_END\n`,
	);
}

function expectDrop(disposition: string, originalText: string): void {
	expect(auditRows()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				event: "ambient_learning",
				decision: "extraction_candidate_dropped",
				details: expect.objectContaining({
					sessionKey: SESSION_KEY,
					disposition,
					originalText,
				}),
			}),
		]),
	);
}

describe("extraction drop audit ledger", () => {
	it("survives restart for a malformed-text drop", async () => {
		const raw = {
			category: "profile",
			abstract: { text: "not a string" },
			overview: "Malformed candidate",
			content: "The user prefers short replies.",
		};
		await runAndRestart(
			createTestLlmClient({
				completeJson: async () => ({ memories: [raw] }),
			}),
			"user: I prefer short replies.\nassistant: noted",
		);

		expectDrop("malformed-text", JSON.stringify(raw));
	});

	it("keeps a third-party fact across a restart instead of dropping it", async () => {
		const originalText = "The user's manager prefers email updates.";
		await runAndRestart(
			createTestLlmClient({
				completeJson: async () => ({
					memories: [
						{
							category: "profile",
							section_name: "preferences.communication",
							abstract: originalText,
							overview: originalText,
							content: originalText,
						},
					],
				}),
				completeText: async () =>
					JSON.stringify({
						verdicts: [
							{
								candidate_index: 0,
								subject_is_user: false,
								reason: "third-party preference",
							},
						],
					}),
			}),
			"user: My manager prefers email updates.\nassistant: noted",
		);

		// OWNER LAW 2026-08-26: the gate saying "not about the user" decides this is not PROFILE
		// material. It does not decide the sentence never happened. This case used to demand a
		// `subject_not_user` DROP entry, which is the design that lost 195 real user facts across
		// six personas — step counts, coffee purchases, an explicit retraction. The guarantee now
		// runs the other way, so that is what is checked: the fact is still here after the
		// restart, it is active, it carries the reason it left the profile, and nothing in the
		// ledger claims it was lost.
		const survivor = kept.find((row) => /manager prefers email/i.test(row.text));
		expect(survivor).toBeDefined();
		expect(survivor).toMatchObject({
			category: "episodic",
			lane: "active",
			dispositionReason: "subject_not_user",
		});
		expect(
			auditRows().filter((entry) => entry.decision === "extraction_candidate_dropped"),
		).toEqual([]);
	});
});
