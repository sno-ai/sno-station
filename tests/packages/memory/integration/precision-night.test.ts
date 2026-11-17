/** Daily entry -> real encrypted SQLite/chunks -> persisted nightly effects.
 * Only the external host model is scripted, by the request's call id.
 * E23 checks session-start choices with {ids}, confirms admission deletions with {rows:[{id,confirmed}]}, other changes with {confirmed:boolean}; E24 writes {text:string}.
 * Merge checks use the existing E22 rewrite-verification fields. No production step is supplied by the harness.
 */
import { createHash } from "node:crypto";
import { NightBudgetExhausted, precisionNightBudget, runPrecisionNightSteps } from "../../../../packages/memory/src/engine/precision-night";
import { precisionCandidates } from "../../../../packages/memory/src/engine/extraction/precision-write-judgement";
import type { LlmClient } from "../../../../packages/memory/src/model/llm-client";
import * as llmClient from "../../../../packages/memory/src/model/llm-client";
import { HOST_MODEL_CONCURRENCY } from "../../../../packages/memory/config/coding-skin";
import { WORK_MEMORY_ADMISSION } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectiveLogLevel, setLogLevel } from "@snoai/utils/logger";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSchema, type Settings } from "../../../../packages/memory/config/settings";
import type { AgentLlmPort, AgentLlmRequest } from "../../../../packages/memory/src/model/agent-llm-port";
import { runPrecisionNightly } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

type Relation = "unrelated" | "same" | "replaces" | "overlaps" | "maybe-replaces";
type Fact = { index: number; text: string; rows: Array<{ id: string; text: string }> };
type Journal = { stage: string; job_type: string; outcome: string; row_id: string | null; reason: string | null; detail: string | null };
const oldPort = "The owner requires the service to use port 8070.";
const newPort = "The owner requires the service to use port 8090.";
const firstPart = "The owner requires all service reports to be written in Chinese.";
const secondPart = "The owner requires all service reports to explain the cause of failures.";
const mergedSentence = "Write service reports in Chinese and explain failure causes.";
const duplicateVariants = [
	{ preference: "owner over assistant", keptProject: "global", removedProject: "global", assistant: true, keptTime: 1_794_643_200_000, removedTime: 1_794_556_800_000 },
	{ preference: "shared over project", keptProject: "global", removedProject: "work-project", assistant: false, keptTime: 1_794_643_200_000, removedTime: 1_794_556_800_000 },
	{ preference: "earlier owner in one scope", keptProject: "global", removedProject: "global", assistant: false, keptTime: 1_794_556_800_000, removedTime: 1_794_643_200_000 },
];
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let settings: Settings;
let agentPort: AgentLlmPort;
let judge: (fact: Fact, neighbour: Fact["rows"][number]) => Relation;
let pairCheck: boolean | "unreachable";
let changeCheck: boolean;
let mergeText: string;
let mergeFaithful: boolean;
let mergeAccounted: boolean;
let checkingMerge: boolean;
let deleteIds: string[];
let throwCall: string | undefined;
let sourceReply: { action: "keep" | "correct" | "remove"; text: string };
let modelCalls: AgentLlmRequest[];
let placeMode: "work" | "chat" | "unsure";

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(() => {
	database = createTestDb();
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	settings = settingsSchema.parse(writeSettingsFixture(dirname(database.dbPath), {
		mode: "agent-native", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		telemetry: { memoryUsage: { enabled: false } },
	}).settings);
	vi.spyOn(Date, "now").mockReturnValue(1_794_729_600_000);
	judge = () => "unrelated"; pairCheck = true; changeCheck = true;
	mergeText = mergedSentence; mergeFaithful = true; mergeAccounted = true; checkingMerge = false;
	deleteIds = []; throwCall = undefined; sourceReply = { action: "keep", text: "" };
	modelCalls = [];
	placeMode = "work";
	agentPort = { async complete(request: AgentLlmRequest) {
		modelCalls.push(request);
		const id = String(request.callId);
		if (id === throwCall) throw new Error("fixture admission step exploded");
		if (id === "E22" && pairCheck === "unreachable") {
			return { kind: "error", category: "transport", message: "fixture checking side unreachable" };
		}
		let reply: unknown;
		switch (id) {
			case "E13": reply = { mode: placeMode }; break;
			case "E14": {
				const data = payload(request.prompt) as { rows: Array<{ id: string }> };
				reply = { rows: data.rows.map(row => ({ id: row.id, scope: "project" })) }; break;
			}
			case "E16": {
				const data = payload(request.prompt) as Array<{ id: string }>;
				reply = { rows: data.map(row => deleteIds.includes(row.id)
					? { id: row.id, verdict: "delete", reason: "activity record" }
					: { id: row.id, verdict: "keep", kind: metadata(row.id).precision_kind ?? "rule", origin: metadata(row.id).asserted_by === "assistant" ? "assistant" : "owner", about_user: false }) }; break;
			}
			case "E19": {
				const data = payload(request.prompt) as Array<{ id: string }>;
				reply = { rows: data.map(row => ({ id: row.id, label: "core" })) }; break;
			}
			case "E20": {
				const data = payload(request.prompt) as Array<{ id: string }>;
				reply = { ids: data.map(row => row.id) }; break;
			}
			case "E21": {
				const data = payload(request.prompt) as { facts?: Fact[]; rows?: Array<{ id: string }> };
				if (data.rows) { reply = { rows: data.rows.map(row => ({ id: row.id, ...sourceReply })) }; break; }
				if (!data.facts) throw new Error("Missing facts in relation request");
				reply = { facts: data.facts.map(fact => ({ index: fact.index,
					rows: fact.rows.map(row => ({ id: row.id, relation: judge(fact, row) })) })) }; break;
			}
			case "E22": reply = checkingMerge
				? { faithful: mergeFaithful, retired_absent: true, all_facts_accounted: mergeAccounted }
				: { replaces: pairCheck }; break;
			case "E23": {
				if (request.prompt.startsWith("Another model already chose the list below.")) {
					const rows = payload(request.prompt) as Array<{ id: string }>;
					reply = { ids: rows.map(row => row.id) }; break;
				}
				const data = payload(request.prompt) as { operation: string; rows: Array<{ id: string }> };
				reply = data.operation === "admission deletion"
					? { rows: data.rows.map(row => ({ id: row.id, confirmed: changeCheck })) }
					: { confirmed: changeCheck }; break;
			}
			case "E24": reply = { text: mergeText }; break;
			default: throw new Error(`Unexpected nightly model call ${id}`);
		}
		return { kind: "ok", text: JSON.stringify(reply) };
	} };
});
afterEach(async () => {
	try { await store?.close(); database?.cleanup(); }
	finally { vi.restoreAllMocks(); }
});

function payload(prompt: string): unknown { return JSON.parse(prompt.trimEnd().split("\n").at(-1) ?? "null"); }
async function plant(id: string, text: string, timestamp = 1_794_556_800_000,
	metadata: Record<string, unknown> = {}, projectId = "global", category: "episodic" | "profile" = "episodic") {
	const written = await store.store({ text, category, projectId, timestamp,
		...(category === "profile" ? { trusted: true } : {}),
		metadata: JSON.stringify({ precision_kind: "rule", precision_judged: true,
			writer_agent_id: "codex", start_label: "topic", source_order: {
				valid_from: null, session_moment: timestamp, session_ordinal: 0,
				global_turn_index: 0, rowid: 0, conversation_id: id,
			}, ...metadata }) });
	// Retain real chunks and vectors, using the existing duplicate-test fixture's literal ids.
	database.sqlite.transaction(() => {
		database.sqlite.exec("PRAGMA defer_foreign_keys = ON");
		database.sqlite.prepare("UPDATE nodix_memories SET id = ?, fact_id = ? WHERE id = ?").run(id, id, written.id);
		database.sqlite.prepare("UPDATE nodix_memory_chunks SET memory_id = ? WHERE memory_id = ?").run(id, written.id);
		database.sqlite.prepare("UPDATE nodix_rem_memory_facets SET memory_id = ? WHERE memory_id = ?").run(id, written.id);
		database.sqlite.prepare("UPDATE nodix_rem_census_rows SET row_id = ? WHERE row_id = ?").run(id, written.id);
	})();
}
function metadata(id: string): Record<string, unknown> { return JSON.parse(store.getById(id)?.metadata ?? "{}"); }
function ids() {
	return (database.sqlite.prepare("SELECT id FROM nodix_memories ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
}
function journal(wave: string): Journal[] {
	return database.sqlite.prepare("SELECT stage, job_type, outcome, row_id, reason, detail FROM nodix_rem_journal WHERE job_id = ? ORDER BY sequence").all(wave) as Journal[];
}
function outcome(wave: string, value: string, scope: string, rowIds: string[]) {
	const entries = journal(wave).filter(entry => {
		const detail = JSON.parse(entry.detail ?? "{}");
		return entry.outcome === value && detail.scope === scope
			&& (value !== "fine" || entry.stage === "pairs")
			&& rowIds.every(id => detail.rows?.includes(id));
	});
	expect.soft(entries.map(entry => ({ job_type: entry.job_type, outcome: entry.outcome,
		scope: JSON.parse(entry.detail ?? "{}").scope })), `${value} journal, including rows and scope`)
		.toEqual([{ job_type: "precision-nightly", outcome: value, scope }]);
}
async function night(waveId: string, connected = true) {
	// The daily entry dispatches precision work even with no older operations.
	await runPrecisionNightly({ settings, mode: "agent-native", ...(connected ? { agentPort } : {}),
		waveId });
}
function nextNight() {
	database.sqlite.prepare("DELETE FROM nodix_memory_migration_markers WHERE name = 'memory-precision-last-night'").run();
	vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
}
async function replacement() {
	await plant("stale-port", oldPort);
	await plant("pending-port", newPort, 1_794_643_200_000, { precision_check: "pending" });
	judge = (fact, row) => fact.text === newPort && row.id === "stale-port" ? "replaces" : "unrelated";
}
function openPorts() {
	expect.soft(ids()).toEqual(["pending-port", "stale-port"]);
	for (const id of ["pending-port", "stale-port"]) {
		expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
		expect.soft(metadata(id)).not.toHaveProperty("supersede_reason");
	}
}
async function mergePair(recorded = false) {
	checkingMerge = true;
	await plant("report-language", firstPart);
	await plant("report-causes", secondPart, 1_794_643_200_000,
		recorded ? { precision_recheck_with: ["report-language"] } : {});
	judge = (fact, row) => [firstPart, secondPart].includes(fact.text)
		&& ["report-language", "report-causes"].includes(row.id) ? "overlaps" : "unrelated";
}
function unchangedMergeSources() {
	expect.soft(ids()).toEqual(["report-causes", "report-language"]);
	expect.soft(store.getById("report-language")?.text).toBe(firstPart);
	expect.soft(store.getById("report-causes")?.text).toBe(secondPart);
	for (const id of ["report-language", "report-causes"]) expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
}
async function followingStep() {
	await plant("next-step", "The owner requires concise explanations of service failures.",
		1_794_556_800_000, { start_label: undefined });
}
function followingStepRan() { expect.soft(metadata("next-step")).toMatchObject({ start_label: "core", start_rank: 1 }); }

describe("precision night through the public daily entry", () => {
	it.each([
		{ reply: "unsure", stored: undefined, work: true },
		{ reply: "chat", stored: undefined, work: false },
		{ reply: "chat", stored: "work", work: true },
		{ reply: "work", stored: "chat", work: false },
	] as const)("place-mode: $reply with stored $stored runs nightly work: $work", async ({ reply, stored, work }) => {
		const place = { skinId: "codex", projectId: "routine-checks", surface: "" };
		const older = "Check every 10 minutes.";
		const newer = "The routine check runs every 8 hours.";
		await plant("old-check", older, 1_794_556_800_000, {}, place.projectId);
		await plant("new-check", newer, 1_794_643_200_000, {}, place.projectId);
		if (stored !== undefined) store.setPlaceMode({ ...place, mode: stored, decidedAt: Date.now() });
		placeMode = reply;
		// This fixture's only two rows are a confirmed replacement; no text rule judges their meaning.
		judge = () => "replaces";
		await night("place-mode-first");

		expect.soft(store.getPlaceMode(place)).toBe(stored ?? (reply === "unsure" ? undefined : reply));
		expect.soft(modelCalls.filter(call => call.callId === "E13")).toHaveLength(stored === undefined ? 1 : 0);
		expect.soft(journal("place-mode-first").filter(entry => entry.stage === "place-mode")
			.map(entry => ({ outcome: entry.outcome, rows: JSON.parse(entry.detail ?? "{}").rows.sort() })))
			.toEqual(reply === "unsure" ? [{ outcome: "undecided", rows: ["new-check", "old-check"] }] : []);
		if (work) {
			expect.soft(metadata("old-check")).toMatchObject({ superseded_by: "new-check", supersede_reason: "night" });
			expect.soft(store.readActivePrecisionRows(place.projectId).map(row => row.id)).toEqual(["new-check"]);
			outcome("place-mode-first", "replaced", "project", ["old-check", "new-check"]);
		} else {
			expect.soft(store.readActivePrecisionRows(place.projectId).map(row => row.id).sort()).toEqual(["new-check", "old-check"]);
			for (const id of ["old-check", "new-check"]) {
				expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
				expect.soft(metadata(id)).not.toHaveProperty("precision_night");
			}
			expect.soft(modelCalls.filter(call => ["E16", "E21", "E22", "E23"].includes(String(call.callId)))).toEqual([]);
		}

		if (reply === "unsure") {
			modelCalls = []; nextNight();
			await night("place-mode-second");
			expect.soft(modelCalls.filter(call => call.callId === "E13")).toHaveLength(1);
			expect.soft(store.getPlaceMode(place)).toBeUndefined();
			expect.soft(journal("place-mode-second").filter(entry => entry.stage === "place-mode")
				.map(entry => entry.outcome)).toEqual(["undecided"]);
		}
	});

	it("merge: realistic profile metadata produces one open row and closes both sources", async () => {
		checkingMerge = true;
		for (const [id, text, timestamp] of [
			["report-language", firstPart, 1_794_464_564_076],
			["report-causes", secondPart, 1_794_643_200_000],
		] as const) {
			await plant(id, text, timestamp, {
				kind: "profile", precision_kind: "rule", memory_category: "profile",
				ends_current: false, todo: "none", valid_from: timestamp,
				time_instruction: { kind: "none" }, ended_time_instruction: { kind: "none" },
				temporal_resolution_status: "static", value: text, importance_label: "high",
				source_span: { turnIndex: 0, quote: text, startOffset: 0, endOffset: text.length },
				section_name: "unkeyed.profile", keying_note: "keying-unmatched", writer_agent_id: "claude-code",
				source_fact_key: JSON.stringify([id]), source_chunk_key: `chunk-${id}`, idempotency_key: `capture-${id}`,
				source_order: { valid_from: timestamp, session_moment: timestamp, session_ordinal: 2201,
					global_turn_index: 0, rowid: 37537, conversation_id: `conversation-${id}` },
			}, "global", "profile");
		}
		judge = () => "overlaps";
		await night("realistic-merge");
		expect.soft(database.sqlite.prepare(`SELECT text, json_extract(metadata, '$.section_name') AS section_name
			FROM nodix_memories WHERE json_extract(metadata, '$.superseded_by') IS NULL`).all())
			.toEqual([{ text: mergedSentence, section_name: "unkeyed.profile" }]);
		expect.soft(database.sqlite.prepare(`SELECT source.id, json_extract(source.metadata, '$.supersede_reason') AS reason,
			successor.text FROM nodix_memories source JOIN nodix_memories successor
			ON successor.id = json_extract(source.metadata, '$.superseded_by') ORDER BY source.id`).all()).toEqual([
			{ id: "report-causes", reason: "merge", text: mergedSentence },
			{ id: "report-language", reason: "merge", text: mergedSentence },
		]);
		expect.soft(journal("realistic-merge").filter(entry => entry.stage === "merge")
			.map(entry => ({ outcome: entry.outcome, reason: entry.reason })))
			.toEqual([{ outcome: "merged", reason: null }]);
	});

	it("merge: a merged-row write error is journaled failed rather than undecided", async () => {
		await mergePair();
		database.sqlite.exec(`CREATE TRIGGER fail_merged_insert BEFORE INSERT ON nodix_memories
			WHEN new.text = 'Write service reports in Chinese and explain failure causes.'
			BEGIN SELECT RAISE(ABORT, 'fixture merged row write failed'); END`);
		await night("merge-write-error");
		unchangedMergeSources();
		expect.soft(journal("merge-write-error").filter(entry => entry.stage === "merge")
			.map(entry => ({ outcome: entry.outcome, reason: entry.reason })))
			.toEqual([{ outcome: "failed", reason: "fixture merged row write failed" }]);
	});

	it("duplicate refusal: marks the row checked and makes no relation call next night", async () => {
		await plant("refusal-first", firstPart);
		await plant("refusal-second", secondPart);
		judge = () => "same"; changeCheck = false;
		await night("refusal-first-night");
		for (const id of ["refusal-first", "refusal-second"]) {
			expect.soft(metadata(id).precision_night).toEqual({ at: 1_794_729_600_000,
				text: store.getById(id)?.contentHash });
			expect.soft(metadata(id)).not.toHaveProperty("precision_recheck_with");
		}
		expect.soft(modelCalls.filter(call => call.callId === "E23")).toHaveLength(1);
		modelCalls = []; nextNight();
		await night("refusal-second-night");
		expect.soft(modelCalls.filter(call => call.callId === "E21")).toEqual([]);
		expect.soft(ids()).toEqual(["refusal-first", "refusal-second"]);
	});

	it("relation call failure: leaves the row unchecked and judges it again next night", async () => {
		await plant("retry-first", firstPart);
		await plant("retry-second", secondPart);
		throwCall = "E21";
		await night("relation-error-first");
		expect(metadata("retry-first")).not.toHaveProperty("precision_night");
		expect(journal("relation-error-first").filter(entry => entry.stage === "pairs" && entry.outcome === "failed")
			.map(entry => entry.row_id).sort()).toEqual(["retry-first", "retry-second"]);
		throwCall = undefined; modelCalls = []; nextNight();
		await night("relation-error-second");
		const judged = modelCalls.filter(call => call.callId === "E21").flatMap(call =>
			(payload(call.prompt) as { facts: Fact[] }).facts.map(fact => fact.text));
		expect(judged.sort()).toEqual([firstPart, secondPart].sort());
		for (const id of ["retry-first", "retry-second"]) expect(metadata(id)).toHaveProperty("precision_night.at", 1_794_816_000_000);
	});

	it("relation batches: 16 due rows with unrelated neighbours use two E21 calls", async () => {
		for (let index = 0; index < 16; index += 1) {
			await plant(`batch-${index}`, `The owner requires service report archive number ${index} to include Chinese summaries.`);
		}
		await night("relation-batches");
		const calls = modelCalls.filter(call => call.callId === "E21");
		expect.soft(calls).toHaveLength(2);
		expect.soft(calls.map(call => (payload(call.prompt) as { facts: Fact[] }).facts.length)).toEqual([8, 8]);
		expect.soft(database.sqlite.prepare(`SELECT count(*) AS checked FROM nodix_memories
			WHERE json_extract(metadata, '$.precision_night.at') = 1794729600000`).get()).toEqual({ checked: 16 });
	});

	it.each(["missing", "repeated", "unshown"] as const)("relation batches: a %s row answer fails only that row", async invalid => {
		for (let index = 0; index < 8; index += 1) {
			await plant(`isolated-${index}`, `The owner requires service report archive number ${index} to include Chinese summaries.`);
		}
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId !== "E21") return complete(request);
			modelCalls.push(request);
			const data = payload(request.prompt) as { facts: Fact[] };
			return { kind: "ok", text: JSON.stringify({ facts: data.facts.flatMap(fact => {
				const answer = { index: fact.index, rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })) };
				if (fact.text !== "The owner requires service report archive number 0 to include Chinese summaries.") return [answer];
				if (invalid === "missing") return [];
				if (invalid === "repeated") return [answer, answer];
				return [{ ...answer, rows: [{ id: "not-shown", relation: "unrelated" }, ...answer.rows.slice(1)] }];
			}) }) };
		};
		await night(`isolated-${invalid}`);
		expect.soft(modelCalls.filter(call => call.callId === "E21")).toHaveLength(1);
		expect.soft(metadata("isolated-0")).not.toHaveProperty("precision_night");
		for (let index = 1; index < 8; index += 1) expect.soft(metadata(`isolated-${index}`))
			.toHaveProperty("precision_night.at", 1_794_729_600_000);
		expect.soft(journal(`isolated-${invalid}`).filter(entry => entry.stage === "pairs" && entry.outcome === "failed")
			.map(entry => entry.row_id)).toEqual(["isolated-0"]);
	});

	it.each([false, true])("source batches: eight quoted rows use one E21 call, unreadable row %s", async unreadable => {
		for (let index = 0; index < 8; index += 1) {
			const text = `The owner requires service report archive number ${index} to include Chinese summaries.`;
			await plant(`quoted-${index}`, text, 1_794_556_800_000, { source_span: { quote: text } });
		}
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId !== "E21" || (payload(request.prompt) as { facts?: Fact[] }).facts) return complete(request);
			modelCalls.push(request);
			return { kind: "ok", text: JSON.stringify({ rows: Array.from({ length: 8 }, (_, index) => ({
				id: `quoted-${index}`, action: unreadable && index === 0 ? "unreadable" : "keep", text: "",
			})) }) };
		};
		await night("source-batch");
		const sourceCalls = modelCalls.filter(call => call.callId === "E21" && !(payload(call.prompt) as { facts?: Fact[] }).facts);
		expect.soft(sourceCalls).toHaveLength(1);
		expect.soft((payload(sourceCalls[0]?.prompt ?? "null") as { rows?: unknown[] })?.rows).toHaveLength(8);
		for (let index = unreadable ? 1 : 0; index < 8; index += 1) expect.soft(metadata(`quoted-${index}`))
			.toHaveProperty("precision_night.at", 1_794_729_600_000);
		if (unreadable) {
			expect.soft(metadata("quoted-0")).not.toHaveProperty("precision_night");
			expect.soft(journal("source-batch").filter(entry => entry.outcome === "failed").map(entry => entry.row_id))
				.toEqual(["quoted-0"]);
		}
		expect.soft(ids()).toHaveLength(8);
	});

	it.each(["loaded-files", "pending"] as const)(
		"budget ends inside %s: defers three rows once without failed work", async stage => {
			const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
			for (let index = 0; index < 103; index += 1) {
				const text = `The invented Juniper archive stores release record number ${index}.`;
				await plant(`deferred-${String(index).padStart(3, "0")}`, text, 1_794_556_800_000, {
					precision_kind: "fact", precision_admission: admitted,
					...(stage === "pending" ? { precision_check: "pending" } : {}),
					...(stage === "loaded-files" ? { precision_night: {
						at: 1_794_729_600_000, text: createHash("sha256").update(text).digest("hex"),
					} } : {}),
				});
			}
			const files = ["CLAUDE.md", "AGENTS.md"].map(name => {
				const text = "Keep release reports concise.";
				const path = join(dirname(database.dbPath), name);
				writeFileSync(path, text);
				return { path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
			});
			store.setPlaceLoadedFiles({ skinId: "codex", projectId: "global", surface: "", files, updatedAt: 1_794_729_600_000 });
			const complete = agentPort.complete.bind(agentPort);
			agentPort.complete = async request => {
				if (request.callId !== "E15") return complete(request);
				const data = payload(request.prompt) as { rows: Array<{ id: string }> };
				return { kind: "ok", text: JSON.stringify({ rows: data.rows.map(row => ({ id: row.id, quote: "", verdict: "not-said" })) }) };
			};
			const lines: string[] = [];
			const level = effectiveLogLevel();
			setLogLevel("info");
			const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
			try { await night(`exhausted-${stage}`); }
			finally { output.mockRestore(); setLogLevel(level); }

			expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories").get()).toEqual({ rows: 103 });
			if (stage === "loaded-files") {
				expect.soft(database.sqlite.prepare(`SELECT count(*) AS remaining FROM nodix_memories m
					WHERE NOT EXISTS (SELECT 1 FROM nodix_loaded_file_judgments j WHERE j.memory_id = m.id)`).get())
					.toEqual({ remaining: 3 });
				expect.soft(database.sqlite.prepare("SELECT count(*) AS judged FROM nodix_loaded_file_judgments").get()).toEqual({ judged: 200 });
			} else {
				expect.soft(database.sqlite.prepare("SELECT count(*) AS remaining FROM nodix_memories WHERE json_extract(metadata, '$.precision_night') IS NULL").get())
					.toEqual({ remaining: 3 });
				expect.soft(database.sqlite.prepare("SELECT count(*) AS judged FROM nodix_loaded_file_judgments").get()).toEqual({ judged: 0 });
			}
			const entries = journal(`exhausted-${stage}`);
			expect.soft(entries.filter(entry => entry.outcome === "failed")).toEqual([]);
			const logs = lines.flatMap(line => line.split("\n")).filter(line => line.startsWith("{"))
				.map(line => JSON.parse(line) as { severity_text: string; body: string; attributes: unknown });
			expect.soft(logs.filter(record => record.severity_text === "ERROR")).toEqual([]);
			const notices = [
				...logs.filter(record => record.severity_text === "INFO" && /budget|next night/i.test(JSON.stringify(record))),
				...entries.filter(entry => entry.outcome !== "failed" && /budget|next night/i.test(entry.reason ?? "")),
			];
			expect.soft(notices).toHaveLength(1);
			expect.soft(JSON.stringify(notices)).toMatch(/\b3\b/);
			expect.soft(JSON.stringify(notices)).toContain("next night");
		});

	it("admits 39 rows from a mixed 40-row E16 batch and leaves only the unreadable row undecided", async () => {
		const replies = [
			{ id: "kind-rule", verdict: "rule", kind: "rule", origin: "owner", about_user: true },
			{ id: "kind-decision", verdict: "decision", origin: "owner", about_user: false },
			{ id: "kind-fact", verdict: "fact", origin: "owner", about_user: false },
			{ id: "kind-pitfall", verdict: "pitfall", origin: "owner", about_user: false },
			{ id: "kind-person", verdict: "person", origin: "owner", about_user: true },
			{ id: "delete-activity", verdict: "activity record", reason: "activity record" },
			{ id: "delete-fragment", verdict: "fragment", reason: "fragment" },
			{ id: "delete-not-kind", verdict: "not one of the kinds" },
			{ id: "delete-personal", verdict: "personal and unrelated to work" },
			{ id: "unreadable", verdict: "???" },
			...Array.from({ length: 30 }, (_, index) => ({ id: `ordinary-${index}`, verdict: "keep", kind: "rule", origin: "owner", about_user: false })),
		];
		for (const reply of replies) await plant(reply.id, `The invented Alder report for ${reply.id} must explain a distinct service failure.`,
			1_794_556_800_000, { precision_kind: undefined, precision_judged: undefined });
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId === "E16") return { kind: "ok", text: JSON.stringify({ rows: replies }) };
			if (request.callId === "E23") {
				const data = payload(request.prompt) as { rows: Array<{ id: string }> };
				return { kind: "ok", text: JSON.stringify({ confirmed: true, rows: data.rows.map(row => ({ id: row.id, confirmed: true })) }) };
			}
			return complete(request);
		};
		await night("mixed-admission");
		expect.soft(database.sqlite.prepare(`SELECT id, json_extract(metadata, '$.precision_kind') AS kind,
			json_extract(metadata, '$.precision_judged') AS judged FROM nodix_memories WHERE id LIKE 'kind-%' ORDER BY id`).all()).toEqual([
			{ id: "kind-decision", kind: "decision", judged: 1 }, { id: "kind-fact", kind: "fact", judged: 1 },
			{ id: "kind-person", kind: "person", judged: 1 }, { id: "kind-pitfall", kind: "pitfall", judged: 1 },
			{ id: "kind-rule", kind: "rule", judged: 1 },
		]);
		expect.soft(database.sqlite.prepare("SELECT id FROM nodix_memories WHERE id LIKE 'delete-%'").all()).toEqual([]);
		expect.soft(database.sqlite.prepare("SELECT count(*) AS kept FROM nodix_memories WHERE json_extract(metadata, '$.precision_admission') IS NOT NULL").get()).toEqual({ kept: 35 });
		expect.soft(store.getById("unreadable")?.text).toBe("The invented Alder report for unreadable must explain a distinct service failure.");
		expect.soft(metadata("unreadable")).not.toHaveProperty("precision_admission");
		expect.soft(metadata("unreadable")).not.toHaveProperty("precision_judged");
		expect.soft(journal("mixed-admission").filter(entry => entry.stage === "admission")
			.reduce((counts, entry) => ({ ...counts, [entry.outcome]: (counts[entry.outcome] ?? 0) + 1 }), {} as Record<string, number>))
			.toEqual({ fine: 35, removed: 4, undecided: 1 });
		expect.soft(journal("mixed-admission").filter(entry => entry.stage === "admission" && entry.outcome === "undecided")
			.map(entry => entry.row_id)).toEqual(["unreadable"]);
	});

	it("confirms 30 proposed admission deletions in at most two batches and preserves the row omitted from confirmation", async () => {
		for (let index = 0; index < 30; index += 1) {
			const id = `batch-delete-${String(index).padStart(2, "0")}`;
			await plant(id, `The invented Birch export task printed temporary report ${index}.`, 1_794_556_800_000,
				{ precision_kind: undefined, precision_judged: undefined });
			deleteIds.push(id);
		}
		const confirmations: string[][] = [];
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId !== "E23") return complete(request);
			const data = payload(request.prompt) as { rows: Array<{ id: string }> };
			confirmations.push(data.rows.map(row => row.id));
			return { kind: "ok", text: JSON.stringify({ rows: data.rows.filter(row => row.id !== "batch-delete-29")
				.map(row => ({ id: row.id, confirmed: true })) }) };
		};
		await night("batch-deletions");
		expect.soft(confirmations.length).toBeLessThanOrEqual(2);
		expect.soft(confirmations[0]).toHaveLength(30);
		expect.soft(ids()).toEqual(["batch-delete-29"]);
		expect.soft(store.getById("batch-delete-29")?.text).toBe("The invented Birch export task printed temporary report 29.");
		expect.soft(metadata("batch-delete-29")).not.toHaveProperty("precision_admission");
		expect.soft(journal("batch-deletions").filter(entry => entry.stage === "admission" && entry.outcome === "removed")).toHaveLength(29);
		expect.soft(journal("batch-deletions").filter(entry => entry.stage === "admission" && entry.outcome === "undecided")
			.map(entry => entry.row_id)).toEqual(["batch-delete-29"]);
		expect.soft(journal("batch-deletions").filter(entry => entry.outcome === "failed")).toEqual([]);
	});

	it("admits the real E16 bare array while leaving only malformed, missing or repeated rows unjudged", async () => {
		const names = ["kept", "deleted", "bad-kind", "bad-verdict", "missing", "repeated", "bad-confirmation", "after-confirmation"];
		for (const id of names) await plant(id, `The owner requires the ${id} report to include failure causes.`);
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId === "E16") {
				return { kind: "ok", text: JSON.stringify([
					{ id: "kept", verdict: "keep", kind: "rule", origin: "owner", about_user: false },
					{ id: "deleted", verdict: "delete", reason: "fragment" },
					{ id: "bad-kind", verdict: "keep", kind: "commitment", origin: "owner", about_user: false },
					{ id: "bad-verdict", verdict: "discard", reason: "fragment" },
					{ id: "repeated", verdict: "delete", reason: "fragment" },
					{ id: "repeated", verdict: "discard", reason: "fragment" },
					{ id: "bad-confirmation", verdict: "delete", reason: "fragment" },
					{ id: "after-confirmation", verdict: "keep", kind: "rule", origin: "owner", about_user: false },
				]) };
			}
			if (request.callId === "E23" && request.prompt.includes('"id":"bad-confirmation"')) {
				return { kind: "ok", text: '{"rows":[{"id":"deleted","confirmed":true},{"id":"bad-confirmation","confirmed":"invalid"}]}' };
			}
			return complete(request);
		};
		await night("bare-array");
		expect(store.getById("deleted")).toBeUndefined();
		for (const id of ["kept", "after-confirmation"]) {
			expect(metadata(id)).toHaveProperty("precision_admission");
			expect(metadata(id)).toMatchObject({ precision_kind: "rule", precision_judged: true });
		}
		for (const id of ["bad-kind", "bad-verdict", "missing", "repeated", "bad-confirmation"]) {
			expect(store.getById(id)).toBeDefined();
			expect(metadata(id)).not.toHaveProperty("precision_admission");
		}
		expect(journal("bare-array").filter(entry => entry.stage === "admission" && entry.row_id === "bad-confirmation")
			.map(entry => entry.outcome)).toEqual(["undecided"]);
	});

	it("proposes an admission deletion with an unlisted reason, records it verbatim and deletes after confirmation", async () => {
		await plant("duplicate-reason", "The owner requires service reports to include failure causes.",
			1_794_556_800_000, { precision_kind: undefined, precision_judged: undefined });
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => request.callId === "E16"
			? { kind: "ok", text: '{"rows":[{"id":"duplicate-reason","verdict":"delete","reason":"duplicate"}]}' }
			: complete(request);
		await night("unlisted-delete-reason");
		expect.soft(ids()).toEqual([]);
		expect.soft(journal("unlisted-delete-reason").filter(entry => entry.stage === "admission")
			.map(entry => ({ row_id: entry.row_id, outcome: entry.outcome, reason: entry.reason })))
			.toEqual([{ row_id: "duplicate-reason", outcome: "removed", reason: "duplicate" }]);
	});

	it("pending first: confirms replacement, clears pending and journals exactly one shared replacement", async () => {
		await replacement();
		await night("pending-first");
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });
		expect.soft(metadata("pending-port")).not.toHaveProperty("precision_check");
		outcome("pending-first", "replaced", "shared", ["stale-port", "pending-port"]);
		expect.soft(journal("pending-first").filter(entry => entry.outcome === "failed").map(entry => entry.reason)).toEqual([]);
	});

	it.each([true, false])("recorded overlap: merge check %s resolves the recorded pair or journals undecided", async confirmed => {
		await mergePair(true); mergeFaithful = confirmed;
		await night("recorded-overlap");
		if (confirmed) {
			expect.soft(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE id NOT IN ('report-language', 'report-causes')").all())
				.toEqual([{ text: "Write service reports in Chinese and explain failure causes." }]);
			outcome("recorded-overlap", "merged", "shared", ["report-language", "report-causes"]);
		} else {
			unchangedMergeSources();
			outcome("recorded-overlap", "undecided", "shared", ["report-language", "report-causes"]);
		}
	});

	it.each([true, false])("stored task instruction: E23 confirmation %s controls deletion after the backup", async confirmed => {
		await plant("one-task", "For this task only, print the temporary service report.",
			1_794_556_800_000, { precision_kind: undefined, precision_judged: undefined }, "work-project");
		deleteIds = ["one-task"]; changeCheck = confirmed;
		await night("admission");
		if (confirmed) {
			expect.soft(store.getById("one-task")).toBeUndefined();
			const backup = database.sqlite.prepare("SELECT payload FROM nodix_memory_migration_markers WHERE name = 'memory-precision-backup'").get() as { payload: string } | undefined;
			expect.soft(backup === undefined).toBe(false);
			if (backup) {
				database.sqlite.prepare("ATTACH DATABASE ? AS before_night").run(JSON.parse(backup.payload).path);
				try { expect.soft(database.sqlite.prepare("SELECT id, text FROM before_night.nodix_memories").all())
					.toEqual([{ id: "one-task", text: "For this task only, print the temporary service report." }]); }
				finally { database.sqlite.exec("DETACH DATABASE before_night"); }
			}
			outcome("admission", "removed", "project", ["one-task"]);
		} else {
			expect.soft(store.getById("one-task")?.text).toBe("For this task only, print the temporary service report.");
			outcome("admission", "undecided", "project", ["one-task"]);
		}
		if (!confirmed) expect.soft(metadata("one-task")).not.toHaveProperty("precision_admission");
	});

	it("backup failure preserves rows and prevents session-start metadata changes", async () => {
		await plant("one-task", "For this task only, print the temporary report.", 1_794_556_800_000,
			{ precision_kind: undefined, precision_judged: undefined });
		await plant("second-task", "For this task only, list temporary report files.", 1_794_643_200_000,
			{ precision_kind: undefined, precision_judged: undefined });
		await followingStep(); deleteIds = ["one-task", "second-task"];
		writeFileSync(join(dirname(database.dbPath), "sno-station-mem"), "A file prevents creation of the backup directory.");
		await night("backup-failure");
		expect.soft(ids()).toEqual(["next-step", "one-task", "second-task"]);
		expect.soft(database.sqlite.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name = 'memory-precision-backup'").all()).toEqual([]);
		expect.soft(metadata("next-step")).not.toHaveProperty("start_label");
		expect.soft(metadata("next-step")).not.toHaveProperty("start_rank");
	});

	it.each(["deletion", "replacement", "merge", "text correction"] as const)(
		"backup failure preserves all rows and retry marks before %s, with one failed backup journal", async operation => {
			if (operation === "replacement") await replacement();
			else if (operation === "merge") await mergePair(true);
			else if (operation === "text correction") {
				await plant("unsupported", oldPort, 1_794_556_800_000,
					{ precision_check: "pending", source_span: { quote: newPort } });
				sourceReply = { action: "correct", text: newPort };
			} else {
				await plant("one-task", "For this task only, print the temporary report.", 1_794_556_800_000,
					{ precision_kind: undefined, precision_judged: undefined, precision_check: "pending" });
				deleteIds = ["one-task"];
			}
			writeFileSync(join(dirname(database.dbPath), "sno-station-mem"), "A file prevents creation of the backup directory.");
			await night("backup-before-change");

			const rows = database.sqlite.prepare("SELECT id, text FROM nodix_memories ORDER BY id").all();
			if (operation === "replacement") {
				expect.soft(rows).toEqual([
					{ id: "pending-port", text: "The owner requires the service to use port 8090." },
					{ id: "stale-port", text: "The owner requires the service to use port 8070." },
				]);
				expect.soft(metadata("pending-port").precision_check).toBe("pending");
			} else if (operation === "merge") {
				expect.soft(rows).toEqual([
					{ id: "report-causes", text: "The owner requires all service reports to explain the cause of failures." },
					{ id: "report-language", text: "The owner requires all service reports to be written in Chinese." },
				]);
				expect.soft(metadata("report-causes").precision_recheck_with).toEqual(["report-language"]);
			} else if (operation === "text correction") {
				expect.soft(rows).toEqual([{ id: "unsupported", text: "The owner requires the service to use port 8070." }]);
				expect.soft(metadata("unsupported").precision_check).toBe("pending");
			} else {
				expect.soft(rows).toEqual([{ id: "one-task", text: "For this task only, print the temporary report." }]);
				expect.soft(metadata("one-task").precision_check).toBe("pending");
			}
			expect.soft(database.sqlite.prepare(`SELECT count(*) AS changed FROM nodix_memories
				WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL
				OR json_extract(metadata, '$.precision_admission') IS NOT NULL
				OR json_extract(metadata, '$.precision_night') IS NOT NULL`).get()).toEqual({ changed: 0 });
			expect.soft(database.sqlite.prepare(`SELECT outcome,
				lower(stage || ' ' || coalesce(reason, '') || ' ' || coalesce(detail, '')) LIKE '%backup%' AS names_backup
				FROM nodix_rem_journal WHERE job_id = 'backup-before-change' AND outcome = 'failed'`).all())
				.toEqual([{ outcome: "failed", names_backup: 1 }]);
			expect.soft(database.sqlite.prepare(`SELECT outcome FROM nodix_rem_journal
				WHERE job_id = 'backup-before-change' AND outcome IN ('removed', 'replaced', 'merged', 'corrected')`).all()).toEqual([]);
		});

	it.each(duplicateVariants)("duplicate: $preference, confirmation and reference moves in one transaction", async variant => {
		await duplicate(variant);
		await night("duplicate");
		expect.soft(store.getById("duplicate-remove")).toBeUndefined();
		expect.soft(ids()).toEqual(["duplicate-keep", "exception", "historical"]);
		expect.soft(metadata("exception").overrides_shared).toBe("duplicate-keep");
		expect.soft(metadata("historical").superseded_by).toBe("duplicate-keep");
		if (variant.preference === "earlier owner in one scope") {
			expect.soft(metadata("duplicate-keep").source_order).toEqual({ valid_from: null,
				session_moment: 1_794_643_200_000, session_ordinal: 0, global_turn_index: 0,
				rowid: 0, conversation_id: "duplicate-remove" });
		}
		outcome("duplicate", "removed", variant.removedProject === "global" ? "shared" : "project",
			variant.keptProject === variant.removedProject ? ["duplicate-remove", "duplicate-keep"] : ["duplicate-remove"]);
		if (variant.keptProject !== variant.removedProject) outcome("duplicate", "removed", "shared", ["duplicate-keep"]);
	});

	it.each([1_794_556_800_000, 1_794_729_599_000])(
		"duplicate: shared assistant row survives a project owner's restatement at %s and adopts its provenance", async ownerTime => {
			await plant("shared-assistant", "The service reports must be written in Chinese.", 1_794_643_200_000,
				{ asserted_by: "assistant" });
			await plant("project-owner", "Write the service reports in Chinese.", ownerTime, {}, "work-project");
			judge = () => "same";
			await night("shared-owner-duplicate");
			expect.soft(ids()).toEqual(["shared-assistant"]);
			expect.soft(store.getById("shared-assistant")).toMatchObject({
				projectId: "global", text: "Write the service reports in Chinese.",
			});
			expect.soft(metadata("shared-assistant")).not.toHaveProperty("asserted_by");
			expect.soft(metadata("shared-assistant").source_order).toEqual({ valid_from: null,
				session_moment: ownerTime, session_ordinal: 0, global_turn_index: 0,
				rowid: 0, conversation_id: "project-owner" });
			outcome("shared-owner-duplicate", "removed", "project", ["project-owner"]);
			outcome("shared-owner-duplicate", "removed", "shared", ["shared-assistant"]);
		});

	it("duplicate: the surviving shared row uses the owner's text and quote for its source check", async () => {
		await plant("shared-assistant", "The service reports must be written in Chinese.", 1_794_643_200_000,
			{ asserted_by: "assistant", source_span: { turnIndex: 1,
				quote: "The service reports must be written in Chinese.", startOffset: 0, endOffset: 47 } });
		await plant("project-owner", "Write the service reports in Chinese.", 1_794_729_599_000,
			{ source_span: { turnIndex: 2, quote: "Write the service reports in Chinese.", startOffset: 0, endOffset: 37 } }, "work-project");
		judge = () => "same";
		await night("shared-owner-source");
		expect.soft(ids()).toEqual(["shared-assistant"]);
		expect.soft(store.getById("shared-assistant")).toMatchObject({
			projectId: "global", text: "Write the service reports in Chinese.",
		});
		expect.soft(metadata("shared-assistant")).toMatchObject({
			source_span: { turnIndex: 2, quote: "Write the service reports in Chinese.", startOffset: 0, endOffset: 37 },
			source_order: { valid_from: null, session_moment: 1_794_729_599_000, session_ordinal: 0,
				global_turn_index: 0, rowid: 0, conversation_id: "project-owner" },
		});
		expect.soft(metadata("shared-assistant")).not.toHaveProperty("asserted_by");
		expect.soft(modelCalls.filter(call => call.callId === "E21")
			.flatMap(call => (payload(call.prompt) as { rows?: unknown[] }).rows ?? []))
			.toEqual([{ id: "shared-assistant", text: "Write the service reports in Chinese.",
				quote: "Write the service reports in Chinese." }]);
	});

	it("duplicate: failed project deletion rolls back the shared row's owner provenance and reference moves", async () => {
		await plant("shared-assistant", "The service reports must be written in Chinese.", 1_794_643_200_000,
			{ asserted_by: "assistant", source_span: { turnIndex: 1,
				quote: "The service reports must be written in Chinese.", startOffset: 0, endOffset: 47 } });
		await plant("project-owner", "Write the service reports in Chinese.", 1_794_556_800_000,
			{ source_span: { turnIndex: 2, quote: "Write the service reports in Chinese.", startOffset: 0, endOffset: 37 } }, "work-project");
		await plant("historical", "The reports used to be written in Spanish.", 1_794_500_000_000,
			{ superseded_by: "project-owner" });
		judge = () => "same";
		database.sqlite.exec(`CREATE TRIGGER fail_project_duplicate_delete BEFORE DELETE ON nodix_memories
			WHEN old.id = 'project-owner' BEGIN SELECT RAISE(ABORT, 'fixture project duplicate deletion failed'); END`);
		await night("shared-owner-rollback");
		expect.soft(ids()).toEqual(["historical", "project-owner", "shared-assistant"]);
		expect.soft(store.getById("shared-assistant")?.text).toBe("The service reports must be written in Chinese.");
		expect.soft(metadata("shared-assistant").source_span).toEqual({ turnIndex: 1,
			quote: "The service reports must be written in Chinese.", startOffset: 0, endOffset: 47 });
		expect.soft(store.getById("project-owner")?.text).toBe("Write the service reports in Chinese.");
		expect.soft(metadata("project-owner").source_span).toEqual({ turnIndex: 2,
			quote: "Write the service reports in Chinese.", startOffset: 0, endOffset: 37 });
		expect.soft(metadata("shared-assistant")).toMatchObject({ asserted_by: "assistant", source_order: {
			valid_from: null, session_moment: 1_794_643_200_000, session_ordinal: 0,
			global_turn_index: 0, rowid: 0, conversation_id: "shared-assistant",
		} });
		expect.soft(metadata("historical").superseded_by).toBe("project-owner");
		outcome("shared-owner-rollback", "failed", "project", ["project-owner"]);
		outcome("shared-owner-rollback", "failed", "shared", ["shared-assistant"]);
		expect.soft(journal("shared-owner-rollback").filter(entry => entry.outcome === "failed").map(entry => entry.reason))
			.toEqual(["fixture project duplicate deletion failed", "fixture project duplicate deletion failed"]);
	});

	it.each(duplicateVariants)("duplicate: $preference, E23 no preserves both rows and every reference", async variant => {
		await duplicate(variant); changeCheck = false;
		await night("duplicate-refused");
		expect.soft(ids()).toEqual(["duplicate-keep", "duplicate-remove", "exception", "historical"]);
		expect.soft(metadata("exception").overrides_shared).toBe("duplicate-remove");
		expect.soft(metadata("historical").superseded_by).toBe("duplicate-remove");
		outcome("duplicate-refused", "undecided", variant.removedProject === "global" ? "shared" : "project",
			variant.keptProject === variant.removedProject ? ["duplicate-remove", "duplicate-keep"] : ["duplicate-remove"]);
		if (variant.keptProject !== variant.removedProject) outcome("duplicate-refused", "undecided", "shared", ["duplicate-keep"]);
	});

	it.each(duplicateVariants)("duplicate: $preference, failure at deletion rolls back reference moves and source order", async variant => {
		await duplicate(variant);
		database.sqlite.exec(`CREATE TRIGGER fail_duplicate_delete BEFORE DELETE ON nodix_memories
			WHEN old.id = 'duplicate-remove' BEGIN SELECT RAISE(ABORT, 'fixture duplicate transaction failed'); END`);
		await night("duplicate-rollback");
		expect.soft(ids()).toEqual(["duplicate-keep", "duplicate-remove", "exception", "historical"]);
		expect.soft(metadata("exception").overrides_shared).toBe("duplicate-remove");
		expect.soft(metadata("historical").superseded_by).toBe("duplicate-remove");
		expect.soft(metadata("duplicate-keep").source_order).toEqual({ valid_from: null,
			session_moment: variant.keptTime, session_ordinal: 0, global_turn_index: 0,
			rowid: 0, conversation_id: "duplicate-keep" });
		outcome("duplicate-rollback", "failed", variant.removedProject === "global" ? "shared" : "project",
			variant.keptProject === variant.removedProject ? ["duplicate-remove", "duplicate-keep"] : ["duplicate-remove"]);
		if (variant.keptProject !== variant.removedProject) outcome("duplicate-rollback", "failed", "shared", ["duplicate-keep"]);
		expect.soft(JSON.stringify(journal("duplicate-rollback"))).toContain("fixture duplicate transaction failed");
	});

	it("replacement: E22 no leaves both rows open and journals undecided", async () => {
		await replacement(); pairCheck = false;
		await night("replacement-refused");
		openPorts();
		outcome("replacement-refused", "undecided", "shared", ["pending-port", "stale-port"]);
	});

	it("replacement: unreachable E22 preserves both rows, journals the error and runs the next step", async () => {
		await replacement(); await followingStep(); pairCheck = "unreachable";
		await night("replacement-unreachable");
		for (const id of ["pending-port", "stale-port"]) expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
		expect.soft(store.getById("pending-port")?.text).toBe(newPort);
		expect.soft(store.getById("stale-port")?.text).toBe(oldPort);
		outcome("replacement-unreachable", "failed", "shared", ["pending-port", "stale-port"]);
		expect.soft(JSON.stringify(journal("replacement-unreachable"))).toContain("fixture checking side unreachable");
		followingStepRan();
	});

	it("merge: writes one shorter checked row and marks both sources with its id", async () => {
		await mergePair();
		await night("merge-success");
		expect.soft(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE id NOT IN ('report-language', 'report-causes')").all())
			.toEqual([{ text: "Write service reports in Chinese and explain failure causes." }]);
		expect.soft(database.sqlite.prepare(`SELECT source.id, json_extract(source.metadata, '$.supersede_reason') AS reason,
			successor.text FROM nodix_memories source JOIN nodix_memories successor
			ON successor.id = json_extract(source.metadata, '$.superseded_by')
			WHERE source.id IN ('report-language', 'report-causes') ORDER BY source.id`).all()).toEqual([
			{ id: "report-causes", reason: "merge", text: "Write service reports in Chinese and explain failure causes." },
			{ id: "report-language", reason: "merge", text: "Write service reports in Chinese and explain failure causes." },
		]);
		outcome("merge-success", "merged", "shared", ["report-language", "report-causes"]);
	});

	it.each(["", " \n "])("merge: contradiction reply %j leaves sources open without recurring failures", async text => {
		await replacement();
		judge = () => "overlaps";
		checkingMerge = true;
		mergeText = text;
		await night("merge-contradiction");
		openPorts();
		expect(journal("merge-contradiction").filter(entry => entry.outcome === "failed")).toEqual([]);
		expect(journal("merge-contradiction").filter(entry => entry.stage === "merge")
			.map(entry => ({ outcome: entry.outcome, reason: entry.reason })))
			.toEqual([{ outcome: "undecided", reason: "sources contradict" }]);
		for (const id of ["pending-port", "stale-port"]) expect(metadata(id)).not.toHaveProperty("precision_recheck_with");
		nextNight();
		await night("after-merge-contradiction");
		openPorts();
		expect(journal("after-merge-contradiction").filter(entry => entry.stage === "merge" || entry.outcome === "failed")).toEqual([]);
	});

	it.each(["longer", "unfaithful", "missing facts"])("merge: %s proposal leaves sources untouched and journals undecided", async refusal => {
		await mergePair();
		if (refusal === "longer") mergeText = `${firstPart} ${secondPart} This unnecessary sentence makes the proposal longer.`;
		else if (refusal === "unfaithful") mergeFaithful = false;
		else mergeAccounted = false;
		await night("merge-refused");
		unchangedMergeSources();
		outcome("merge-refused", "undecided", "shared", ["report-language", "report-causes"]);
	});

	it("contradicting ports take confirmed replacement and never create a merged row", async () => {
		await replacement();
		await night("contradiction");
		expect.soft(ids()).toEqual(["pending-port", "stale-port"]);
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });

		outcome("contradiction", "replaced", "shared", ["pending-port", "stale-port"]);
	});

	it.each([false, true])("current marks skip candidate searches while changed-neighbour work is preserved: %s", async changed => {
		const previousAt = 1_794_643_200_000;
		for (let index = 0; index < 16; index += 1) {
			await plant(`checked-${index}`, `The owner requires service report ${index} to explain its failure causes.`);
		}
		await plant("unmarked-old", firstPart);
		await plant("unmarked-other", secondPart, changed ? previousAt + 1000 : previousAt - 1000);
		const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
		database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.precision_admission', ?)").run(admitted);
		database.sqlite.prepare(`UPDATE nodix_memories SET metadata = json_set(metadata,
			'$.precision_night', json_object('at', ?, 'text', content_hash)) WHERE id LIKE 'checked-%'`).run(previousAt);
		database.sqlite.exec("CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)");
		database.sqlite.prepare("INSERT INTO nodix_memory_migration_markers(name, applied_at, payload) VALUES ('memory-precision-last-night', ?, ?)")
			.run(previousAt, JSON.stringify({ day: "2026-11-14", waveId: "prior-night" }));
		const search = vi.spyOn(MemoryStore.prototype, "searchSemantic");
		await night(`skip-checked-searches-${changed}`);
		const expected = ["unmarked-old", "unmarked-other"];
		if (changed) {
			const first = search.mock.results[0];
			expect(first?.type).toBe("return");
			if (first?.type !== "return") throw new Error("Missing changed-neighbour search");
			const neighbours = await first.value;
			expect(neighbours).toHaveLength(8);
			expected.push(...neighbours.map(hit => hit.entry.id).filter(id => id.startsWith("checked-")));
		}
		expect(search.mock.calls.map(([, options]) => options?.excludeMemoryIds?.[0]).sort()).toEqual(expected.sort());
		for (const id of ["unmarked-old", "unmarked-other"]) {
			expect(metadata(id)).toHaveProperty("precision_night.at", 1_794_729_600_000);
		}
		expect(journal(`skip-checked-searches-${changed}`).filter(entry => entry.outcome === "failed")).toEqual([]);
	});

	it("candidate searches stay within started groups when the relation call budget ends", async () => {
		const unchecked = 100;
		const groupSize = 8 * HOST_MODEL_CONCURRENCY;
		const previousAt = 1_794_643_200_000;
		const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
		for (let index = 0; index < unchecked; index += 1) {
			await plant(`search-budget-${String(index).padStart(3, "0")}`,
				`The owner requires service report ${index} to explain its failure causes.`,
				previousAt - unchecked + index, { precision_admission: admitted });
		}
		database.sqlite.exec("CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)");
		database.sqlite.prepare("INSERT INTO nodix_memory_migration_markers VALUES ('memory-precision-last-night', ?, ?)")
			.run(previousAt, JSON.stringify({ day: "2026-11-14", since: previousAt }));
		const search = vi.spyOn(MemoryStore.prototype, "searchSemantic");
		const searchesAtRelation: number[] = [];
		// Replace only the external model facade; use the real budget, engine and nightly journal.
		const budget = precisionNightBudget({ completeText: async request => {
			if (request.prompt === "spent") return "spent";
			searchesAtRelation.push(search.mock.calls.length);
			const reply = await agentPort.complete({ callId: request.callId, prompt: request.prompt, maxTokens: request.maxTokens ?? 4096 });
			if (reply.kind !== "ok") throw new Error("Missing fixture model reply");
			return reply.text;
		}, getLastError: () => null } as LlmClient);
		for (let index = 0; index < 100 - HOST_MODEL_CONCURRENCY; index += 1) {
			await budget.llm.completeText({ callId: "E21", prompt: "spent" });
		}
		vi.spyOn(llmClient, "createLlmClient").mockReturnValue(budget.llm);
		await night("search-budget");

		const facts = modelCalls.flatMap(call => (payload(call.prompt) as { facts: Fact[] }).facts);
		const expected = Array.from({ length: groupSize }, (_, index) => `search-budget-${String(unchecked - 1 - index).padStart(3, "0")}`);
		expect(facts.map(fact => fact.text)).toEqual(expected.map(id => store.getById(id)?.text));
		expect(facts.every(fact => fact.rows.length > 0)).toBe(true);
		expect(journal("search-budget").filter(entry => entry.stage === "pairs" && entry.outcome === "fine").map(entry => entry.row_id)).toEqual(expected);
		expect(budget.exhausted).toBe(true);
		expect(journal("search-budget").filter(entry => entry.outcome === "failed")).toEqual([]);
		const deferred = journal("search-budget").filter(entry => entry.stage === "ordered-pairs" && entry.outcome === "undecided");
		expect(deferred).toHaveLength(1);
		const remaining = Number(deferred[0]?.reason?.match(/(\d+) rows left for next night/)?.[1]);
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(unchecked - facts.length);
		// All replies are unrelated, so judged rows require no later search rounds.
		expect.soft(searchesAtRelation[0], `searches before first relation call; judged=${facts.length}, deferred=${remaining}`)
			.toBeLessThanOrEqual(groupSize);
		// The group that encounters exhaustion may already have searched its rows.
		expect.soft(search.mock.calls.length, `searches in pass; judged=${facts.length}, deferred=${remaining}`)
			.toBeLessThanOrEqual(2 * groupSize);
	});

	it("a changed row is searched once before its first relation call", async () => {
		const previousAt = 1_794_643_200_000;
		const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
		await plant("changed-search", firstPart, previousAt + 1000, { precision_admission: admitted });
		await plant("changed-search-neighbour", secondPart, previousAt - 1000, { precision_admission: admitted });
		const search = vi.spyOn(MemoryStore.prototype, "searchSemantic");
		const searchesBeforeRelation: number[] = [];
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			const data = payload(request.prompt) as { facts?: Fact[] };
			if (request.callId === "E21" && data.facts?.some(fact => fact.text === firstPart)) {
				searchesBeforeRelation.push(search.mock.calls.filter(([, options]) =>
					store.getById(options?.excludeMemoryIds?.[0] ?? "")?.text === firstPart).length);
			}
			return complete(request);
		};
		await runPrecisionNightSteps({ store, waveId: "changed-search", previousAt, beforeMutation: async () => true,
			complete: async request => {
				const reply = await agentPort.complete({ callId: request.callId, prompt: request.prompt, maxTokens: request.maxTokens ?? 4096 });
				if (reply.kind !== "ok") throw new Error("Missing fixture model reply");
				return { text: reply.text, truncated: false };
			} });
		expect(journal("changed-search").filter(entry => entry.stage === "pairs" && entry.outcome === "fine").map(entry => entry.row_id))
			.toEqual(["changed-search", "changed-search-neighbour"]);
		expect(journal("changed-search").filter(entry => entry.outcome === "failed")).toEqual([]);
		expect(searchesBeforeRelation, "searches for the changed row text before its first relation call").toEqual([1]);
	});

	it("fine: persists a per-row mark, skips the next night, and rejudges after a nearby write", async () => {
		await plant("fine-rule", firstPart);
		await plant("fine-neighbour", secondPart);
		await night("fine-first");
		expect.soft(database.sqlite.prepare(`SELECT json_extract(metadata, '$.precision_night.at') AS at,
			json_extract(metadata, '$.precision_night.text') = content_hash AS correct_text
			FROM nodix_memories WHERE id = 'fine-rule'`).all())
			.toEqual([{ at: 1_794_729_600_000, correct_text: 1 }]);
		outcome("fine-first", "fine", "shared", ["fine-rule"]);
		nextNight(); await night("fine-second");
		expect.soft(journal("fine-second").filter(entry => entry.stage === "pairs" && entry.outcome === "fine")).toEqual([]);
		expect.soft(database.sqlite.prepare(`SELECT json_extract(metadata, '$.precision_night.at') AS at,
			json_extract(metadata, '$.precision_night.text') = content_hash AS correct_text
			FROM nodix_memories WHERE id = 'fine-rule'`).all())
			.toEqual([{ at: 1_794_729_600_000, correct_text: 1 }]);
		await plant("nearby-write", "The owner requires all service reports to include a short Chinese summary.", 1_794_816_000_000);
		nextNight(); vi.mocked(Date.now).mockReturnValue(1_794_902_400_000);
		await night("fine-nearby-changed");
		outcome("fine-nearby-changed", "fine", "shared", ["fine-rule"]);
		expect.soft(metadata("fine-rule")).toHaveProperty("precision_night.at", 1_794_902_400_000);
	});

	it("recorded recheck: a current text mark does not skip an unresolved pair", async () => {
		await plant("marked-recheck", firstPart);
		await plant("marked-peer", secondPart);
		await night("marked-recheck-first");
		for (const previousAt of [1_794_729_600_000, 0]) {
			database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.precision_recheck_with', json(?)) WHERE id = ?")
				.run(JSON.stringify(["marked-peer"]), "marked-recheck");
			expect(metadata("marked-recheck")).not.toHaveProperty("precision_check");
			database.sqlite.prepare("UPDATE nodix_memory_migration_markers SET payload = ? WHERE name = 'memory-precision-last-night'")
				.run(JSON.stringify({ day: "2026-11-14", since: previousAt }));
			modelCalls = [];
			const waveId = `marked-recheck-${previousAt}`;
			await night(waveId);
			expect.soft(modelCalls.filter(call => call.callId === "E21")
				.flatMap(call => (payload(call.prompt) as { facts?: Fact[] }).facts ?? [])
				.filter(fact => fact.text === firstPart).flatMap(fact => fact.rows.map(row => row.id)),
				`recorded pair must be judged with previousAt ${previousAt}`).toContain("marked-peer");
			expect.soft(metadata("marked-recheck")).not.toHaveProperty("precision_recheck_with");
			outcome(waveId, "fine", "shared", ["marked-recheck"]);
		}
	});

	it("priority: pending precedes changed rows, session-start rows, decisions and facts", async () => {
		// All old rows predate the previous nightly marker; insertion order is deliberately reversed.
		await plant("old-fact", "The Chinese service report archive uses the account name Prism.", 1_794_556_800_000, { precision_kind: "fact" });
		await plant("old-decision", "The owner chose manual approval before publishing Chinese service reports.", 1_794_556_800_001, { precision_kind: "decision" });
		await plant("start-rule", firstPart, 1_794_556_800_002, { start_label: "core", start_rank: 1 });
		await plant("changed-row", "The Chinese service report archive now uses the account name Cedar.", 1_794_729_599_000, { precision_kind: "fact" });
		await plant("recorded-row", secondPart, 1_794_556_800_003, { precision_recheck_with: ["start-rule"] });
		await plant("pending-row", "The owner requires all service reports to use the new Chinese template.", 1_794_556_800_004, { precision_check: "pending" });
		database.sqlite.exec("CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)");
		database.sqlite.prepare("INSERT INTO nodix_memory_migration_markers(name, applied_at, payload) VALUES ('memory-precision-last-night', ?, ?)")
			.run(1_794_643_200_000, JSON.stringify({ day: "2026-11-14", waveId: "prior-night" }));
		await night("priority");
		const judged = journal("priority").filter(entry => entry.stage === "pairs" && entry.outcome === "fine").map(entry => entry.row_id);
		// Recorded rechecks belong to normal groups, whose batching is checked separately.
		expect.soft(judged.filter(id => id === "recorded-row")).toEqual(["recorded-row"]);
		const otherRows = judged.filter(id => id !== "recorded-row");
		expect.soft(otherRows.slice(0, 3)).toEqual([
			"pending-row", "changed-row", "start-rule",
		]);
		expect.soft(otherRows.slice(3).sort()).toEqual([
			"old-decision", "old-fact",
		].sort());
	});

	it("project exception: a shared replacement moves the link and rejudges against the new shared row", async () => {
		await replacement();
		await plant("project-exception", "In this project the service must use port 8091.", 1_794_643_200_001,
			{ overrides_shared: "stale-port" }, "work-project");
		await night("exception-rejudged");
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });
		expect.soft(metadata("project-exception").overrides_shared).toBe("pending-port");
		expect.soft(modelCalls.filter(call => call.callId === "E21")
			.flatMap(call => (payload(call.prompt) as { facts?: Fact[] }).facts ?? [])
			.filter(fact => fact.text === "In this project the service must use port 8091.")
			.flatMap(fact => fact.rows.map(row => ({ id: row.id, text: row.text }))))
			.toEqual([{ id: "pending-port", text: "The owner requires the service to use port 8090." }]);

		outcome("exception-rejudged", "fine", "project", ["project-exception"]);
	});

	it("project exception: skips a row already journaled undecided in the same job", async () => {
		await replacement();
		await plant("project-exception", "In this project the service must use port 8091.", 1_794_643_200_001,
			{ overrides_shared: "stale-port" }, "work-project");
		const waveId = "exception-already-undecided";
		database.sqlite.prepare(`INSERT INTO nodix_rem_journal(job_id, job_type, stage, outcome, row_id, actions_applied, detail)
			VALUES (?, 'precision-nightly', 'pairs', 'undecided', 'project-exception', 0, ?)`)
			.run(waveId, JSON.stringify({ scope: "project", projectId: "work-project", rows: ["project-exception"] }));
		const undecided = journal(waveId);
		await night(waveId);
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });
		expect.soft(modelCalls.filter(call => call.callId === "E21")
			.flatMap(call => (payload(call.prompt) as { facts?: Fact[] }).facts ?? [])
			.filter(fact => fact.text === "In this project the service must use port 8091.")).toEqual([]);
		expect.soft(metadata("project-exception").overrides_shared).toBe("stale-port");
		expect.soft(metadata("project-exception")).not.toHaveProperty("precision_night");
		expect(journal(waveId).filter(entry => entry.stage === "pairs" && entry.row_id === "project-exception")).toEqual(undecided);
	});

	it("project exception: failed rejudgement preserves the old shared link and journals failure", async () => {
		await replacement();
		await plant("project-exception", "In this project the service must use port 8091.", 1_794_643_200_001,
			{ overrides_shared: "stale-port" }, "work-project");
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			if (request.callId === "E21" && metadata("stale-port").superseded_by === "pending-port") {
				modelCalls.push(request);
				return { kind: "error", category: "transport", message: "fixture exception rejudgement unavailable" };
			}
			return complete(request);
		};
		await night("exception-rejudgement-failed");
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });
		expect.soft(store.getById("project-exception")?.text).toBe("In this project the service must use port 8091.");
		expect.soft(metadata("project-exception").overrides_shared).toBe("stale-port");
		expect.soft(metadata("project-exception")).not.toHaveProperty("precision_night");
		expect.soft(journal("exception-rejudgement-failed").filter(entry => entry.row_id === "project-exception" && entry.outcome === "failed")
			.map(entry => ({ stage: entry.stage, reason: entry.reason })))
			.toEqual([{ stage: "pairs", reason: "[E21] agent-llm transport: fixture exception rejudgement unavailable" }]);
		expect.soft(journal("exception-rejudgement-failed").filter(entry => entry.stage === "pairs" && entry.row_id === "project-exception" && entry.outcome === "fine"))
			.toEqual([]);
	});

	it("thrown admission step: journals operation, rows and error while the following ordering step succeeds", async () => {
		await plant("broken-admission", "For this task only, print the temporary report.", 1_794_556_800_000,
			{ precision_kind: undefined, precision_judged: undefined });
		await followingStep(); throwCall = "E16";
		await night("step-threw");
		expect.soft(store.getById("broken-admission")?.text).toBe("For this task only, print the temporary report.");
		followingStepRan();
		outcome("step-threw", "failed", "shared", ["broken-admission"]);
		expect.soft(JSON.stringify(journal("step-threw"))).toContain("fixture admission step exploded");
		expect.soft(database.sqlite.prepare("SELECT stage FROM nodix_rem_journal WHERE job_id = 'step-threw' AND outcome = 'failed' AND length(trim(stage)) > 0").all()).toEqual([{ stage: "admission" }]);
	});

	it("call budget: batches due rows in priority order without exhausting the night", async () => {
		const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
		const old = 1_794_556_800_000;
		await plant("budget-pending", "The service report archive has pending account Cedar.", old + 1,
			{ precision_kind: "fact", precision_check: "pending", precision_admission: admitted });
		await plant("budget-recorded", "The service report archive has recorded account Cedar.", old,
			{ precision_kind: "fact", precision_recheck_with: ["budget-pending"], precision_admission: admitted });
		await plant("budget-start", "The owner requires service report archives in Chinese.", old + 2,
			{ precision_admission: admitted, start_label: "core" });
		await plant("budget-delivered", "The service report archive rejects the obsolete Cedar account.", old + 3,
			{ precision_kind: "pitfall", asserted_by: "assistant", precision_admission: admitted });
		await plant("budget-decision", "The owner chose the Cedar account for the service report archive.", old + 4,
			{ precision_kind: "decision", precision_admission: admitted });
		for (let index = 0; index < 99; index += 1) {
			await plant(`budget-fact-${String(index).padStart(2, "0")}`,
				`The service report archive uses Cedar account number ${index}.`, old + 10 + index,
				{ precision_kind: "fact", precision_admission: admitted });
		}
		// Store defaults include an access counter; only this row represents a delivered memory.
		database.sqlite.exec("UPDATE nodix_memories SET metadata = json_remove(metadata, '$.access_count', '$.accessCount')");
		database.sqlite.exec("UPDATE nodix_memories SET metadata = json_set(metadata, '$.access_count', 12) WHERE id = 'budget-delivered'");
		database.sqlite.exec("CREATE TABLE IF NOT EXISTS nodix_memory_migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, payload TEXT NOT NULL)");
		database.sqlite.prepare("INSERT INTO nodix_memory_migration_markers VALUES ('memory-precision-last-night', ?, ?)")
			.run(1_794_643_200_000, JSON.stringify({ day: "2026-11-14", since: 1_794_643_200_000 }));
		await night("budget-first");
		expect.soft(journal("budget-first").filter(entry => entry.stage === "pairs" && entry.outcome === "fine" && entry.row_id !== "budget-recorded").slice(0, 6).map(entry => entry.row_id))
			.toEqual(["budget-pending", "budget-start", "budget-delivered", "budget-fact-98", "budget-fact-97", "budget-fact-96"]);
		expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_night.at') = 1794729600000").get())
			.toEqual({ rows: 104 });
		expect.soft(database.sqlite.prepare("SELECT id FROM nodix_memories WHERE json_extract(metadata, '$.precision_night.at') IS NULL ORDER BY id").all())
			.toEqual([]);
		expect.soft(metadata("budget-pending")).not.toHaveProperty("precision_check");
		expect.soft(metadata("budget-recorded")).not.toHaveProperty("precision_recheck_with");
		expect.soft(database.sqlite.prepare("SELECT json_extract(payload, '$.since') AS since FROM nodix_memory_migration_markers WHERE name = 'memory-precision-last-night'").get())
			.toEqual({ since: 1_794_729_600_000 });
		// Advance the clock; retain the product's continuation marker and every row mark.
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		await night("budget-second");
		expect.soft(journal("budget-second").filter(entry => entry.stage === "pairs" && entry.outcome === "fine").map(entry => entry.row_id))
			.toEqual([]);
		expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_night.at') = 1794816000000").get())
			.toEqual({ rows: 0 });
		expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_night.at') IS NULL").get())
			.toEqual({ rows: 0 });
		expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories").get()).toEqual({ rows: 104 });
	});

	it("refused pending replacements leave the priority group and free the next night's budget", async () => {
			const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
			await plant("unresolved-anchor", "The service report archive uses the Cedar account.", 1_794_500_000_000,
				{ precision_admission: admitted });
			for (let index = 0; index < 60; index += 1) {
				await plant(`unresolved-pending-${String(index).padStart(2, "0")}`,
					`The service report archive uses Cedar account number ${index}.`, 1_794_556_800_000 + index,
					{ precision_check: "pending", precision_recheck_with: ["unresolved-anchor"], precision_admission: admitted });
			}
			await plant("outside-admission", "The owner requires the Cedar service report archive to retain failure reports.",
				1_794_643_200_000, { precision_kind: undefined, precision_judged: undefined });
			await plant("outside-ordered", "The owner requires the Cedar service report archive to include Chinese summaries.",
				1_794_643_200_001, { precision_admission: admitted });
			judge = (fact, row) => fact.text.startsWith("The service report archive uses Cedar account number")
				&& row.id === "unresolved-anchor" ? "replaces" : "unrelated";
			pairCheck = false;
			await night("unresolved-first");

			expect.soft(database.sqlite.prepare(`SELECT count(*) AS still_pending FROM nodix_memories
				WHERE id IN (SELECT row_id FROM nodix_rem_journal WHERE job_id = 'unresolved-first' AND outcome = 'undecided')
				AND json_extract(metadata, '$.precision_check') = 'pending'`).get()).toEqual({ still_pending: 0 });
			expect.soft(metadata("outside-admission")).not.toHaveProperty("precision_admission");
			expect.soft(metadata("outside-ordered")).not.toHaveProperty("precision_night");
			// Keep every product continuation mark; only the date advances between nights.
			vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
			await night("unresolved-second");

			expect.soft(database.sqlite.prepare(`SELECT count(*) AS pending FROM nodix_memories
				WHERE json_extract(metadata, '$.precision_check') = 'pending'
				OR json_type(metadata, '$.precision_recheck_with') = 'array'`).get()).toEqual({ pending: 0 });
			expect.soft(database.sqlite.prepare(`SELECT count(DISTINCT row_id) AS undecided FROM nodix_rem_journal
				WHERE job_id IN ('unresolved-first', 'unresolved-second') AND outcome = 'undecided'
				AND row_id LIKE 'unresolved-pending-%'`).get()).toEqual({ undecided: 60 });
			expect.soft(metadata("outside-admission")).toMatchObject({ precision_kind: "rule", precision_judged: true });
			expect.soft(database.sqlite.prepare(`SELECT stage, outcome, row_id FROM nodix_rem_journal
				WHERE job_id = 'unresolved-second' AND row_id IN ('outside-admission', 'outside-ordered')
				AND stage IN ('admission', 'pairs') ORDER BY stage, row_id`).all()).toEqual([
					{ stage: "admission", outcome: "fine", row_id: "outside-admission" },
					{ stage: "pairs", outcome: "fine", row_id: "outside-admission" },
					{ stage: "pairs", outcome: "fine", row_id: "outside-ordered" },
				]);
			expect.soft(metadata("outside-ordered")).toHaveProperty("precision_night.at", 1_794_816_000_000);
			expect.soft(database.sqlite.prepare("SELECT count(*) AS rows FROM nodix_memories").get()).toEqual({ rows: 63 });
			expect.soft(database.sqlite.prepare(`SELECT count(*) AS replaced FROM nodix_memories
				WHERE json_extract(metadata, '$.superseded_by') IS NOT NULL`).get()).toEqual({ replaced: 0 });
			expect.soft(database.sqlite.prepare(`SELECT count(*) AS checked FROM nodix_memories
				WHERE id LIKE 'unresolved-pending-%' AND json_type(metadata, '$.precision_night') = 'object'`).get())
				.toEqual({ checked: 60 });
		});

	it("maybe-replaces: retains the recorded pair for the next night instead of marking it checked", async () => {
		await plant("uncertain-anchor", oldPort);
		await plant("uncertain-newer", newPort, 1_794_643_200_000,
			{ precision_check: "pending", precision_recheck_with: ["uncertain-anchor"] });
		judge = (fact, row) => fact.text === newPort && row.id === "uncertain-anchor" ? "maybe-replaces" : "unrelated";
		await night("uncertain-first");
		expect.soft(metadata("uncertain-newer").precision_recheck_with).toEqual(["uncertain-anchor"]);
		expect.soft(metadata("uncertain-newer")).not.toHaveProperty("precision_night");
		modelCalls = []; nextNight();
		await night("uncertain-second");
		expect.soft(modelCalls.filter(call => call.callId === "E21").flatMap(call =>
			(payload(call.prompt) as { facts: Fact[] }).facts.map(fact => fact.text))).toContain(newPort);
		expect.soft(metadata("uncertain-newer").precision_recheck_with).toEqual(["uncertain-anchor"]);
	});

	it.each(["correct", "remove"] as const)("source sentence batch: confirmed %s journals corrected and skips a row without a quote", async action => {
		await plant("unsupported", oldPort, 1_794_556_800_000,
			{ source_span: { quote: action === "correct" ? newPort : "The temporary report finished." } });
		await plant("no-quote", "The owner requires a Chinese service report.");
		sourceReply = { action, text: action === "correct" ? newPort : "" };
		await night("source-confirmed");
		expect.soft(modelCalls.filter(call => call.callId === "E21" && (payload(call.prompt) as { rows?: unknown[] }).rows)
			.map(call => payload(call.prompt))).toEqual([{ rows: [{ id: "unsupported",
				text: "The owner requires the service to use port 8070.",
				quote: action === "correct" ? "The owner requires the service to use port 8090." : "The temporary report finished.",
			}] }]);
		if (action === "correct") {
			expect.soft(store.getById("unsupported")?.text).toBe("The owner requires the service to use port 8090.");
			expect.soft(ids()).toEqual(["no-quote", "unsupported"]);
			expect.soft(metadata("unsupported")).not.toHaveProperty("precision_night");
		} else {
			expect.soft(store.getById("unsupported")).toBeUndefined();
			expect.soft(ids()).toEqual(["no-quote"]);
		}
		outcome("source-confirmed", "corrected", "shared", ["unsupported"]);
		expect.soft(store.getById("no-quote")?.text).toBe("The owner requires a Chinese service report.");
		expect.soft(journal("source-confirmed").filter(entry => entry.row_id === "no-quote" && entry.outcome === "corrected"))
			.toEqual([]);
		expect.soft(metadata("no-quote")).not.toHaveProperty("source_span");
		expect.soft(metadata("no-quote").precision_night).toEqual({ at: 1_794_729_600_000,
			text: "55f013aa7399524bf3b86da39c88676661933cc88079924ae8eb67641d84a798" });
	});

	it("source correction: compares the corrected text with its nearest rows the next night", async () => {
		await plant("corrected-port", oldPort, 1_794_556_800_000, { source_span: { quote: newPort } });
		await plant("report-neighbour", firstPart);
		sourceReply = { action: "correct", text: newPort };
		await night("source-correction-first");
		expect(store.getById("corrected-port")?.text).toBe(newPort);
		expect(modelCalls.filter(call => call.callId === "E21").flatMap(call =>
			(payload(call.prompt) as { facts?: Fact[] }).facts ?? []))
			.toEqual(expect.arrayContaining([expect.objectContaining({ text: oldPort,
				rows: expect.arrayContaining([expect.objectContaining({ id: "report-neighbour", text: firstPart })]),
			})]));
		expect.soft(metadata("corrected-port")).not.toHaveProperty("precision_night");

		modelCalls = []; sourceReply = { action: "keep", text: "" };
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		await night("source-correction-second");
		expect.soft(modelCalls.filter(call => call.callId === "E21").flatMap(call =>
			(payload(call.prompt) as { facts?: Fact[] }).facts ?? []))
			.toEqual(expect.arrayContaining([expect.objectContaining({ text: newPort,
				rows: expect.arrayContaining([expect.objectContaining({ id: "report-neighbour", text: firstPart })]),
			})]));
		expect.soft(metadata("corrected-port").precision_night).toEqual({ at: 1_794_816_000_000,
			text: store.getById("corrected-port")?.contentHash });
	});

	it("source sentence batch: refused confirmation preserves the unsupported text and marks it checked", async () => {
		await plant("unsupported", oldPort, 1_794_556_800_000, { source_span: { quote: newPort } });
		sourceReply = { action: "correct", text: newPort }; changeCheck = false;
		await night("source-refused");
		expect.soft(modelCalls.filter(call => call.callId === "E21").map(call => payload(call.prompt)))
			.toEqual([{ rows: [{ id: "unsupported", text: "The owner requires the service to use port 8070.",
				quote: "The owner requires the service to use port 8090." }] }]);
		expect.soft(store.getById("unsupported")?.text).toBe("The owner requires the service to use port 8070.");
		outcome("source-refused", "undecided", "shared", ["unsupported"]);
		expect.soft(metadata("unsupported").precision_night).toEqual({ at: 1_794_729_600_000,
			text: "e54230e0e345158df070156405d4ed9dd6162bb049fc984fb3bdd75009616c43" });
		expect.soft(metadata("unsupported")).not.toHaveProperty("precision_recheck_with");
	});

	it("shared and project overlap: preserves both rows and journals the pair fine", async () => {
		await plant("shared-language", firstPart);
		await plant("project-causes", secondPart, 1_794_643_200_000, {}, "work-project");
		judge = () => "overlaps"; checkingMerge = true;
		await night("cross-scope-overlap");
		expect.soft(ids()).toEqual(["project-causes", "shared-language"]);
		expect.soft(store.getById("shared-language")?.text).toBe("The owner requires all service reports to be written in Chinese.");
		expect.soft(store.getById("project-causes")?.text).toBe("The owner requires all service reports to explain the cause of failures.");
		for (const id of ["project-causes", "shared-language"]) expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
		expect.soft(database.sqlite.prepare(`SELECT outcome, json_extract(detail, '$.scope') AS scope,
			json_extract(detail, '$.rows') AS rows FROM nodix_rem_journal
			WHERE job_id = 'cross-scope-overlap' AND stage = 'pair' ORDER BY scope`).all()).toEqual([
			{ outcome: "fine", scope: "project", rows: '["project-causes"]' },
			{ outcome: "fine", scope: "shared", rows: '["shared-language"]' },
		]);
		expect.soft(journal("cross-scope-overlap").filter(entry => ["merged", "undecided", "failed"].includes(entry.outcome))).toEqual([]);
	});

	it("no registered agent: does no nightly work and deletes nothing", async () => {
		await replacement();
		await plant("one-task", "For this task only, print the temporary report.", 1_794_556_800_000,
			{ precision_kind: undefined, precision_judged: undefined });
		await night("no-agent", false);
		expect(ids()).toEqual(["one-task", "pending-port", "stale-port"]);
		expect(metadata("pending-port").precision_check).toBe("pending");
		expect(metadata("stale-port")).not.toHaveProperty("superseded_by");
		expect(journal("no-agent")).toEqual([]);
		const markerTable = database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_migration_markers'").get();
		expect(markerTable ? database.sqlite.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name IN ('memory-precision-last-night', 'memory-precision-backup')").all() : []).toEqual([]);
	});
});

async function duplicate(variant: typeof duplicateVariants[number]) {
	await plant("duplicate-keep", "The owner requires every service report to be written in Chinese.", variant.keptTime, {}, variant.keptProject);
	await plant("duplicate-remove", "The owner wants all service reports written in Chinese.", variant.removedTime,
		variant.assistant ? { asserted_by: "assistant" } : {}, variant.removedProject);
	await plant("exception", "This project requires service reports in English.", 1_794_643_200_001,
		{ overrides_shared: "duplicate-remove" }, "other-project");
	await plant("historical", "The owner previously required service reports in Spanish.", 1_794_500_000_000,
		{ superseded_by: "duplicate-remove", supersede_reason: "write-judgement", superseded_at: 1_794_643_200_000 });
	judge = (fact, row) => fact.text.includes("Chinese") && ["duplicate-keep", "duplicate-remove"].includes(row.id)
		? "same" : "unrelated";
}


describe("night snapshot writes", () => {
	const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
	type Complete = Parameters<typeof runPrecisionNightSteps>[0]["complete"];
	const edited = "The owner corrected the service requirement to retain detailed audit reports.";
	function run(waveId: string, complete: Complete) {
		return runPrecisionNightSteps({ store, waveId, complete, beforeMutation: async () => true, previousAt: Date.now() });
	}
	function edit(id: string): void {
		database.sqlite.transaction(() => {
			database.sqlite.prepare("UPDATE nodix_memories SET text = ? WHERE id = ?").run(edited, id);
		})();
	}
	async function editDuringCall(wave: string, matches: (request: Parameters<Complete>[0]) => boolean,
		change: () => void): Promise<void> {
		let release: (() => void) | undefined;
		let paused = false;
		const done = run(wave, async request => {
			const reply = await agentPort.complete(request);
			if (!paused && matches(request)) {
				paused = true;
				await new Promise<void>(resolve => { release = resolve; });
			}
			if (reply.kind !== "ok") throw new Error("fixture model failed");
			return { text: reply.text, truncated: false };
		});
		try {
			await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 10_000 });
			await store.writeMutex.runExclusive(change);
		} finally { release?.(); await done; }
	}
	it.each(["same", "replaces"] as const)("pending-call edit prevents serial %s and checked marks", async relation => {
		await replacement();
		judge = (fact, peer) => fact.text === newPort && peer.id === "stale-port" ? relation : "unrelated";
		await editDuringCall(`serial-edit-${relation}`, request => request.callId === (relation === "same" ? "E23" : "E22"),
			() => edit("pending-port"));
		expect.soft(store.getById("pending-port")?.text).toBe(edited);
		openPorts();
		expect.soft(metadata("pending-port")).not.toHaveProperty("precision_night");
		expect(metadata("pending-port").precision_check).toBe("pending");
	});
	it("pending-call edit prevents project exception link and checked marks", async () => {
		await plant("old-shared", oldPort, 1_794_400_000_000, { superseded_by: "new-shared", precision_admission: admitted });
		await plant("new-shared", newPort, 1_794_556_800_000, { precision_admission: admitted });
		await plant("local-exception", "In this project the service must use port 8091.", 1_794_643_200_000,
			{ overrides_shared: "old-shared", precision_admission: admitted }, "work-project");
		await editDuringCall("exception-call-edit", request => request.callId === "E21"
			&& (payload(request.prompt) as { facts?: Fact[] }).facts?.some(fact => fact.text.includes("8091")) === true,
			() => edit("local-exception"));
		expect.soft(store.getById("local-exception")?.text).toBe(edited);
		expect.soft(metadata("local-exception").overrides_shared).toBe("old-shared");
		expect(metadata("local-exception")).not.toHaveProperty("precision_night");
	});
	it.each([false, true])("pending-call source keep preserves edited row without checked mark, serial %s", async serial => {
		await plant("source-edited", oldPort, 1_794_556_800_000, { precision_admission: admitted,
			source_span: { quote: oldPort }, ...(serial ? { precision_check: "pending" } : {}) });
		await editDuringCall(`source-keep-edit-${serial}`, request => request.callId === "E21"
			&& Array.isArray((payload(request.prompt) as { rows?: unknown[] }).rows), () => edit("source-edited"));
		expect.soft(store.getById("source-edited")?.text).toBe(edited);
		expect.soft(metadata("source-edited")).not.toHaveProperty("precision_night");
		if (serial) expect(metadata("source-edited").precision_check).toBe("pending");
	});
	it("pending-call relation fine preserves edited row without checked mark", async () => {
		await plant("relation-edited", newPort, 1_794_643_200_000, { precision_admission: admitted });
		await plant("relation-peer", oldPort, 1_794_400_000_000, { precision_admission: admitted });
		await editDuringCall("relation-fine-edit", request => request.callId === "E21"
			&& Array.isArray((payload(request.prompt) as { facts?: Fact[] }).facts), () => edit("relation-edited"));
		expect.soft(store.getById("relation-edited")?.text).toBe(edited);
		expect(metadata("relation-edited")).not.toHaveProperty("precision_night");
	});
	it("pending-call merge preserves metadata edited after review", async () => {
		await mergePair(true);
		for (const id of ["report-language", "report-causes"]) {
			const row = store.getById(id);
			if (!row) throw new Error("missing merge source");
			database.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?").run(JSON.stringify({
				...JSON.parse(row.metadata), precision_admission: admitted,
				...(id === "report-language" ? { precision_night: { at: Date.now(), text: row.contentHash } } : {}),
			}), id);
		}
		await editDuringCall("merge-metadata-edit", request => request.callId === "E22", () => {
			database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.owner_note', ?) WHERE id = ?")
				.run("Keep the original wording.", "report-causes");
		});
		unchangedMergeSources();
		expect.soft(metadata("report-causes").owner_note).toBe("Keep the original wording.");
		expect.soft(metadata("report-causes").precision_recheck_with).toEqual(["report-language"]);
		expect(metadata("report-causes")).not.toHaveProperty("precision_night");
	});
	it("pending-call result preserves a new user recheck request", async () => {
		await plant("recheck-edited", newPort, 1_794_643_200_000, { precision_admission: admitted, precision_check: "pending" });
		await plant("recheck-peer", oldPort, 1_794_400_000_000, { precision_admission: admitted });
		await editDuringCall("user-recheck-edit", request => request.callId === "E21"
			&& Array.isArray((payload(request.prompt) as { facts?: Fact[] }).facts), () => {
			database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.precision_recheck_with', json(?)) WHERE id = ?")
				.run(JSON.stringify(["recheck-peer"]), "recheck-edited");
		});
		expect.soft(metadata("recheck-edited").precision_check).toBe("pending");
		expect.soft(metadata("recheck-edited").precision_recheck_with).toEqual(["recheck-peer"]);
		expect(metadata("recheck-edited")).not.toHaveProperty("precision_night");
	});
	it("applies source removal, source correction and replacement in one whole night", async () => {
		await replacement();
		await plant("remove-source", "The service completed a temporary report.", 1_794_556_800_001,
			{ precision_admission: admitted, source_span: { quote: "Temporary activity only." } });
		await plant("correct-source", firstPart, 1_794_556_800_002,
			{ precision_admission: admitted, source_span: { quote: secondPart } });
		const complete = agentPort.complete.bind(agentPort);
		agentPort.complete = async request => {
			const data = payload(request.prompt) as { rows?: Array<{ id: string }> };
			if (request.callId === "E21" && data.rows) return { kind: "ok", text: JSON.stringify({
				rows: data.rows.map(row => ({ id: row.id, action: row.id === "remove-source" ? "remove" : "correct", text: secondPart })),
			}) };
			return complete(request);
		};
		await night("whole-night-own-writes");
		expect.soft(store.getById("remove-source")).toBeUndefined();
		expect.soft(store.getById("correct-source")?.text).toBe(secondPart);
		expect.soft(metadata("stale-port")).toMatchObject({ superseded_by: "pending-port", supersede_reason: "night" });
		expect.soft(metadata("pending-port")).toHaveProperty("precision_night");
		expect(journal("whole-night-own-writes").filter(row => row.outcome === "failed")).toEqual([]);
	});
	it.each(["delete", "keep"] as const)("leaves an edited admission row due while %s is pending", async verdict => {
		await plant("admission-edited", oldPort);
		await plant("admission-control", firstPart);
		let votes = 0;
		const wave = `snapshot-admission-${verdict}`;
		await run(wave, async request => {
			if (request.callId === "E16") {
				votes += 1;
				if (votes === 3 && verdict === "keep") await store.writeMutex.runExclusive(() => edit("admission-edited"));
				return { text: JSON.stringify({ rows: ["admission-edited", "admission-control"].map(id => ({ id,
					verdict: id === "admission-control" ? "keep" : verdict, reason: "fixture activity record",
					kind: "rule", origin: "owner", about_user: false })) }), truncated: false };
			}
			if (request.callId === "E23") {
				await store.writeMutex.runExclusive(() => edit("admission-edited"));
				return { text: JSON.stringify({ rows: [{ id: "admission-edited", confirmed: true }] }), truncated: false };
			}
			const data = payload(request.prompt) as { facts: Fact[] };
			return { text: JSON.stringify({ facts: data.facts.map(fact => ({ index: fact.index,
				rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })) })) }), truncated: false };
		});
		expect.soft(store.getById("admission-edited")?.text).toBe(edited);
		for (const key of ["precision_admission", "precision_night", "superseded_by"])
			expect.soft(metadata("admission-edited")).not.toHaveProperty(key);
		expect.soft(journal(wave).some(row => row.outcome === "undecided" && JSON.parse(row.detail ?? "{}").rows.includes("admission-edited"))).toBe(true);
		expect(metadata("admission-control")).toHaveProperty("precision_admission", admitted);
	});
	it.each(["same", "replaces", "overlaps", "correct", "remove", "keep"] as const)(
		"skips a planned %s and its marks when a user edit is queued first", async operation => {
			await plant("pair-old", oldPort, 1_794_400_000_000, { precision_admission: admitted });
			await plant("pair-new", newPort, 1_794_556_800_000, { precision_admission: admitted,
				source_span: { quote: newPort } });
			const queuedTarget = operation === "same" || operation === "replaces" || operation === "overlaps" ? "pair-old" : "pair-new";
			const exclusive = store.writeMutex.runExclusive.bind(store.writeMutex);
			let queued = false;
			const queueEdit = (): void => {
				if (queued) return;
				queued = true;
				vi.spyOn(store.writeMutex, "runExclusive").mockImplementation(callback => {
					vi.mocked(store.writeMutex.runExclusive).mockRestore();
					void exclusive(() => edit(queuedTarget));
					return exclusive(callback);
				});
			};
			if (operation === "correct") {
				const update = store.update.bind(store);
				vi.spyOn(store, "update").mockImplementation((...args) => { queueEdit(); return update(...args); });
			}
			const wave = `snapshot-pair-${operation}`;
			await run(wave, async request => {
				const data = payload(request.prompt) as { facts?: Fact[]; rows?: Array<{ id: string }> };
				let reply: unknown;
				if (data.facts) reply = { facts: data.facts.map(fact => ({ index: fact.index,
					rows: fact.rows.map(row => ({ id: row.id, relation: ["same", "replaces", "overlaps"].includes(operation) && fact.text === newPort ? operation : "unrelated" })) })) };
				else if (request.callId === "E24") reply = { text: "Retain service audit reports." };
				else if (request.callId === "E22") reply = { replaces: true, faithful: true, retired_absent: true, all_facts_accounted: true };
				else if (request.callId === "E23") reply = { confirmed: true };
				else reply = { rows: data.rows?.map(row => ({ id: row.id, action: ["correct", "remove"].includes(operation) ? operation : "keep", text: firstPart })) };
				// Insert a real SQLite edit before the first planned write acquires the real mutex.
				if (operation !== "correct") queueEdit();
				return { text: JSON.stringify(reply), truncated: false };
			});
			expect.soft(store.getById(queuedTarget)?.text).toBe(edited);
			expect.soft(ids()).toEqual(["pair-new", "pair-old"]);
			for (const id of ids()) {
				expect.soft(metadata(id)).not.toHaveProperty("superseded_by");
				if (operation !== "correct" || id === queuedTarget) expect.soft(metadata(id)).not.toHaveProperty("precision_night");
			}
			expect.soft(journal(wave).some(row => row.outcome === "undecided")).toBe(true);
		});
});

describe("admission concurrency", () => {
	function seed(count: number): void {
		const insert = database.sqlite.prepare(`INSERT INTO nodix_memories
			(id, fact_id, text, category, project_id, importance, timestamp, metadata, content_hash, timezone)
			VALUES (?, ?, ?, 'episodic', 'global', 0.7, ?, ?, ?, 'UTC')`);
		database.sqlite.transaction(() => {
			for (let index = 0; index < count; index += 1) {
				const id = `admission-${String(index).padStart(3, "0")}`;
				insert.run(id, id, `The owner requires report ${index} to retain its source.`, 1_794_556_800_000,
					JSON.stringify({ precision_night: { at: Date.now(), text: id } }), id);
			}
		})();
	}
	function answer(prompt: string, vote: number): string {
		const data = payload(prompt) as Array<{ id: string }> | { rows: Array<{ id: string }> };
		if (!Array.isArray(data)) return JSON.stringify({ rows: data.rows.map(row => ({ id: row.id, confirmed: true })) });
		return JSON.stringify({ rows: data.map((row, index) => index === 0
			? { id: row.id, verdict: "delete", reason: "fixture activity record" }
			: index === 1 || vote === 1 ? { id: row.id, verdict: "unsure" }
			: { id: row.id, verdict: "keep", kind: "fact", origin: "owner", about_user: false }) });
	}
	function run(waveId: string, complete: Parameters<typeof runPrecisionNightSteps>[0]["complete"]) {
		const beforeMutation = vi.fn(async () => true);
		const done = runPrecisionNightSteps({ store, waveId, complete, beforeMutation, previousAt: Date.now() });
		return { done, beforeMutation };
	}
	it("fills the concurrency bound, applies reverse completions in input order, and equals serial results", async () => {
		seed(200);
		const expectedConcurrency = Math.min(HOST_MODEL_CONCURRENCY, Math.ceil(200 / 40));
		const original = database.sqlite.prepare("SELECT * FROM nodix_memories ORDER BY id").all() as Array<Record<string, unknown>>;
		const votes = new Map<string, number>();
		await run("serial-admission", async request => {
			const vote = votes.get(request.prompt) ?? 0; votes.set(request.prompt, vote + 1);
			return { text: answer(request.prompt, vote), truncated: false };
		}).done;
		const expectedRows = database.sqlite.prepare("SELECT id, text, metadata FROM nodix_memories ORDER BY id").all();
		const expectedJournal = journal("serial-admission");
		expect(expectedJournal.filter(entry => entry.stage === "admission" && entry.outcome === "removed")).toHaveLength(5);
		expect(expectedJournal.filter(entry => entry.stage === "admission" && entry.outcome === "undecided")).toHaveLength(5);
		database.sqlite.prepare("DELETE FROM nodix_memories").run();
		for (const row of original) {
			const columns = Object.keys(row);
			database.sqlite.prepare(`INSERT INTO nodix_memories (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
		}
		votes.clear();
		let inFlight = 0; let peak = 0;
		const waiting: Array<() => void> = [];
		const concurrent = run("parallel-admission", async request => {
			inFlight += 1; peak = Math.max(peak, inFlight);
			await new Promise<void>(resolve => waiting.push(resolve));
			inFlight -= 1;
			const vote = votes.get(request.prompt) ?? 0; votes.set(request.prompt, vote + 1);
			return { text: answer(request.prompt, vote), truncated: false };
		});
		let settled = false;
		void concurrent.done.finally(() => { settled = true; });
		try {
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(inFlight).toBe(expectedConcurrency);
			expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories WHERE json_extract(metadata, '$.precision_admission') IS NOT NULL").get()).toEqual({ count: 0 });
		} finally {
			for (let attempt = 0; !settled && attempt < 3_000; attempt += 1) {
				for (const release of waiting.splice(0).reverse()) release();
				await new Promise(resolve => setTimeout(resolve, 1));
			}
			expect(settled).toBe(true);
			await concurrent.done;
		}
		expect(peak).toBe(expectedConcurrency);
		expect(concurrent.beforeMutation).toHaveBeenCalledTimes(1);
		expect(database.sqlite.prepare("SELECT id, text, metadata FROM nodix_memories ORDER BY id").all()).toEqual(expectedRows);
		expect(journal("parallel-admission")).toEqual(expectedJournal);
	});
	it.each(["failed", "unreadable"])("keeps the other three batches after one %s call", async failure => {
		seed(160);
		let inFlight = 0;
		const waiting: Array<() => void> = [];
		const votes = new Map<string, number>();
		const started = run(`admission-${failure}`, async request => {
			inFlight += 1;
			await new Promise<void>(resolve => waiting.push(resolve));
			inFlight -= 1;
			const rows = payload(request.prompt) as Array<{ id: string }>;
			if (Array.isArray(rows) && rows[0]?.id === "admission-040") {
				if (failure === "failed") throw new Error("fixture host failed");
				return { text: "unreadable", truncated: false };
			}
			const vote = votes.get(request.prompt) ?? 0; votes.set(request.prompt, vote + 1);
			return { text: answer(request.prompt, vote), truncated: false };
		});
		let settled = false;
		void started.done.finally(() => { settled = true; });
		try {
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(inFlight).toBe(4);
		} finally {
			for (let attempt = 0; !settled && attempt < 3_000; attempt += 1) {
				for (const release of waiting.splice(0).reverse()) release();
				await new Promise(resolve => setTimeout(resolve, 1));
			}
			expect(settled).toBe(true);
			await started.done;
		}
		expect(metadata("admission-040")).not.toHaveProperty("precision_admission");
		expect(journal(`admission-${failure}`).filter(entry => entry.stage === "admission" && entry.outcome === "fine")).toHaveLength(114);
		expect(journal(`admission-${failure}`).filter(entry => entry.stage === "admission" && entry.outcome === "failed")).toHaveLength(1);
	});
	it.each([0, 1, 2, 3, 11, 12, 14])("counts every actual call with only %i calls left", async remaining => {
		seed(160);
		let actual = 0;
		const votes = new Map<string, number>();
		const budget = precisionNightBudget({ completeText: async request => {
			actual += 1;
			if (request.prompt === "spent") return "spent";
			const vote = votes.get(request.prompt) ?? 0; votes.set(request.prompt, vote + 1);
			return answer(request.prompt, vote);
		}, getLastError: () => null } as LlmClient);
		for (let index = 0; index < 100 - remaining; index += 1) await budget.llm.completeText({ callId: "E16", prompt: "spent" });
		await expect(run(`admission-budget-${remaining}`, budget.complete).done).rejects.toBeInstanceOf(NightBudgetExhausted);
		expect(actual).toBe(100);
		expect(journal(`admission-budget-${remaining}`).filter(entry => entry.outcome === "failed")).toEqual([]);
		if (remaining < 3) expect(metadata("admission-000")).not.toHaveProperty("precision_admission");
		if (remaining === 14) {
			// Two confirmation calls may run out, but every completed vote batch still applies its keep decisions.
			expect(journal(`admission-budget-${remaining}`).filter(entry => entry.stage === "admission" && entry.outcome === "fine")).toHaveLength(152);
		}
	});
});


describe("ordered pair concurrency", () => {
	const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
	type Complete = Parameters<typeof runPrecisionNightSteps>[0]["complete"];
	async function seed(count = 32, correct = false): Promise<void> {
		await plant("wave-anchor", oldPort, 1_794_400_000_000, {
			precision_admission: admitted, precision_night: { at: Date.now(), text: "placeholder" },
		});
		const anchor = store.getById("wave-anchor");
		database.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run(JSON.stringify({ ...metadata("wave-anchor"), precision_night: { at: Date.now(), text: anchor?.contentHash } }), "wave-anchor");
		if (correct) for (let group = 0; group < 4; group += 1) store.setPlaceMode({ skinId: "codex",
			projectId: `wave-project-${group}`, surface: "", mode: "work", decidedAt: Date.now() });
		const insert = database.sqlite.prepare(`INSERT INTO nodix_memories
			(id, fact_id, text, category, project_id, importance, timestamp, metadata, content_hash, timezone)
			VALUES (?, ?, ?, 'episodic', ?, 0.7, ?, ?, ?, 'UTC')`);
		for (let index = 0; index < count; index += 1) {
			const id = `wave-${String(index).padStart(3, "0")}`;
			const text = `The owner requires service report ${index} to retain its source.`;
			insert.run(id, id, text, correct ? `wave-project-${Math.floor(index / 8)}` : "global", 1_794_556_800_000 + index,
				JSON.stringify({ precision_kind: "rule", ...(correct ? { writer_agent_id: "codex" } : {}),
				precision_judged: true, precision_admission: admitted,
				source_span: { quote: correct ? `Retain the source for report ${index}.` : text }, source_order: { valid_from: null,
					session_moment: 1_794_556_800_000 + index, session_ordinal: 0,
					global_turn_index: 0, rowid: 0, conversation_id: id } }), id);
		}
	}
	function run(waveId: string, complete: Complete) {
		return runPrecisionNightSteps({ store, waveId, complete, beforeMutation: async () => true, previousAt: Date.now() });
	}
	function answer(request: Parameters<Complete>[0], conflict?: "replaces" | "overlaps", correct = false): string {
		const data = payload(request.prompt) as { facts?: Fact[]; rows?: Array<{ id: string; quote: string }>; operation?: string };
		if (request.callId === "E24") return JSON.stringify({ text: "Retain report 31 sources; use port 8070." });
		if (request.callId === "E22") return JSON.stringify({ replaces: true, faithful: true, retired_absent: true, all_facts_accounted: true });
		if (request.callId === "E23") return JSON.stringify({ confirmed: true });
		if (data.facts) return JSON.stringify({ facts: data.facts.map(fact => ({ index: fact.index,
			rows: fact.rows.map(row => ({ id: row.id, relation: conflict && row.id === "wave-anchor"
				&& ["The owner requires service report 31 to retain its source.",
					"The owner requires service report 23 to retain its source."].includes(fact.text) ? conflict : "unrelated" })) })) });
		return JSON.stringify({ rows: data.rows?.map(row => ({ id: row.id, action: correct ? "correct" : "keep", text: correct ? row.quote : "" })) });
	}
	function controlled(conflict?: "replaces" | "overlaps", failedBatch?: string, correct = false) {
		let inFlight = 0; let peak = 0;
		const waiting: Array<{ request: Parameters<Complete>[0]; release: () => void }> = [];
		const complete: Complete = async request => {
			inFlight += 1; peak = Math.max(peak, inFlight);
			await new Promise<void>(resolve => waiting.push({ request, release: resolve }));
			inFlight -= 1;
			if (failedBatch && (payload(request.prompt) as { facts?: Fact[] }).facts?.[0]?.text === failedBatch) throw new Error("fixture relation batch failed");
			return { text: answer(request, conflict, correct), truncated: false };
		};
		async function drain(done: Promise<unknown>): Promise<void> {
			let settled = false;
			void done.then(() => { settled = true; }, () => { settled = true; });
			for (let attempt = 0; !settled && attempt < 3_000; attempt += 1) {
				for (const item of waiting.splice(0).reverse()) item.release();
				await new Promise(resolve => setTimeout(resolve, 1));
			}
			expect(settled).toBe(true);
			await done;
		}
		return { complete, waiting, drain, get inFlight() { return inFlight; }, get peak() { return peak; } };
	}
	it("batches recorded rechecks with forced peers outside pending", async () => {
		await seed(40);
		const peersByText = new Map<string, string>();
		const recheckIds = ids().filter(id => id !== "wave-anchor");
		for (let index = 0; index < 40; index += 1) {
			const id = `wave-${String(index).padStart(3, "0")}`;
			const text = `The owner requires service report ${index} to retain its source.`;
			const neighbours = await precisionCandidates(store, text, "global", new Set([id]), Date.now());
			// Pick a real row outside search results so only the recorded request can supply it.
			const peer = recheckIds.find(peer => peer !== id && !neighbours.some(row => row.id === peer));
			if (!peer) throw new Error("Missing recheck peer outside semantic candidates");
			peersByText.set(text, peer);
			database.sqlite.prepare(`UPDATE nodix_memories SET metadata =
				json_set(json_remove(metadata, '$.source_span'), '$.precision_recheck_with', json(?)) WHERE id = ?`)
				.run(JSON.stringify([peer]), id);
			expect(metadata(id)).not.toHaveProperty("precision_check");
		}
		const budget = precisionNightBudget({ completeText: async request => {
			if (request.prompt === "spent") return "spent";
			const reply = await agentPort.complete({ callId: request.callId, prompt: request.prompt, maxTokens: request.maxTokens ?? 4096 });
			if (reply.kind !== "ok") throw new Error("Missing fixture model reply");
			return reply.text;
		}, getLastError: () => null } as LlmClient);
		for (let index = 0; index < 99; index += 1) await budget.llm.completeText({ callId: "E21", prompt: "spent" });
		const exhausted = await run("recorded-recheck-budget", budget.complete).then(() => undefined, error => {
			if (!(error instanceof NightBudgetExhausted)) throw error;
			return error;
		});

		const batches = modelCalls.filter(call => call.callId === "E21")
			.map(call => (payload(call.prompt) as { facts: Fact[] }).facts);
		expect.soft(batches.some(facts => facts.filter(fact => peersByText.has(fact.text)).length > 1),
			"multiple recorded rechecks must share a relation call").toBe(true);
		expect(batches.every(facts => facts.length <= 8)).toBe(true);
		for (const fact of batches.flat()) {
			expect.soft(fact.rows.map(row => row.id), `listed recheck peer for ${fact.text}`)
				.toContain(peersByText.get(fact.text));
		}
		expect(budget.exhausted).toBe(true);
		expect.soft(exhausted?.stage, "recorded rechecks must not consume the pending stage budget").toBe("ordered-pairs");
		expect(journal("recorded-recheck-budget").filter(row => row.outcome === "failed")).toEqual([]);
	});
	it.each([false, true])("skips undecided rows in the same job and retries a new job, pending %s", async pending => {
		await seed();
		const complete: Complete = async request => {
			modelCalls.push(request);
			return { text: answer(request, "replaces"), truncated: false };
		};
		const waveId = `undecided-same-job-${pending}`;
		await run(waveId, complete);
		expect(journal(waveId)).toContainEqual(expect.objectContaining({
			row_id: "wave-023", stage: "pairs", outcome: "undecided",
		}));
		expect(metadata("wave-023")).not.toHaveProperty("precision_night");
		if (pending) database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.precision_check', 'pending') WHERE id = ?")
			.run("wave-023");

		modelCalls = [];
		await run(waveId, complete);
		const repeated = modelCalls.filter(call => {
			const data = payload(call.prompt) as { facts?: Fact[]; rows?: Array<{ id: string }> };
			return data.facts?.some(fact => fact.text === "The owner requires service report 23 to retain its source.")
				|| data.rows?.some(row => row.id === "wave-023");
		});
		expect(repeated.map(call => call.callId), "the same job must not judge an already undecided row again").toEqual([]);
		expect(metadata("wave-023")).not.toHaveProperty("precision_night");

		modelCalls = [];
		await run(`${waveId}-next`, complete);
		expect(modelCalls.filter(call => call.callId === "E21").flatMap(call => {
			const data = payload(call.prompt) as { facts?: Fact[]; rows?: Array<{ id: string }> };
			return [...(data.facts?.map(fact => fact.text) ?? []), ...(data.rows?.map(row => row.id) ?? [])];
		})).toContain("wave-023");
		expect(metadata("wave-023")).toHaveProperty("precision_night");
	});
	it("retries budget-deferred rows in the same job with an explicit reason", async () => {
		await seed(1);
		judge = () => "same";
		const llm = { completeText: async request => {
			if (request.prompt === "spent") return "spent";
			const reply = await agentPort.complete({ callId: request.callId, prompt: request.prompt, maxTokens: request.maxTokens ?? 4096 });
			if (reply.kind !== "ok") throw new Error("Missing fixture model reply");
			return reply.text;
		}, getLastError: () => null } as LlmClient;
		const budget = precisionNightBudget(llm);
		for (let index = 0; index < 99; index += 1) await budget.llm.completeText({ callId: "E21", prompt: "spent" });
		await expect(run("mid-row-budget", budget.complete)).rejects.toBeInstanceOf(NightBudgetExhausted);
		const undecided = journal("mid-row-budget").filter(row => row.row_id === "wave-000" && row.stage === "pairs" && row.outcome === "undecided");
		expect(undecided).toHaveLength(1);
		expect.soft(undecided[0]?.reason, "budget deferral must be distinguishable from a refused pair").toEqual(expect.stringContaining("budget"));
		expect(metadata("wave-000")).not.toHaveProperty("precision_night");

		modelCalls = [];
		// A new pass gets a fresh call budget, while retaining the job's real journal.
		await run("mid-row-budget", precisionNightBudget(llm).complete);
		expect(modelCalls.filter(call => call.callId === "E21").flatMap(call =>
			(payload(call.prompt) as { facts: Fact[] }).facts.map(fact => fact.text)))
			.toContain("The owner requires service report 0 to retain its source.");
		expect(store.getById("wave-000")).toBeUndefined();
		expect(journal("mid-row-budget")).toContainEqual(expect.objectContaining({ stage: "duplicate", outcome: "removed" }));
	});
	it("runs relation and source batches together within the concurrency bound and matches the serial fixture", async () => {
		await seed(40);
		const expectedConcurrency = Math.min(HOST_MODEL_CONCURRENCY, Math.ceil(40 / 8));
		const original = database.sqlite.prepare("SELECT id, text, metadata FROM nodix_memories ORDER BY id").all() as Array<{ id: string; text: string; metadata: string }>;
		// The original serial path leaves all texts intact and emits one ordered fine journal per due row.
		const expectedRows = original.map(row => row.id === "wave-anchor" ? row : { ...row,
			metadata: JSON.stringify({ ...JSON.parse(row.metadata), precision_night: { at: Date.now(), text: row.id } }) });
		const expectedJournal = original.filter(row => row.id !== "wave-anchor").reverse().map(row => ({
			stage: "pairs", job_type: "precision-nightly", outcome: "fine", row_id: row.id, reason: null,
			detail: JSON.stringify({ scope: "shared", projectId: "global", sameVendor: false, rows: [row.id], error: null }),
		}));
		const port = controlled();
		const done = run("parallel-pairs", port.complete);
		try {
			await vi.waitFor(() => expect(port.waiting).toHaveLength(expectedConcurrency), { timeout: 10_000 });
			expect(port.waiting.every(item => (payload(item.request.prompt) as { facts?: Fact[] }).facts?.length === 8)).toBe(true);
			expect(journal("parallel-pairs")).toEqual([]);
			for (const item of port.waiting.splice(0).reverse()) item.release();
			await vi.waitFor(() => expect(port.waiting).toHaveLength(expectedConcurrency), { timeout: 10_000 });
			expect(port.waiting.every(item => Array.isArray((payload(item.request.prompt) as { rows?: unknown[] }).rows))).toBe(true);
		} finally { await port.drain(done); }
		expect(port.peak).toBe(expectedConcurrency);
		expect(database.sqlite.prepare("SELECT id, text, metadata FROM nodix_memories ORDER BY id").all()).toEqual(expectedRows);
		expect(journal("parallel-pairs")).toEqual(expectedJournal);
	});
	it("prepares four source confirmations together and applies the serial correction fixture in order", async () => {
		await seed(32, true);
		const original = database.sqlite.prepare("SELECT id, text, metadata, project_id FROM nodix_memories ORDER BY id").all() as Array<{ id: string; text: string; metadata: string; project_id: string }>;
		const port = controlled(undefined, undefined, true);
		const done = run("parallel-source-corrections", port.complete);
		try {
			for (let stage = 0; stage < 3; stage += 1) {
				await vi.waitFor(() => expect(port.waiting).toHaveLength(4), { timeout: 10_000 });
				if (stage === 2) {
					expect(port.waiting.every(item => item.request.callId === "E23")).toBe(true);
					expect(database.sqlite.prepare("SELECT id, text, metadata, project_id FROM nodix_memories ORDER BY id").all()).toEqual(original);
				} else for (const item of port.waiting.splice(0).reverse()) item.release();
			}
		} finally { await port.drain(done); }
		expect(port.peak).toBe(4);
		expect(database.sqlite.prepare("SELECT id, text, metadata, project_id FROM nodix_memories ORDER BY id").all())
			.toEqual(original.map(row => row.id === "wave-anchor" ? row : { ...row,
				text: JSON.parse(row.metadata).source_span.quote,
				metadata: JSON.stringify({ kind: "episodic", l0_abstract: JSON.parse(row.metadata).source_span.quote,
					l1_overview: `- ${JSON.parse(row.metadata).source_span.quote}`, l2_content: JSON.parse(row.metadata).source_span.quote,
					memory_category: "episodic", tier: "working", access_count: 0, confidence: 0.7,
					last_accessed_at: JSON.parse(row.metadata).source_order.session_moment,
					asserted_at: JSON.parse(row.metadata).source_order.session_moment, state: "confirmed", source: "legacy",
					injected_count: 0, bad_recall_count: 0, suppressed_until_turn: 0, temporal_resolution_status: "unresolved",
					...JSON.parse(row.metadata), rem_updated_at: Date.now() }) }));
		expect(journal("parallel-source-corrections")).toEqual(original.filter(row => row.id !== "wave-anchor").reverse().map(row => ({
			stage: "source-sentence", job_type: "precision-nightly", outcome: "corrected", row_id: row.id, reason: null,
			detail: JSON.stringify({ scope: "project", projectId: row.project_id, sameVendor: true, rows: [row.id], error: null }),
		})));
	});
	it("journals one refused merge for the same pair encountered in two batches", async () => {
		await seed();
		for (const id of ["wave-031", "wave-023"]) {
			const row = store.getById(id);
			if (!row) throw new Error("missing fixture row");
			await store.deleteMany([id]);
			await plant(id, row.text, row.timestamp, JSON.parse(row.metadata));
		}
		const port = controlled();
		const complete: Complete = async request => {
			const result = await port.complete(request);
			const data = payload(request.prompt) as { facts?: Fact[] };
			let text: string | undefined;
			if (data.facts) text = JSON.stringify({ facts: data.facts.map(fact => ({ index: fact.index,
				rows: fact.rows.map(row => ({ id: row.id, relation:
					fact.text === "The owner requires service report 31 to retain its source." && row.id === "wave-023"
					|| fact.text === "The owner requires service report 23 to retain its source." && row.id === "wave-031"
						? "overlaps" : "unrelated" })) })) });
			if (request.callId === "E24") text = JSON.stringify({ text: "Retain sources for reports 31 and 23." });
			if (request.callId === "E22") text = JSON.stringify({ faithful: false, retired_absent: true, all_facts_accounted: true });
			return text === undefined ? result : { text, truncated: false };
		};
		await port.drain(run("refused-cross-batch-pair", complete));
		expect(journal("refused-cross-batch-pair").filter(row => row.stage === "merge"))
			.toEqual([expect.objectContaining({ outcome: "undecided", reason: "merge verification refused" })]);
		expect(store.getById("wave-031")?.text).toBe("The owner requires service report 31 to retain its source.");
		expect(store.getById("wave-023")?.text).toBe("The owner requires service report 23 to retain its source.");
	});
	it.each(["replaces", "overlaps"] as const)("applies only the first %s of a shared row and leaves the conflicting row due", async conflict => {
		await seed();
		const port = controlled(conflict);
		await port.drain(run(`conflicting-${conflict}`, port.complete));
		const applied = journal(`conflicting-${conflict}`).filter(row => ["replaced", "merged"].includes(row.outcome));
		expect(applied).toHaveLength(1);
		expect(metadata("wave-anchor")).toHaveProperty("superseded_by");
		if (conflict === "replaces") expect(metadata("wave-031")).toHaveProperty("precision_night");
		expect(store.getById("wave-023")?.text).toBe("The owner requires service report 23 to retain its source.");
		expect(metadata("wave-023")).not.toHaveProperty("precision_night");
		expect(metadata("wave-023")).not.toHaveProperty("superseded_by");
		expect(journal(`conflicting-${conflict}`).filter(row => row.row_id === "wave-023"))
			.toContainEqual(expect.objectContaining({ stage: "pairs", outcome: "undecided" }));
		const activeRows = store.readActivePrecisionRows("global");
		expect(activeRows).toHaveLength(32);
		if (conflict === "overlaps") expect(activeRows.some(row => row.text === "Retain report 31 sources; use port 8070.")).toBe(true);
	});
	it.each([1, 4, 5, 7])("applies returned results without exceeding the budget with %i calls left", async remaining => {
		await seed();
		let calls = 0;
		const budget = precisionNightBudget({ completeText: async request => {
			calls += 1;
			return request.prompt === "spent" ? "spent" : answer(request);
		}, getLastError: () => null } as LlmClient);
		for (let index = 0; index < 100 - remaining; index += 1) await budget.llm.completeText({ callId: "E21", prompt: "spent" });
		await expect(run(`pair-budget-${remaining}`, budget.complete)).rejects.toBeInstanceOf(NightBudgetExhausted);
		expect(calls).toBe(100);
		expect(journal(`pair-budget-${remaining}`).filter(row => row.outcome === "failed")).toEqual([]);
		const marked = ids().filter(id => id !== "wave-anchor" && metadata(id).precision_night);
		expect(marked).toHaveLength(Math.max(0, remaining - 4) * 8);
	});
	it.each([5, 8, 9, 11, 15])("preserves completed corrections when the budget ends with %i calls left", async remaining => {
		await seed(32, true);
		let calls = 0;
		const budget = precisionNightBudget({ completeText: async request => {
			calls += 1;
			return request.prompt === "spent" ? "spent" : answer(request, undefined, true);
		}, getLastError: () => null } as LlmClient);
		for (let index = 0; index < 100 - remaining; index += 1) await budget.llm.completeText({ callId: "E21", prompt: "spent" });
		await expect(run(`correction-budget-${remaining}`, budget.complete)).rejects.toBeInstanceOf(NightBudgetExhausted);
		expect(calls).toBe(100);
		expect(journal(`correction-budget-${remaining}`).filter(row => row.outcome === "failed")).toEqual([]);
		expect(journal(`correction-budget-${remaining}`).filter(row => row.outcome === "corrected")).toHaveLength(Math.max(0, remaining - 8));
		expect(ids().filter(id => id !== "wave-anchor" && metadata(id).precision_night)).toEqual([]);
	});
	it("applies the other three batches when one relation call fails", async () => {
		await seed();
		const port = controlled(undefined, "The owner requires service report 23 to retain its source.");
		await port.drain(run("pair-failure", port.complete));
		expect(journal("pair-failure").filter(row => row.stage === "pairs" && row.outcome === "failed")).toHaveLength(8);
		expect(journal("pair-failure").filter(row => row.stage === "pairs" && row.outcome === "fine")).toHaveLength(24);
		expect(metadata("wave-023")).not.toHaveProperty("precision_night");
		expect(metadata("wave-031")).toHaveProperty("precision_night");
		expect(metadata("wave-015")).toHaveProperty("precision_night");
		expect(metadata("wave-007")).toHaveProperty("precision_night");
	});
});
