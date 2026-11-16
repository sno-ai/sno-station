/** Nightly restatement merging through the daily entry, real encrypted store and stored chunk vectors. */
import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSchema, type Settings } from "../../../../packages/memory/config/settings";
import type { AgentLlmCompletion, AgentLlmPort } from "../../../../packages/memory/src/model/agent-llm-port";
import { runPrecisionNightly } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

type Judgment = { facts: Array<{ index: number; text: string; by: string;
	rows: Array<{ id: string; text: string; by: string }> }> };
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let settings: Settings;
let answer: (request: Judgment) => string;
let confirmed: boolean;
let agentPort: AgentLlmPort;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(() => {
	database = createTestDb();
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	settings = settingsSchema.parse(writeSettingsFixture(dirname(database.dbPath), {
		mode: "agent-native", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		telemetry: { memoryUsage: { enabled: false } },
	}).settings);
	vi.spyOn(Date, "now").mockReturnValue(1_794_729_600_000);
	confirmed = true;
	answer = request => JSON.stringify({ facts: request.facts.map(fact => ({ index: fact.index,
		rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })) })) });
	agentPort = { async complete({ prompt, callId }): Promise<AgentLlmCompletion> {
		const payload = JSON.parse(prompt.trimEnd().split("\n").at(-1) ?? "null");
		if (callId === "E13") return { kind: "ok", text: '{"mode":"work"}' };
		if (callId === "E21") {
			return { kind: "ok", text: answer(payload) };
		}
		if (callId === "E23") return { kind: "ok", text: JSON.stringify({ confirmed }) };
		if (callId === "E16") return { kind: "ok", text: JSON.stringify({
			rows: payload.map((row: { id: string }) => ({ id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: false })),
		}) };
		if (callId === "E20") return { kind: "ok", text: '{"ids":[]}' };
		if (callId === "E19") return { kind: "ok", text: JSON.stringify({ rows: payload.map((row: { id: string }) => ({ id: row.id, label: "topic" })) }) };
		throw new Error(`Unexpected nightly call ${callId}`);
	} };
});
afterEach(async () => { try { await store?.close(); database?.cleanup(); } finally { vi.restoreAllMocks(); } });

async function plant(id: string, text: string, timestamp: number, projectId = "global", metadata: Record<string, unknown> = {}) {
	const written = await store.store({ text, category: "episodic", projectId, timestamp,
		metadata: JSON.stringify({ precision_kind: "rule", writer_agent_id: "codex", source_order: {
			valid_from: null, session_moment: timestamp, session_ordinal: 0, global_turn_index: 0,
			rowid: 0, conversation_id: id,
		}, ...metadata }) });
	// Keep the normal write's real chunks/vectors; only give the fixture a literal row id.
	database.sqlite.transaction(() => {
		database.sqlite.exec("PRAGMA defer_foreign_keys = ON");
		database.sqlite.prepare("UPDATE nodix_memories SET id = ?, fact_id = ? WHERE id = ?").run(id, id, written.id);
		database.sqlite.prepare("UPDATE nodix_memory_chunks SET memory_id = ? WHERE memory_id = ?").run(id, written.id);
		database.sqlite.prepare("UPDATE nodix_rem_memory_facets SET memory_id = ? WHERE memory_id = ?").run(id, written.id);
		database.sqlite.prepare("UPDATE nodix_rem_census_rows SET row_id = ? WHERE row_id = ?").run(id, written.id);
	})();
}

function metadata(id: string): Record<string, unknown> {
	expect(store.getById(id), `stored row ${id}`).toBeDefined();
	return JSON.parse(store.getById(id)?.metadata ?? "{}");
}
function ids() {
	return (database.sqlite.prepare("SELECT id FROM nodix_memories ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
}
async function night(waveId: string) {
	// The daily entry runs precision work without older operations.
	await runPrecisionNightly({ settings, mode: "agent-native", agentPort,
		waveId });
	expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memory_migration_markers WHERE name = 'memory-precision-last-night'").get())
		.toEqual({ count: 1 });
}

function same(request: Judgment): string {
	return JSON.stringify({ facts: request.facts.map(fact => ({ index: fact.index,
		rows: fact.rows.map(row => ({ id: row.id, relation: "same" })) })) });
}
function marks() {
	return database.sqlite.prepare(`SELECT id,
		json_extract(metadata, '$.precision_night.at') AS at,
		json_extract(metadata, '$.precision_night.text') = content_hash AS current_text,
		json_extract(metadata, '$.precision_check') AS pending
		FROM nodix_memories ORDER BY id`).all();
}

describe("nightly duplicate merging", () => {
	it("deletes the later owner paraphrase after a per-row relation and E23 confirmation", async () => {
		await plant("earlier-owner", "The owner requires every reply to be written in Chinese.", 1000);
		await plant("later-owner", "The user asked the assistant to speak Chinese.", 2000);
		answer = same;
		await night("night-owner-agreement");
		expect.soft(store.getById("later-owner")).toBeUndefined();
		expect.soft(store.getById("earlier-owner")?.text).toBe("The owner requires every reply to be written in Chinese.");
		expect.soft(ids()).toEqual(["earlier-owner"]);
		expect.soft(metadata("earlier-owner").source_order).toEqual({ valid_from: null, session_moment: 2000,
			session_ordinal: 0, global_turn_index: 0, rowid: 0, conversation_id: "later-owner" });
		expect.soft(marks()).toEqual([{ id: "earlier-owner", at: 1_794_729_600_000, current_text: 1, pending: null }]);
	});

	it("keeps both owner rows marked checked without a priority recheck when E23 refuses deletion", async () => {
		await plant("earlier-owner", "The owner requires every reply to be written in Chinese.", 1000);
		await plant("later-owner", "The user asked the assistant to speak Chinese.", 2000);
		answer = same; confirmed = false;
		await night("night-owner-disagreement");
		expect.soft(database.sqlite.prepare(`SELECT stage, outcome FROM nodix_rem_journal
			WHERE job_id = 'night-owner-disagreement' AND outcome = 'undecided'`).all())
			.toEqual([{ stage: "duplicate", outcome: "undecided" }]);
		expect.soft(ids()).toEqual(["earlier-owner", "later-owner"]);
		expect.soft(store.getById("earlier-owner")?.text).toBe("The owner requires every reply to be written in Chinese.");
		expect.soft(store.getById("later-owner")?.text).toBe("The user asked the assistant to speak Chinese.");
		expect.soft(metadata("earlier-owner")).not.toHaveProperty("precision_recheck_with");
		expect.soft(metadata("later-owner")).not.toHaveProperty("precision_recheck_with");
		expect.soft(marks()).toEqual([
			{ id: "earlier-owner", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "later-owner", at: 1_794_729_600_000, current_text: 1, pending: null },
		]);
	});

	it("deletes a project restatement of a shared rule while keeping unrelated seed rows", async () => {
		await plant("shared-seed", "The owner requires every reply to be written in Chinese.", 1000);
		await plant("project-seed", "The owner requires every reply to be written in Chinese.", 1000, "agent:duplicate-merge");
		await plant("shared-rule", "The user asked the assistant to speak Chinese.", 3000);
		await plant("project-rule", "The user asked the assistant to speak Chinese.", 2000, "agent:duplicate-merge");
		answer = request => JSON.stringify({ facts: request.facts.map(fact => ({ index: fact.index,
			rows: fact.rows.map(row => ({ id: row.id,
				relation: fact.text === "The user asked the assistant to speak Chinese." && ["shared-rule", "project-rule"].includes(row.id) ? "same" : "unrelated" })) })) });
		await night("night-shared-before-project");
		expect.soft(store.getById("project-rule")).toBeUndefined();
		expect.soft(store.getById("shared-rule")?.projectId).toBe("global");
		expect.soft(ids()).toEqual(["project-seed", "shared-rule", "shared-seed"]);
		for (const id of ["project-seed", "shared-rule", "shared-seed"]) {
			expect.soft(metadata(id)).not.toHaveProperty("precision_check");
			expect.soft(metadata(id)).not.toHaveProperty("precision_recheck_with");
		}
	});

	it("leaves an unreadable judgment unmarked and retries the stored rows in the ordinary pass next night", async () => {
		await plant("earlier-owner", "The owner requires every reply to be written in Chinese.", 1000);
		await plant("later-owner", "The user asked the assistant to speak Chinese.", 2000);
		answer = () => "unreadable relation judgment";
		await night("night-failed-judgment");
		expect.soft(ids()).toEqual(["earlier-owner", "later-owner"]);
		expect.soft(marks()).toEqual([
			{ id: "earlier-owner", at: null, current_text: null, pending: null },
			{ id: "later-owner", at: null, current_text: null, pending: null },
		]);
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		answer = same;
		await night("night-retry-judgment");
		expect.soft(store.getById("later-owner")).toBeUndefined();
		expect.soft(ids()).toEqual(["earlier-owner"]);
		expect.soft(metadata("earlier-owner")).not.toHaveProperty("precision_check");
	});

	it("judges eight nearest open rows and marks unrelated rows fine without the removed duplicate flag", async () => {
		for (let index = 1; index <= 8; index += 1) {
			await plant(`near-${index}`, `The owner requires every reply to be written in Chinese with report detail ${index}.`, index * 1000);
		}
		await plant("far-row", "Jupiter has a powerful magnetic field.", 9000);
		await plant("candidate", "The owner requires every reply to be written in Chinese with all report details.", 10000);
		const unrelated = answer;
		answer = request => request.facts.some(fact => fact.text === "The owner requires every reply to be written in Chinese with all report details."
			&& fact.rows.length !== 8) ? "missing the required eight nearest rows" : unrelated(request);
		await night("night-neighbour-limit");
		expect.soft(ids()).toEqual(["candidate", "far-row", "near-1", "near-2", "near-3", "near-4", "near-5", "near-6", "near-7", "near-8"]);
		expect.soft(marks()).toEqual([
			{ id: "candidate", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "far-row", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-1", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-2", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-3", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-4", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-5", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-6", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-7", at: 1_794_729_600_000, current_text: 1, pending: null },
			{ id: "near-8", at: 1_794_729_600_000, current_text: 1, pending: null },
		]);
		for (const id of ids()) expect.soft(metadata(id)).not.toHaveProperty("duplicate_checked");
	});
});
