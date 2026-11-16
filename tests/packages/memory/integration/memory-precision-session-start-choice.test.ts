/** Nightly session-start choice through a real encrypted store and scripted host model. */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { chooseNightlySessionStart } from "../../../../packages/memory/src/engine/precision-session-start";
import { createLlmClient, type LlmClient } from "../../../../packages/memory/src/model/llm-client";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

type Row = { id: string; text: string };
type Request = { workload: string; prompt: string; rows: Row[]; call: number };
type Reply = { status?: number; content: unknown };
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let fixture: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let requests: Request[];
let calls: Record<string, number>;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(() => {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	requests = [];
	calls = {};
});
afterEach(async () => {
	await store?.close();
	fixture?.cleanup();
});

function plant(id: string, metadata: Record<string, unknown> = {}, project = "global", kind = "rule", lane = "active") {
	fixture.runtime.db.prepare(`INSERT INTO nodix_memories
		(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane)
		VALUES (?, ?, 'profile', ?, 0.7, 1000, 'UTC', ?, ?, ?, ?)`).run(
		id, `Always explain the reason for ${id}.`, project,
		JSON.stringify({ precision_kind: kind, writer_agent_id: "codex", ...metadata }),
		createHash("sha256").update(id).digest("hex"), `fact-${id}`, lane,
	);
}
function metadata(id: string): Record<string, unknown> {
	const row = store.getById(id);
	expect(row, `stored row ${id}`).toBeDefined();
	return JSON.parse(row?.metadata ?? "{}");
}
function byWorkload(workload: string) { return requests.filter(request => request.workload === workload); }

async function model(reply: (request: Request) => Reply): Promise<LlmClient> {
	return createLlmClient({ preset: "mem_claw/sno_extract_chat", usageClass: "research", timeoutMs: 5_000,
		routing: { mode: "agent-native", language: "en", modelCalls: defaultSettings().modelCalls },
		onTransportAttempt: ({ callId }) => { calls[callId] = (calls[callId] ?? 0) + 1; },
		agentPort: { async complete({ prompt }) {
			const workload = prompt.includes("These are lasting rules") ? "station-start-pick" : "station-start-label";
			const callId = workload === "station-start-label" ? "E19" : "E20";
			const recorded = { workload, prompt, rows: JSON.parse(prompt.split("\n").at(-1) ?? "null"), call: calls[callId] ?? 0 };
			requests.push(recorded);
			const answer = reply(recorded);
			return answer.status
				? { kind: "error", category: "transport", message: "nightly picker unavailable" }
				: { kind: "ok", text: JSON.stringify(answer.content) };
		} },
	});
}

describe("nightly session-start choice", () => {
	it("stores two-vote labels, asks a third time for a split batch and leaves a three-way split unlabelled", async () => {
		for (const id of ["A", "B", "C"]) plant(id);
		const votes: Record<string, string[]> = { A: ["core", "core", "core"], B: ["topic", "drop", "topic"], C: ["core", "drop", "topic"] };
		const llm = await model(request => {
			if (request.workload === "station-start-pick") return { content: { ids: ["A"] } };
			const rows = request.rows.map(row => ({ id: row.id, label: votes[row.id]?.[request.call - 1] }));
			return { content: request.call === 3 ? rows : { rows } };
		});
		const result = await chooseNightlySessionStart(store, llm);
		expect(result).toEqual({ labelCalls: 3, pickCalls: 3 });
		expect(byWorkload("station-start-label")).toHaveLength(3);
		expect(metadata("A")).toMatchObject({ start_label: "core", start_rank: 1, precision_kind: "rule", writer_agent_id: "codex" });
		expect(metadata("B")).toMatchObject({ start_label: "topic" });
		expect(metadata("B")).not.toHaveProperty("start_rank");
		expect(metadata("C")).not.toHaveProperty("start_label");
		expect(metadata("C")).not.toHaveProperty("start_rank");
	});

	it("ranks core rows chosen at least twice by their average returned position", async () => {
		for (const id of ["A", "B", "C", "D"]) plant(id, { start_label: "core" });
		const choices = [["A", "B", "C"], ["B", "A", "D"], ["A", "D", "B"]];
		const llm = await model(request => ({ content: { ids: choices[request.call - 1] } }));
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 3 });
		expect(byWorkload("station-start-label")).toEqual([]);
		expect(byWorkload("station-start-pick").map(request => request.rows.map(row => row.id).sort()))
			.toEqual(Array.from({ length: 3 }, () => ["A", "B", "C", "D"]));
		expect(["A", "B", "D"].map(id => metadata(id).start_rank)).toEqual([1, 2, 3]);
		expect(metadata("C").start_rank).toBe(0);
	});

	it("ranks only the first 12 shared core rows when all three replies name the same 20 ids", async () => {
		const ids = Array.from({ length: 24 }, (_, index) => `shared-${index + 1}`);
		for (const id of ids) plant(id, { start_label: "core" });
		const llm = await model(() => ({ content: { ids: ids.slice(0, 20) } }));
		await chooseNightlySessionStart(store, llm);
		const ranks = ids.map(id => metadata(id).start_rank);
		expect(ranks.filter(rank => typeof rank === "number" && rank > 0)).toHaveLength(12);
		expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("ranks only 12 shared core rows after aggregating three pairwise-overlapping replies", async () => {
		const ids = Array.from({ length: 18 }, (_, index) => `shared-${index + 1}`);
		for (const id of ids) plant(id, { start_label: "core" });
		const choices = [ids.slice(0, 12), [...ids.slice(0, 6), ...ids.slice(12)], ids.slice(6)];
		const llm = await model(request => ({ content: { ids: choices[request.call - 1] } }));
		await chooseNightlySessionStart(store, llm);
		const ranks = ids.map(id => metadata(id).start_rank);
		expect(ranks.filter(rank => typeof rank === "number" && rank > 0)).toHaveLength(12);
		expect(ranks.sort((left, right) => Number(left) - Number(right)))
			.toEqual([0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	it("ranks only the first 10 project core rows when all three replies name 12 ids", async () => {
		const ids = Array.from({ length: 12 }, (_, index) => `project-${index + 1}`);
		for (const id of ids) plant(id, { start_label: "core" }, "work-project");
		const llm = await model(() => ({ content: { ids } }));
		await chooseNightlySessionStart(store, llm);
		expect(ids.map(id => metadata(id).start_rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0]);
	});

	it("picks an already labelled list again when a core row has never been ranked", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core", start_rank: 2 });
		plant("C", { start_label: "core", start_rank: 0 });
		plant("D", { start_label: "core" });
		const llm = await model(() => ({ content: { ids: ["D", "A", "B"] } }));
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 3 });
		expect(byWorkload("station-start-label")).toEqual([]);
		expect.soft(byWorkload("station-start-pick").map(request => request.rows.map(row => row.id).sort()))
			.toEqual(Array.from({ length: 3 }, () => ["A", "B", "C", "D"]));
		expect(["D", "A", "B", "C"].map(id => metadata(id).start_rank)).toEqual([1, 2, 3, 0]);
	});

	it("picks an already labelled list again when a deleted row leaves a gap in the ranks", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core", start_rank: 2 });
		plant("C", { start_label: "core", start_rank: 3 });
		fixture.runtime.db.prepare("DELETE FROM nodix_memories WHERE id = ?").run("B");
		const llm = await model(() => ({ content: { ids: ["A", "C"] } }));
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 3 });
		expect(byWorkload("station-start-label")).toEqual([]);
		expect.soft(byWorkload("station-start-pick")).toHaveLength(3);
		expect(["A", "C"].map(id => metadata(id).start_rank)).toEqual([1, 2]);
	});

	it("does not pick again when every core row has a rank and positive ranks are contiguous", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core", start_rank: 2 });
		plant("C", { start_label: "core", start_rank: 0 });
		const previous = ["A", "B", "C"].map(id => metadata(id));
		const llm = await model(() => ({ content: { ids: ["B", "A", "C"] } }));
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 0 });
		expect(byWorkload("station-start-label")).toEqual([]);
		expect(byWorkload("station-start-pick")).toEqual([]);
		expect(["A", "B", "C"].map(id => metadata(id))).toEqual(previous);
	});

	it("keeps all previous ranks and leaves an unranked core row unranked when two pick judgments fail", async () => {
		plant("A", { start_label: "core", start_rank: 2 });
		plant("B", { start_label: "core", start_rank: 1 });
		plant("C", { start_label: "core", start_rank: 0 });
		plant("D");
		const previousRanks = ["A", "B", "C", "D"].map(id => metadata(id).start_rank);
		const llm = await model(request => {
			if (request.workload === "station-start-label") return { content: { rows: request.rows.map(row => ({ id: row.id, label: "core" })) } };
			return request.call === 1 ? { content: { ids: ["C", "A", "D"] } } : { status: 500, content: null };
		});
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 2, pickCalls: 3 });
		expect(calls.E20).toBe(3);
		expect([...new Set(byWorkload("station-start-pick").map(request => request.call))]).toEqual([1, 2, 3]);
		expect(["A", "B", "C", "D"].map(id => metadata(id).start_rank)).toEqual(previousRanks);
		expect(metadata("D")).toMatchObject({ start_label: "core" });
		expect(metadata("D")).not.toHaveProperty("start_rank");
	});

	it("labels and picks shared and project lists separately, excluding inactive and assistant rows", async () => {
		plant("shared-rule");
		plant("shared-person", {}, "global", "person");
		plant("project-rule", {}, "work-project");
		plant("project-pitfall", {}, "work-project", "pitfall");
		plant("other-rule", {}, "other-project");
		plant("old-topic", { start_label: "topic", start_rank: 1 }, "work-project");
		plant("shared-pitfall", {}, "global", "pitfall");
		plant("project-person", {}, "work-project", "person");
		plant("assistant-rule", { asserted_by: "assistant" });
		plant("parked-rule", {}, "work-project", "rule", "parked");
		plant("retired-rule", { invalidated_at: 1 }, "work-project");
		const groups = [["shared-person", "shared-rule"], ["project-pitfall", "project-rule"], ["other-rule"]];
		const llm = await model(request => ({ content: request.workload === "station-start-label"
			? { rows: request.rows.map(row => ({ id: row.id, label: "core" })) }
			: { ids: request.rows.map(row => row.id).sort() } }));
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 6, pickCalls: 9 });
		for (const [workload, count] of [["station-start-label", 2], ["station-start-pick", 3]] as const) {
			const sent = byWorkload(workload);
			for (const group of groups) expect(sent.filter(request => JSON.stringify(request.rows.map(row => row.id).sort()) === JSON.stringify(group))).toHaveLength(count);
			expect(sent).toHaveLength(groups.length * count);
		}
		for (const group of groups) {
			for (const [index, id] of group.entries()) expect(metadata(id)).toMatchObject({ start_label: "core", start_rank: index + 1 });
		}
		expect(metadata("old-topic")).not.toHaveProperty("start_rank");
		for (const id of ["shared-pitfall", "project-person", "assistant-rule", "parked-rule", "retired-rule"]) {
			expect(metadata(id)).not.toHaveProperty("start_label");
		}
	});

	it("stops at 60 label calls with forty-row batches and leaves remaining rows for the next night", async () => {
		fixture.runtime.db.transaction(() => {
			for (let index = 0; index < 2401; index++) plant(`budget-${index}`);
		})();
		const llm = await model(request => ({ content: request.workload === "station-start-label"
			? { rows: request.rows.map(row => ({ id: row.id, label: "topic" })) } : { ids: [] } }));
		expect((await chooseNightlySessionStart(store, llm)).labelCalls).toBe(60);
		const labels = byWorkload("station-start-label");
		expect(labels).toHaveLength(60);
		for (const request of labels) expect(request.rows.length).toBeLessThanOrEqual(40);
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.start_label') = 'topic'").get()).toEqual({ rows: 1200 });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.start_label') IS NULL").get()).toEqual({ rows: 1201 });
	});
});
