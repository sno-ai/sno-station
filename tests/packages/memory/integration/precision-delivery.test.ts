/** Precision delivery through the real contract runtime, encrypted store and retrieval. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { countTokens } from "@snoai/chunking";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { defaultSettings, settingsSchema } from "../../../../packages/memory/config/settings";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { WORK_MEMORY_ADMISSION } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { judgeNightlyLoadedFiles } from "../../../../packages/memory/src/engine/precision-loaded-files";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/schema";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import type { AgentLlmPort } from "../../../../packages/memory/src/model/agent-llm-port";
import { runPrecisionNightly } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let access: AccessTracker;
let runtime: MemoryContractRuntime;
const scope = { principal: "owner", project: "agent:precision", session: "delivery" };
type LoadedFile = { path: string; sha256: string; bytes: number };

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	database = createTestDb();
	installRemSchema(database.runtime.db);
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	const config = pluginConfigSchema.parse({ mode: "agent-native", modelCalls: defaultSettings().modelCalls,
		autoRecall: true, retrieval: { rerank: "none" }, observe: { enabled: false } });
	access = new AccessTracker({ store });
	const logger = { info: () => {}, warn: () => {}, error: () => {} };
	runtime = new MemoryContractRuntime({ config, store, embedder, accessTracker: access,
		agentPort: { async complete({ prompt }) { return { kind: "ok", text: JSON.stringify(writeReply(prompt)) }; } },
		retriever: createRetriever(store, embedder, undefined, config.retrieval), logger,
		stateDir: dirname(database.dbPath), observability: new PluginObservability(config, dirname(database.dbPath), logger) });
	await runtime.init(scope, { skinId: "claude-code" });
});
afterEach(async () => {
	await runtime?.close(); await access?.destroy(); await store?.close(); database?.cleanup();
});

async function row(text: string, extra: Record<string, unknown> = {}, projectId = scope.project,
	importance = 0.7, kind = "rule") {
	return store.store({ text, category: "episodic", projectId, importance,
		metadata: JSON.stringify({ precision_kind: kind, ...extra }) });
}
function metadata(id: string) { return JSON.parse(store.getById(id)?.metadata ?? "{}"); }
function mark(id: string, values: Record<string, unknown>) {
	database.sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
		.run(JSON.stringify({ ...metadata(id), ...values }), id);
}
function plant(id: string, text: string, extra: Record<string, unknown> = {}, projectId = scope.project, kind = "fact") {
	database.sqlite.prepare(`INSERT INTO nodix_memories
		(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
		VALUES (?, ?, 'episodic', ?, 0.7, 1000, 'UTC', ?, ?, ?)`).run(id, text, projectId,
		JSON.stringify({ precision_kind: kind, ...extra }), createHash("sha256").update(text).digest("hex"), id);
}
function start(session: string, project = scope.project, loadedFiles?: LoadedFile[]) {
	return runtime.getRecall("Start work.", { ...scope, project, session },
		{ source: "auto", injectionPhase: "session-start", loadedFiles });
}
function prompt(session: string, query: string, project = scope.project, loadedFiles?: LoadedFile[]) {
	return runtime.getRecall(query, { ...scope, project, session },
		{ source: "auto", injectionPhase: "prompt", minScore: 0, limit: 20, maxChars: 10_000, loadedFiles });
}
function delivered(result: Awaited<ReturnType<typeof runtime.getRecall>>) {
	expect(result.degraded).toBe(false);
	return result.memoryIds;
}
async function file() {
	const text = "Use port 8090 for the release service.";
	const path = join(dirname(database.dbPath), "CLAUDE.md");
	await writeFile(path, text);
	return { path, bytes: 38, sha256: createHash("sha256").update(text).digest("hex") };
}
function verdict(id: string, loaded: LoadedFile, value: "said" | "opposite") {
	const stored = store.getById(id);
	if (!stored) throw new Error(`Missing fixture row ${id}`);
	store.setLoadedFileJudgment({ memoryId: id, memoryContentHash: stored.contentHash,
		filePath: loaded.path, fileSha256: loaded.sha256, verdict: value, judgedAt: 1794693600000 });
}

// Only the external host model is scripted. Capture, judgement, parsing and writes remain real.
function writeReply(prompt: string): unknown {
	if (prompt.startsWith("Each fact is about to be stored as a memory.")) {
		const data = JSON.parse(prompt.trimEnd().split("\n").at(-1) ?? "null") as {
			facts: Array<{ index: number; rows: Array<{ id: string }> }>;
		};
		return { facts: data.facts.map(fact => ({ index: fact.index,
			rows: fact.rows.map(row => ({ id: row.id, relation: "replaces" })) })) };
	}
	if (prompt.startsWith("Does the new statement make the older memory")) return { replaces: true };
	if (prompt.startsWith("Judge whether this conversation's place")) return { mode: "work" };
	if (prompt.includes("facts:\n")) return { enrichments: [{ id: 0, kind: "standing",
		attribute: "preference.communication_style", value: "Use port 8100 for the release service.",
		ends_current: false, importance: "high", changes_current_state: false, todo: "none", close_reason: null,
		single_claim: true, relations: [], time: { kind: "none" }, ended_time: { kind: "none" } }] };
	if (prompt.includes("response_schema:") && prompt.includes("<take>") && !prompt.includes("Task:")) return {
		claims_found: [0], decisions: [{ turn_index: 0, progress_only: false }], facts: [{ id: 0,
			fact: "Use port 8100 for the release service.", kind: "rule", subject: "agent", subject_kind: "agent",
			temporal_phrase: null, ended_at_phrase: null,
			source_span: { turn_index: 0, quote: "Use port 8100 for the release service." } }],
	};
	if (prompt.includes("durable_self_statement")) return { decisions: [{ record_index: 0, durable_self_statement: true }] };
	if (prompt.includes("Task: resolve each unresolved standing subject")) return { resolutions: [] };
	if (prompt.includes('"new_display_name":')) return { entity_id: "new" };
	throw new Error(`Unscripted external model request: ${prompt.slice(0, 100)}`);
}

function journal(job: string, stage: string, outcome: string, scopeName = "project", rows: string[] = [], error: string | null = null) {
	database.sqlite.prepare(`INSERT INTO nodix_rem_journal
		(job_id, job_type, stage, outcome, row_id, actions_applied, reason, detail)
		VALUES (?, 'precision-nightly', ?, ?, ?, ?, ?, ?)`).run(job, stage, outcome, rows[0] ?? null,
		["replaced", "merged", "corrected", "removed"].includes(outcome) ? 1 : 0,
		error, JSON.stringify({ scope: scopeName, rows, error }));
}
function undo(id: string) {
	// The specified wire input must reach today's parser even before its union includes undo.
	return runtime.mutate(JSON.parse(JSON.stringify({ op: "undo", id })), scope);
}
async function replacementChain() {
	const a = await row("Use port 8070 for the release service.", { source_order: {
		valid_from: null, session_moment: 1794265200000, session_ordinal: 0,
		global_turn_index: 0, rowid: 0, conversation_id: "original-rule",
	} });
	const b = await row("Use port 8090 for the release service.", { source_order: {
		valid_from: null, session_moment: 1794351600000, session_ordinal: 1,
		global_turn_index: 0, rowid: 0, conversation_id: "changed-rule",
	} });
	mark(a.id, { superseded_by: b.id, superseded_at: "2026-11-11T00:00:00Z", supersede_reason: "write-judgement" });
	return { a, b };
}

it("orders ranks before core before topic, then importance and newest within each group", async () => {
	const rankTwo = await row("Rank two.", { start_rank: 2 }, "global", 1);
	const rankOne = await row("Rank one.", { start_rank: 1 }, scope.project, 0.1);
	const coreOld = await row("Older important core rule.", { start_label: "core" }, scope.project, 0.8);
	const coreNew = await row("Newer important core rule.", { start_label: "core" }, scope.project, 0.8);
	const coreLow = await row("Less important core rule.", { start_label: "core" }, scope.project, 0.2);
	const topicOld = await row("Older important topic rule.", { start_label: "topic" }, scope.project, 0.9);
	const topicNew = await row("Newer important topic rule.", { start_label: "topic" }, scope.project, 0.9);
	const topicLow = await row("Less important topic rule.", { start_label: "topic" }, scope.project, 0.3);
	for (const id of [coreOld.id, topicOld.id]) database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 1000 WHERE id = ?").run(id);
	for (const id of [coreNew.id, topicNew.id]) database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 2000 WHERE id = ?").run(id);
	const result = await start("ordered");
	expect(delivered(result)).toEqual([rankOne.id, rankTwo.id, coreNew.id, coreOld.id, coreLow.id, topicNew.id, topicOld.id, topicLow.id]);
});

it("delivers an unlabelled unranked row even when another row is ranked", async () => {
	const ranked = await row("Chosen first.", { start_rank: 1 });
	const unranked = await row("A new rule still needed at session start.");
	expect(delivered(await start("unranked"))).toEqual([ranked.id, unranked.id]);
});

it("keeps drop-labelled rows out of session start but available per message", async () => {
	const dropped = await row("Use port 8090 for the release service.", { start_label: "drop" });
	expect.soft(delivered(await start("drop-start"))).toEqual([]);
	expect(delivered(await prompt("drop-prompt", "Use port 8090 for the release service."))).toEqual([dropped.id]);
});

it("delivers every eligible row when all fit", async () => {
	const core = await row("Explain the release risk.", { start_label: "core" }, "global", 0.9);
	const topic = await row("Check replication before deployment.", { start_label: "topic" }, scope.project, 0.8, "pitfall");
	const unlabelled = await row("Keep release notes concise.", {}, scope.project, 0.7);
	expect(delivered(await start("all-fit"))).toEqual([core.id, topic.id, unlabelled.id]);
});

it("stops at 1000 tokens without splitting a row", async () => {
	for (let index = 1; index <= 60; index++) {
		const id = `budget-${String(index).padStart(2, "0")}`;
		const text = `Component ${index}: Explain the release risk and wait for approval before publishing.`;
		database.sqlite.prepare(`INSERT INTO nodix_memories
			(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
			VALUES (?, ?, 'episodic', 'agent:precision', 0.7, 1000, 'UTC', ?, ?, ?)`).run(
			id, text, JSON.stringify({ precision_kind: "rule", start_rank: index }), createHash("sha256").update(text).digest("hex"), id);
	}
	const result = await start("token-budget");
	expect(result.degraded).toBe(false);
	expect.soft(countTokens(result.contextText)).toBeLessThanOrEqual(1000);
	expect.soft(result.contextText).toContain("Component 1: Explain the release risk and wait for approval before publishing. [id:budget-01]");
	expect(result.contextText).not.toContain("Component 60:");
});

it.each(["session-start", "prompt"] as const)("suppresses an opposite row only for sessions loading that file version during %s", async phase => {
	const memory = await row("Use port 8070 for the release service.");
	const loaded = await file();
	verdict(memory.id, loaded, "opposite");
	const recall = (session: string, files: LoadedFile[]) => phase === "session-start"
		? start(session, scope.project, files) : prompt(session, "Use port 8070 for the release service.", scope.project, files);
	expect.soft(delivered(await recall("claude-loaded", [loaded]))).toEqual([]);
	await runtime.init(scope, { skinId: "codex" });
	expect.soft(delivered(await recall("codex-no-file", []))).toEqual([memory.id]);
	expect.soft(delivered(await recall("different-file-version", [{ ...loaded, sha256: "f".repeat(64) }]))).toEqual([memory.id]);
	expect(metadata(memory.id)).not.toHaveProperty("superseded_by");
});

it("suppresses said during per-message recall only where the matching file is loaded", async () => {
	const memory = await row("Use port 8090 for the release service.");
	const loaded = await file();
	verdict(memory.id, loaded, "said");
	expect.soft(delivered(await prompt("said-loaded", "Use port 8090 for the release service.", scope.project, [loaded]))).toEqual([]);
	await runtime.init(scope, { skinId: "codex" });
	expect(delivered(await prompt("said-not-loaded", "Use port 8090 for the release service.", scope.project, []))).toEqual([memory.id]);
});

it.each(["said", "opposite"] as const)("remembers the session's loaded file for later prompts with a %s verdict", async value => {
	const memory = await row("Use port 8070 for the release service.", {}, scope.project, 0.7, "fact");
	const loaded = await file();
	verdict(memory.id, loaded, value);
	expect(delivered(await start("loaded-session", scope.project, [loaded]))).toEqual([]);
	expect.soft(delivered(await prompt("loaded-session", "Use port 8070 for the release service."))).toEqual([]);
	await runtime.init(scope, { skinId: "codex" });
	expect(delivered(await start("other-agent", scope.project, []))).toEqual([]);
	expect(delivered(await prompt("other-agent", "Use port 8070 for the release service."))).toEqual([memory.id]);
});

it.each(["decision", "fact", "pitfall"])("nightly comparison judges a %s without a stored verdict and suppresses its per-message delivery", async kind => {
	const memory = await row("Use port 8070 for the release service.", {}, scope.project, 0.7, kind);
	const loaded = await file();
	store.setPlaceLoadedFiles({ skinId: "claude-code", projectId: scope.project, surface: "", files: [loaded], updatedAt: 1794693600000 });
	expect(store.getLoadedFileJudgments(memory.id)).toEqual([]);
	const llm = await createLlmClient({ preset: "mem_claw/sno_extract_chat", usageClass: "research", timeoutMs: 5_000,
		routing: { mode: "agent-native", language: "en", modelCalls: defaultSettings().modelCalls },
		agentPort: { async complete() { return { kind: "ok", text: JSON.stringify({ rows: [
			{ id: memory.id, verdict: "opposite", quote: "Use port 8090 for the release service." },
		] }) }; } } });
	await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath));
	expect.soft(store.getLoadedFileJudgments(memory.id)).toMatchObject([{ filePath: loaded.path, verdict: "opposite" }]);
	expect.soft(delivered(await prompt("night-file-loaded", "Use port 8070 for the release service.", scope.project, [loaded]))).toEqual([]);
	await runtime.init(scope, { skinId: "codex" });
	expect(delivered(await prompt("night-no-file", "Use port 8070 for the release service.", scope.project, []))).toEqual([memory.id]);
});

it.each(["session-start", "prompt"] as const)("delivers the project exception instead of the shared row during %s", async phase => {
	const shared = await row("Use port 8070 for the release service.", {}, "global");
	const exception = await row("Use port 8090 for the release service.", { overrides_shared: shared.id });
	const recall = (session: string, project: string) => phase === "session-start"
		? start(session, project) : prompt(session, "Which port does the release service use?", project);
	expect.soft(delivered(await recall("exception-project", scope.project))).toEqual([exception.id]);
	expect(delivered(await recall("shared-other-project", "agent:other"))).toEqual([shared.id]);
});

it.each(["session-start", "prompt"] as const)("follows a shared replacement before the night rejudges its project exception during %s", async phase => {
	const shared = await row("Use port 8070 for the release service.", {}, "global");
	const exception = await row("Use port 8090 for the release service.", { overrides_shared: shared.id });
	const successor = await row("Use port 8100 for the release service.", {}, "global");
	mark(shared.id, { superseded_by: successor.id, superseded_at: "2026-11-15T01:00:00Z", supersede_reason: "night" });
	const recall = (session: string, project: string) => phase === "session-start"
		? start(session, project) : prompt(session, "Which port does the release service use?", project);
	expect.soft(delivered(await recall("replacement-exception-project", scope.project))).toEqual([exception.id]);
	expect(delivered(await recall("replacement-other-project", "agent:other"))).toEqual([successor.id]);
});

it("never automatically delivers replaced rows and explicit lookup returns their replaced mark", async () => {
	const current = await row("Use port 8090 for the release service.");
	const retired = await row("Use port 8070 for the release service.", { superseded_by: current.id,
		superseded_at: "2026-11-15T01:00:00Z", supersede_reason: "write-judgement" });
	expect.soft(delivered(await start("retired-start"))).toEqual([current.id]);
	expect.soft(delivered(await prompt("retired-prompt", "Which port does the release service use?"))).toEqual([current.id]);
	const lookedUp = await runtime.inspect({ op: "get", id: retired.id }, scope);
	expect(lookedUp).toMatchObject({ degraded: false, result: { op: "get", entry: {
		id: retired.id, text: `Use port 8070 for the release service.\nretired; superseded by ${current.id}`,
	} } });
});

it("inspection reports literal counts for both scopes and only the last three nights, including rows that did not fit", async () => {
	// The design leaves the operation's wire name open. This test specifies `precision` and
	// structured numbers alongside service-rendered lines shared by all three doctor commands.
	for (const scopeName of ["project", "shared"]) {
		const projectId = scopeName === "shared" ? "global" : scope.project;
		const oldId = `${scopeName}-old-night`;
		plant(oldId, `A fact checked before the last three nights in ${scopeName}.`, {}, projectId);
		journal("night-2026-11-12", "admission", "fine", scopeName, [oldId]);
		for (const outcome of ["replaced", "merged", "corrected", "removed", "fine", "undecided", "failed"]) {
			const id = `${scopeName}-${outcome}`;
			plant(id, `A ${scopeName} fact with outcome ${outcome}.`, {}, projectId);
			journal("night-2026-11-13", outcome === "failed" ? "loaded-file" : "admission", outcome, scopeName, [id],
				outcome === "failed" ? `${scopeName} file unreadable` : null);
		}
	}
	plant("project-fine-one", "The first checked project fact.");
	plant("project-fine-two", "The second checked project fact.");
	journal("night-2026-11-14", "admission", "fine", "project", ["project-fine-one"]);
	journal("night-2026-11-14", "admission", "fine", "project", ["project-fine-two"]);
	plant("shared-undecided-one", "The first undecided shared fact.", {}, "global");
	plant("shared-undecided-two", "The second undecided shared fact.", {}, "global");
	journal("night-2026-11-14", "admission", "undecided", "shared", ["shared-undecided-one"]);
	journal("night-2026-11-14", "admission", "undecided", "shared", ["shared-undecided-two"]);
	for (const [id, outcome, scopeName] of [
		["project-replaced-one", "replaced", "project"], ["project-replaced-two", "replaced", "project"],
		["project-fine-three", "fine", "project"], ["shared-corrected-one", "corrected", "shared"],
		["shared-removed-one", "removed", "shared"], ["shared-undecided-three", "undecided", "shared"],
	] as const) {
		plant(id, `Night three fact ${id}.`, {}, scopeName === "shared" ? "global" : scope.project);
		journal("night-2026-11-15", "admission", outcome, scopeName, [id]);
	}
	plant("pending-project-one", "First project fact awaiting judgement.", { precision_check: "pending" });
	plant("pending-project-two", "Second project fact awaiting judgement.", { precision_check: "pending" });
	plant("pending-shared", "Shared fact awaiting judgement.", { precision_check: "pending" }, "global");
	plant("other-project-pending", "Another project's pending fact.", { precision_check: "pending" }, "agent:other");
	for (let index = 1; index <= 3; index++) {
		plant(`overflow-project-${index}`, `Project rule ${index}:` + " token".repeat(300) + ".", { start_rank: index }, scope.project, "rule");
	}
	plant("overflow-shared", "Shared rule:" + " token".repeat(1100) + ".", { start_rank: 1 }, "global", "rule");
	const loaded = await file();
	plant("file-conflict", "Use port 8070 for the release service.");
	verdict("file-conflict", loaded, "opposite");
	plant("file-said", "Use port 8090 for the release service.");
	verdict("file-said", loaded, "said");
	const opening = await start("doctor-overflow", scope.project, [loaded]);
	expect(delivered(opening)).toEqual(["overflow-project-1"]);
	expect(countTokens(opening.contextText)).toBeLessThanOrEqual(1000);
	const inspected = await runtime.inspect(JSON.parse('{"op":"precision"}'), scope);
	expect.soft(inspected).toMatchObject({ degraded: false, result: {
		op: "precision", pending: { project: ["pending-project-one", "pending-project-two"], shared: ["pending-shared"] },
		notFit: { project: 2, shared: 1 }, contradictions: [{ id: "file-conflict", filePath: loaded.path }],
	} });
	expect.soft(inspected).toHaveProperty("result.nights.length", 6);
	expect(inspected).toHaveProperty("result.nights", expect.arrayContaining([
		{ jobId: "night-2026-11-15", scope: "project", checked: 3, replaced: 2, merged: 0, corrected: 0, removed: 0, undecided: 0, failures: [] },
		{ jobId: "night-2026-11-15", scope: "shared", checked: 3, replaced: 0, merged: 0, corrected: 1, removed: 1, undecided: 1, failures: [] },
		{ jobId: "night-2026-11-14", scope: "project", checked: 2, replaced: 0, merged: 0, corrected: 0, removed: 0, undecided: 0, failures: [] },
		{ jobId: "night-2026-11-14", scope: "shared", checked: 2, replaced: 0, merged: 0, corrected: 0, removed: 0, undecided: 2, failures: [] },
		{ jobId: "night-2026-11-13", scope: "project", checked: 6, replaced: 1, merged: 1, corrected: 1, removed: 1, undecided: 1,
			failures: [{ stage: "loaded-file", error: "project file unreadable", rows: ["project-failed"] }] },
		{ jobId: "night-2026-11-13", scope: "shared", checked: 6, replaced: 1, merged: 1, corrected: 1, removed: 1, undecided: 1,
			failures: [{ stage: "loaded-file", error: "shared file unreadable", rows: ["shared-failed"] }] },
	]));
});

it("keeps a project's failed night in doctor numbers and session start after three other-project nights", async () => {
	plant("project-a-rule", "Explain the release risk.", {}, scope.project, "rule");
	plant("project-a-failed", "Use port 8070 for the release service.");
	journal("project-a-night", "admission", "fine", "project", ["project-a-rule"]);
	journal("project-a-night", "loaded-file", "failed", "project", ["project-a-failed"], "project A instruction file unreadable");
	plant("project-b-fact", "Project B uses port 8090 for its release service.", {}, "agent:other");
	for (const job of ["project-b-night-one", "project-b-night-two", "project-b-night-three"]) {
		journal(job, "admission", "fine", "project", ["project-b-fact"]);
	}

	const inspected = await runtime.inspect({ op: "precision" }, scope);
	expect.soft(inspected).toMatchObject({ degraded: false });
	expect.soft(inspected).toHaveProperty("result.nights", [
		{ jobId: "project-a-night", scope: "project", checked: 1, replaced: 0, merged: 0, corrected: 0, removed: 0, undecided: 0,
			failures: [{ stage: "loaded-file", error: "project A instruction file unreadable", rows: ["project-a-failed"] }] },
		{ jobId: "project-a-night", scope: "shared", checked: 0, replaced: 0, merged: 0, corrected: 0, removed: 0, undecided: 0, failures: [] },
	]);
	const opening = await start("project-a-after-project-b-nights");
	expect.soft(delivered(opening)).toEqual(["project-a-rule"]);
	expect.soft(opening.contextText.split("\n").filter(line => line.startsWith("Memory check failed last night:")))
		.toEqual(["Memory check failed last night: loaded-file; run memory doctor for details."]);
});

it("adds exactly one session-start line naming a step that failed in the last night", async () => {
	const memory = await row("Explain the release risk.");
	const healthy = await start("before-night-failure");
	journal("night-2026-11-15", "loaded-file", "failed", "project", [memory.id], "instruction file unreadable");
	const result = await start("after-night-failure");
	expect.soft(delivered(result)).toEqual([memory.id]);
	const extra = result.contextText.split("\n").filter(line => !healthy.contextText.split("\n").includes(line));
	expect.soft(extra).toHaveLength(1);
	expect(extra.join("\n")).toContain("loaded-file");
});

it("adds no session-start line when the last night is healthy, even after an earlier failure", async () => {
	const memory = await row("Explain the release risk.");
	const before = await start("before-healthy-night");
	journal("night-2026-11-14", "loaded-file", "failed", "project", [memory.id], "old file error");
	journal("night-2026-11-15", "admission", "fine", "project", [memory.id]);
	const after = await start("after-healthy-night");
	expect(after.contextText).toBe(before.contextText);
	expect(delivered(after)).toEqual([memory.id]);
});

it.each(["loaded-files", "ordered-pairs"] as const)(
	"a real night defers loaded-file overflow or completes batched ordered pairs without failures or extra session-start lines (%s)", async stage => {
		const admitted = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
		const checkedAt = Date.now();
		plant("budget-visible", "Explain the release risk.", {
			writer_agent_id: "codex", start_label: "topic", precision_admission: admitted,
			precision_night: { at: checkedAt, text: createHash("sha256").update("Explain the release risk.").digest("hex") },
		}, scope.project, "rule");
		store.setPlaceMode({ skinId: "codex", projectId: scope.project, surface: "", mode: "work", decidedAt: checkedAt });
		for (let index = 0; index < 103; index += 1) {
			const text = `The invented Willow archive stores release record number ${index}.`;
			const stored = await row(text, { precision_admission: admitted }, "global", 0.7, "fact");
			database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 1000 WHERE id = ?").run(stored.id);
			if (stage === "loaded-files") mark(stored.id, { precision_night: { at: checkedAt, text: stored.contentHash } });
		}
		const loaded = await file();
		store.setPlaceLoadedFiles({ skinId: "codex", projectId: "global", surface: "", files: [loaded], updatedAt: checkedAt });
		const settings = settingsSchema.parse(writeSettingsFixture(dirname(database.dbPath), {
			mode: "agent-native", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
			telemetry: { memoryUsage: { enabled: false } },
		}).settings);
		const relationBatchSizes: number[] = [];
		const agentPort: AgentLlmPort = { async complete(request) {
			const data = JSON.parse(request.prompt.trimEnd().split("\n").at(-1) ?? "null");
			if (request.callId === "E15") return { kind: "ok", text: JSON.stringify({ rows: data.rows.map((row: { id: string }) => ({
				id: row.id, quote: "", verdict: "not-said",
			})) }) };
			if (request.callId === "E21") {
				relationBatchSizes.push(data.facts.length);
				return { kind: "ok", text: JSON.stringify({ facts: data.facts.map((fact: {
					index: number; rows: Array<{ id: string }>;
				}) => ({ index: fact.index, rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })) })) }) };
			}
			throw new Error(`Unexpected budget-delivery model call ${request.callId}`);
		} };
		await runPrecisionNightly({ settings, mode: "agent-native", agentPort,
			waveId: `delivery-exhausted-${stage}` });

		const inspected = await runtime.inspect({ op: "precision" }, scope);
		expect.soft(inspected).toMatchObject({ degraded: false, result: { op: "precision" } });
		expect.soft(inspected).toHaveProperty("result.nights.length", 2);
		expect.soft(inspected).toHaveProperty("result.nights.0.failures", []);
		expect.soft(inspected).toHaveProperty("result.nights.1.failures", []);
		const opening = await start(`after-exhausted-${stage}`);
		expect.soft(delivered(opening)).toEqual(["budget-visible"]);
		expect.soft(opening.contextText.split("\n").slice(1)).toEqual(["Explain the release risk. [id:budget-visible]"]);
		expect.soft(database.sqlite.prepare(`SELECT count(*) AS failures FROM nodix_rem_journal
			WHERE job_id = ? AND outcome = 'failed'`).get(`delivery-exhausted-${stage}`)).toEqual({ failures: 0 });
		if (stage === "loaded-files") {
			expect.soft(database.sqlite.prepare("SELECT count(*) AS judged FROM nodix_loaded_file_judgments").get()).toEqual({ judged: 100 });
		} else {
			expect.soft(relationBatchSizes).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7]);
			expect.soft(database.sqlite.prepare(`SELECT count(*) AS remaining FROM nodix_memories
				WHERE project_id = 'global' AND json_extract(metadata, '$.precision_night') IS NULL`).get()).toEqual({ remaining: 0 });
			expect.soft(database.sqlite.prepare(`SELECT count(*) AS checked FROM nodix_memories
				WHERE project_id = 'global' AND json_extract(metadata, '$.precision_night.at') IS NOT NULL
				AND json_extract(metadata, '$.precision_night.text') = content_hash`).get()).toEqual({ checked: 103 });
		}
	});

it("undo restores A, withdraws B, clears A's replaced mark and refuses an older replacement judgement", async () => {
	const { a, b } = await replacementChain();
	expect(delivered(await start("before-undo"))).toEqual([b.id]);
	await expect(undo(b.id)).resolves.toMatchObject({ degraded: false, result: { isError: false } });
	expect.soft(delivered(await start("after-undo"))).toEqual([a.id]);
	expect.soft(delivered(await prompt("after-undo-prompt", "Which port does the release service use?"))).toEqual([a.id]);
	expect.soft(metadata(a.id)).not.toHaveProperty("superseded_by");
	expect.soft(metadata(a.id)).not.toHaveProperty("superseded_at");
	expect.soft(metadata(a.id)).not.toHaveProperty("supersede_reason");
	const captured = await runtime.capture({ turnId: "older-statement", rewindEpoch: 0, messages: [{
		role: "user", content: "Use port 8100 for the release service.", at: 1794438000000,
	}] }, { ...scope, session: "late-arriving-older-statement" });
	expect(captured).toMatchObject({ degraded: false, committed: true });
	await runtime.init(scope, { skinId: "claude-code" });
	expect.soft(delivered(await start("after-older-judgement"))).toEqual([a.id]);
	expect.soft(delivered(await prompt("older-judgement-prompt", "Which port does the release service use?"))).toEqual([a.id]);
	expect(metadata(a.id)).not.toHaveProperty("superseded_by");
});

it("undo of C in A to B to C restores only B", async () => {
	const { a, b } = await replacementChain();
	const c = await row("Use port 8100 for the release service.");
	mark(b.id, { superseded_by: c.id, superseded_at: "2026-11-12T00:00:00Z", supersede_reason: "write-judgement" });
	expect(delivered(await start("chain-before-undo"))).toEqual([c.id]);
	await expect(undo(c.id)).resolves.toMatchObject({ degraded: false, result: { isError: false } });
	expect.soft(delivered(await start("chain-after-undo"))).toEqual([b.id]);
	expect.soft(delivered(await prompt("chain-after-prompt", "Which port does the release service use?"))).toEqual([b.id]);
	expect.soft(metadata(a.id)).toMatchObject({ superseded_by: b.id });
	expect(metadata(b.id)).not.toHaveProperty("superseded_by");
});

it("refuses undo of B while C replaces it and leaves the chain unchanged", async () => {
	const { a, b } = await replacementChain();
	const c = await row("Use port 8100 for the release service.");
	mark(b.id, { superseded_by: c.id, superseded_at: "2026-11-12T00:00:00Z", supersede_reason: "write-judgement" });
	const result = await undo(b.id);
	expect(result).toMatchObject({ degraded: false, result: { isError: true } });
	if (result.degraded) throw new Error(result.reason);
	expect.soft(JSON.stringify(result.result)).toContain("superseded");
	expect.soft(JSON.stringify(result.result)).toContain(c.id);
	expect.soft(delivered(await start("refused-undo-start"))).toEqual([c.id]);
	expect.soft(delivered(await prompt("refused-undo-prompt", "Which port does the release service use?"))).toEqual([c.id]);
	expect(metadata(a.id)).toMatchObject({ superseded_by: b.id });
	expect(metadata(b.id)).toMatchObject({ superseded_by: c.id });
});

it("undo of a merged row restores every direct source", async () => {
	const language = await row("Write release reports in Chinese.");
	const cause = await row("Explain the failure cause in release reports.");
	const merged = await row("Write release reports in Chinese and explain failure causes.");
	mark(language.id, { superseded_by: merged.id, superseded_at: "2026-11-12T00:00:00Z", supersede_reason: "merge" });
	mark(cause.id, { superseded_by: merged.id, superseded_at: "2026-11-12T00:00:00Z", supersede_reason: "merge" });
	expect(delivered(await start("merge-before-undo"))).toEqual([merged.id]);
	await expect(undo(merged.id)).resolves.toMatchObject({ degraded: false, result: { isError: false } });
	expect.soft(delivered(await start("merge-after-undo"))?.sort()).toEqual([language.id, cause.id].sort());
	expect.soft(delivered(await prompt("merge-after-prompt", "How should release reports explain failure causes?"))?.sort()).toEqual([language.id, cause.id].sort());
	expect.soft(metadata(language.id)).not.toHaveProperty("superseded_by");
	expect(metadata(cause.id)).not.toHaveProperty("superseded_by");
});
