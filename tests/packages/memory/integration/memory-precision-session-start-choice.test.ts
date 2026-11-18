/** Nightly session-start choice through a real encrypted store and scripted host model. */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { chooseNightlySessionStart } from "../../../../packages/memory/src/engine/precision-session-start";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/index";
import type { AgentLlmRequest, HostIdentity } from "../../../../packages/memory/src/model/agent-llm-port";
import { createLlmClient, type LlmClient } from "../../../../packages/memory/src/model/llm-client";
import { selectSessionStartRows } from "../../../../packages/memory/src/store/session-start-selection";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

type Row = { id: string; text: string };
type Request = AgentLlmRequest & { workload: string; rows: Row[]; call: number };
type Reply = { status?: number; content: unknown; responder?: HostIdentity; raw?: string };
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let fixture: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let requests: Request[];
let calls: Record<string, number>;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(() => {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	installRemSchema(fixture.runtime.db);
	requests = [];
	calls = {};
});
afterEach(async () => {
	await store?.close();
	fixture?.cleanup();
	vi.restoreAllMocks();
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
		agentPort: { async complete(request) {
			const { prompt, callId } = request;
			const workload = callId === "E19" ? "station-start-label" : callId === "E23" ? "station-start-check" : "station-start-pick";
			const recorded = { ...request, workload, rows: JSON.parse(prompt.split("\n").at(-1) ?? "null"), call: calls[callId ?? ""] ?? 0 };
			requests.push(recorded);
			const answer = reply(recorded);
			return answer.status
				? { kind: "error", category: "transport", message: "nightly picker unavailable" }
				: { kind: "ok", text: answer.raw ?? JSON.stringify(answer.content), responder: answer.responder };
		} },
	});
}

describe("nightly session-start choice", () => {
	it("delivers positive ranks first, then unlabelled rules by importance and newest, excluding labelled unranked rows", () => {
		plant("shared-second", { start_label: "core", start_rank: 2 });
		plant("shared-first", { start_label: "core", start_rank: 1 });
		plant("project-third", { start_label: "core", start_rank: 3 }, "work-project", "pitfall");
		for (const [id, start_rank] of [["zero", 0], ["negative", -1], ["string", "1"], ["null", null], ["missing", undefined]] as const) {
			plant(id, { start_label: "core", start_rank });
		}
		plant("topic", { start_label: "topic" });
		plant("unlabelled");
		plant("unlabelled-newer");
		plant("unlabelled-important");
		const updateOrder = fixture.runtime.db.prepare("UPDATE nodix_memories SET importance = ?, timestamp = ? WHERE id = ?");
		updateOrder.run(0.8, 2000, "unlabelled");
		updateOrder.run(0.8, 3000, "unlabelled-newer");
		updateOrder.run(0.9, 1000, "unlabelled-important");
		plant("dropped", { start_label: "drop", start_rank: 1 });
		plant("assistant", { start_label: "core", start_rank: 1, asserted_by: "assistant" });
		plant("parked", { start_label: "core", start_rank: 1 }, "global", "rule", "parked");
		plant("retired", { start_label: "core", start_rank: 1, invalidated_at: 1 });
		plant("shared-pitfall", { start_label: "core", start_rank: 1 }, "global", "pitfall");
		plant("project-person", { start_label: "core", start_rank: 1 }, "work-project", "person");
		plant("other-project", { start_label: "core", start_rank: 1 }, "other-project");
		expect.soft(selectSessionStartRows(store, "work-project").map(row => row.id))
			.toEqual(["shared-first", "shared-second", "project-third", "unlabelled-important", "unlabelled-newer", "unlabelled"]);
		expect.soft(selectSessionStartRows(store, "global").map(row => row.id))
			.toEqual(["shared-first", "shared-second", "unlabelled-important", "unlabelled-newer", "unlabelled"]);
	});

	it("delivers unclassified owner memories newest first between ranked and unlabelled rules", () => {
		plant("unlabelled", {}, "work-project");
		plant("ranked", { start_label: "core", start_rank: 1 }, "work-project");
		plant("project-older", { precision_kind: undefined, source: "manual" }, "work-project");
		plant("project-newer", { precision_kind: undefined, source: "manual" }, "work-project");
		plant("shared", { precision_kind: undefined, source: "manual" });
		plant("assistant", { precision_kind: undefined, source: "manual", asserted_by: "assistant" });
		plant("dropped", { precision_kind: undefined, source: "manual", start_label: "drop", start_rank: 1 });
		plant("other-project", { precision_kind: undefined, source: "manual" }, "other-project");
		plant("reflection", { precision_kind: undefined, type: "memory-reflection-item" });
		plant("active-task", { precision_kind: undefined, source: "ambient-learning" }, "work-project");
		plant("decision", { start_label: "core", start_rank: 1 }, "work-project", "decision");

		const updateOrder = fixture.runtime.db.prepare("UPDATE nodix_memories SET importance = ?, timestamp = ? WHERE id = ?");
		updateOrder.run(0.9, 2000, "project-older");
		updateOrder.run(0.7, 4000, "project-newer");
		updateOrder.run(0.8, 3000, "shared");

		expect(selectSessionStartRows(store, "work-project").map(row => row.id))
			.toEqual(["ranked", "project-newer", "shared", "project-older", "unlabelled"]);
	});

	it("puts the short-list instruction immediately before the JSON instruction in both pick prompts", async () => {
		plant("shared", { start_label: "core" });
		plant("project", { start_label: "core" }, "work-project");
		const llm = await model(request => ({ content: { ids: request.rows.map(row => row.id) } }));
		await chooseNightlySessionStart(store, llm);
		const sentence = " Leave out a rule that matters only for one kind of step (for example how to word a commit message, one closeout check, the exact wording of a report, which file to read first), and leave out a memory whose text does not show that it is a standing rule rather than an instruction for one batch of tasks or a quote from one earlier conversation. A short list of rules the agent would otherwise get wrong in most sessions is better than a long one.";
		const picks = byWorkload("station-start-pick");
		expect(picks).toHaveLength(6);
		for (const request of picks) expect.soft(request.prompt).toContain(`${sentence} Return only JSON`);
	});

	it("gives project picks and their check the newly ranked shared texts in rank order", async () => {
		plant("shared-a", { start_label: "core", start_rank: 2 });
		plant("shared-b", { start_label: "core", start_rank: 1 });
		plant("shared-unranked", { start_label: "core" });
		plant("shared-zero", { start_label: "core", start_rank: 0 });
		plant("shared-inactive", { start_label: "core", start_rank: 1 }, "global", "rule", "parked");
		plant("project", { start_label: "core" }, "work-project");
		const llm = await model(request => ({ content: { ids: request.rows.some(row => row.id === "project") ? ["project"] : ["shared-a", "shared-b"] } }));
		await chooseNightlySessionStart(store, llm);
		const prefix = "The agent is already told these shared memories at the start of every session; do not choose a memory that one of them already covers, even in other words or more generally, or that contradicts one of them: ";
		const sharedTexts = ["shared-a", "shared-b"].map(id => store.getById(id)?.text);
		const projectRequests = requests.filter(request => request.rows.some(row => row.id === "project"));
		expect.soft(projectRequests.map(request => request.callId)).toEqual(["E20", "E20", "E20", "E23"]);
		for (const request of projectRequests) expect.soft(request.prompt).toContain(prefix + JSON.stringify(sharedTexts));
		expect(requests.slice(0, 4).map(request => request.callId)).toEqual(["E20", "E20", "E20", "E23"]);
	});

	it("checks once with the first usable pick responder's other vendor and ranks only confirmed ids in pick order", async () => {
		for (const [id, rank] of [["A", 2], ["B", 1], ["C", 0], ["D", undefined]] as const) plant(id, { start_label: "core", start_rank: rank });
		const first = { skinId: "claude-code", vendor: "anthropic" };
		const usable = { skinId: "codex", vendor: "openai" };
		const llm = await model(request => {
			if (request.workload === "station-start-check") return { content: { ids: ["C", "A", "outside", "C", "D"] }, responder: first };
			return request.call === 1 ? { content: { wrong: [] }, responder: first }
				: { content: { ids: ["A", "B", "C"] }, responder: request.call === 2 ? usable : first };
		});
		const result = await chooseNightlySessionStart(store, llm);
		expect.soft(result).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect.soft(["A", "B", "C", "D"].map(id => metadata(id).start_rank)).toEqual([1, 0, 2, 0]);
		const checks = byWorkload("station-start-check");
		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({ callId: "E23", hostTarget: { otherVendorThan: usable } });
		const ranked = ["A", "B", "C"].map(id => ({ id, text: store.getById(id)?.text }));
		const instruction = byWorkload("station-start-pick")[0]?.prompt.split("\n").slice(0, -1).join("\n");
		expect(checks[0]?.prompt).toBe(`Another model already chose the list below. Check it: ${instruction}\nReturn the ids of the memories below that qualify; leave out every one that does not.\n${JSON.stringify(ranked)}`);
	});

	it("still checks when the usable picks report no responder and allows the check to reject every id", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core" });
		const llm = await model(request => ({ content: { ids: request.workload === "station-start-check" ? [] : ["B", "A"] } }));
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect.soft(["A", "B"].map(id => metadata(id).start_rank)).toEqual([0, 0]);
		expect(byWorkload("station-start-check")).toHaveLength(1);
		expect(byWorkload("station-start-check")[0]?.hostTarget).toBeUndefined();
	});

	it.each(["transport", "invalid-json", "invalid-schema"])("keeps previous ranks and logs an unusable %s check", async failure => {
		plant("A", { start_label: "core", start_rank: 2 });
		plant("B", { start_label: "core", start_rank: 1 });
		plant("C", { start_label: "core", start_rank: 0 });
		plant("D", { start_label: "core" });
		const previous = ["A", "B", "C", "D"].map(id => metadata(id));
		const stderr = vi.spyOn(process.stderr, "write");
		const llm = await model(request => {
			if (request.workload !== "station-start-check") return { content: { ids: ["D", "C", "A"] } };
			return failure === "transport" ? { status: 500, content: null }
				: failure === "invalid-json" ? { raw: "not JSON", content: null } : { content: { ids: 42 } };
		});
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect.soft(["A", "B", "C", "D"].map(id => metadata(id))).toEqual(previous);
		expect.soft(byWorkload("station-start-check")).toHaveLength(1);
		expect(stderr.mock.calls.map(args => String(args[0])).join("\n")).toContain("session-start-check");
	});

	it("skips the check when usable picks have no ranked ids and clears old ranks", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core" });
		const llm = await model(() => ({ content: { ids: [] } }));
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 3 });
		expect(byWorkload("station-start-check")).toEqual([]);
		expect(["A", "B"].map(id => metadata(id).start_rank)).toEqual([0, 0]);
	});

	it("re-picks every place once in a full wave and uses the journal to skip its next pass", async () => {
		plant("shared", { start_label: "core", start_rank: 1 });
		plant("project-a", { start_label: "core", start_rank: 1 }, "work-project");
		plant("project-b", { start_label: "core", start_rank: 0 }, "work-project");
		const llm = await model(request => ({ content: { ids: request.rows.some(row => row.id === "shared") ? ["shared"] : ["project-b", "project-a"] } }));
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "full-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 8 });
		expect.soft(["project-b", "project-a"].map(id => metadata(id).start_rank)).toEqual([1, 2]);
		const completions = () => fixture.runtime.db.prepare(`SELECT json_extract(detail, '$.projectId') AS project
			FROM nodix_rem_journal WHERE job_id = 'full-wave' AND stage = 'session-start' AND outcome = 'fine' ORDER BY project`).all();
		expect.soft(completions()).toEqual([{ project: "global" }, { project: "work-project" }]);
		await store.close();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "full-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 0 });
		expect.soft(completions()).toEqual([{ project: "global" }, { project: "work-project" }]);
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "another-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 8 });
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "nightly", full: false })).toEqual({ labelCalls: 0, pickCalls: 0 });
	});

	it("retries a place in the same full wave when its check was unusable", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		const llm = await model(request => request.workload === "station-start-check" && request.call === 1
			? { content: { invalid: true } } : { content: { ids: ["A"] } });
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "retry-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect.soft(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_rem_journal WHERE job_id = 'retry-wave' AND stage = 'session-start' AND outcome = 'fine'").get()).toEqual({ rows: 0 });
		expect.soft(await chooseNightlySessionStart(store, llm, { waveId: "retry-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect.soft(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_rem_journal WHERE job_id = 'retry-wave' AND stage = 'session-start' AND outcome = 'fine'").get()).toEqual({ rows: 1 });
		expect(await chooseNightlySessionStart(store, llm, { waveId: "retry-wave", full: true })).toEqual({ labelCalls: 0, pickCalls: 0 });
	});

	it("stores two-vote labels, asks a third time for a split batch and leaves a three-way split unlabelled", async () => {
		for (const id of ["A", "B", "C"]) plant(id);
		const votes: Record<string, string[]> = { A: ["core", "core", "core"], B: ["topic", "drop", "topic"], C: ["core", "drop", "topic"] };
		const llm = await model(request => {
			if (request.workload !== "station-start-label") return { content: { ids: ["A"] } };
			const rows = request.rows.map(row => ({ id: row.id, label: votes[row.id]?.[request.call - 1] }));
			return { content: request.call === 3 ? rows : { rows } };
		});
		const result = await chooseNightlySessionStart(store, llm);
		expect(result).toEqual({ labelCalls: 3, pickCalls: 4 });
		expect(byWorkload("station-start-label")).toHaveLength(3);
		expect(metadata("A")).toMatchObject({ start_label: "core", start_rank: 1, precision_kind: "rule", writer_agent_id: "codex" });
		expect(metadata("B")).toMatchObject({ start_label: "topic" });
		expect(metadata("B")).not.toHaveProperty("start_rank");
		expect(metadata("C")).not.toHaveProperty("start_label");
		expect(metadata("C")).not.toHaveProperty("start_rank");
	});

	it("ranks core rows chosen at least twice by their average returned position", async () => {
		for (const id of ["A", "B", "C", "D"]) plant(id, { start_label: "core" });
		const choices = [["A", "B", "C"], ["B", "D", "A"], ["D", "B", "A"]];
		const llm = await model(request => ({ content: { ids: request.workload === "station-start-check" ? request.rows.map(row => row.id) : choices[request.call - 1] } }));
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 4 });
		expect(byWorkload("station-start-label")).toEqual([]);
		expect(byWorkload("station-start-pick").map(request => request.rows.map(row => row.id).sort()))
			.toEqual(Array.from({ length: 3 }, () => ["A", "B", "C", "D"]));
		expect(["D", "B", "A"].map(id => metadata(id).start_rank)).toEqual([1, 2, 3]);
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
		expect(byWorkload("station-start-check").map(request => request.rows.map(row => row.id))).toEqual([ids.slice(0, 12)]);
	});

	it("ranks only 12 shared core rows after aggregating three pairwise-overlapping replies", async () => {
		const ids = Array.from({ length: 18 }, (_, index) => `shared-${index + 1}`);
		for (const id of ids) plant(id, { start_label: "core" });
		const choices = [ids.slice(0, 12), [...ids.slice(0, 6), ...ids.slice(12)], ids.slice(6)];
		const llm = await model(request => ({ content: { ids: request.workload === "station-start-check" ? request.rows.map(row => row.id) : choices[request.call - 1] } }));
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
		expect(byWorkload("station-start-check").map(request => request.rows.map(row => row.id))).toEqual([ids.slice(0, 10)]);
	});

	it("picks an already labelled list again when a core row has never been ranked", async () => {
		plant("A", { start_label: "core", start_rank: 1 });
		plant("B", { start_label: "core", start_rank: 2 });
		plant("C", { start_label: "core", start_rank: 0 });
		plant("D", { start_label: "core" });
		const llm = await model(() => ({ content: { ids: ["D", "A", "B"] } }));
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 4 });
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
		expect.soft(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 0, pickCalls: 4 });
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
		expect(await chooseNightlySessionStart(store, llm)).toEqual({ labelCalls: 6, pickCalls: 12 });
		for (const [workload, count] of [["station-start-label", 2], ["station-start-pick", 3], ["station-start-check", 1]] as const) {
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
