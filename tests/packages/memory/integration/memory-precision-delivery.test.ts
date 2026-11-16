/** Precision delivery through the existing runtime, encrypted store and real retrieval. */
import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { countTokens } from "@snoai/chunking";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { judgeNightlyLoadedFiles } from "../../../../packages/memory/src/engine/precision-loaded-files";
import { precisionNightBudget } from "../../../../packages/memory/src/engine/precision-night";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";

let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let database: ReturnType<typeof createTestDb>;
let store: MemoryStore;
let access: AccessTracker;
let usage: MemoryTelemetryUsageOutbox;
let runtime: MemoryContractRuntime;
let modelPrompts: string[];
const scope = { principal: "owner", project: "agent:precision", session: "start" };

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	modelPrompts = [];
	database = createTestDb();
	store = new MemoryStore({ dbPath: database.dbPath, embedder });
	const config = pluginConfigSchema.parse({ mode: "local-first", modelCalls: defaultSettings().modelCalls,
		autoRecall: true, retrieval: { rerank: "none" }, observe: { enabled: false } });
	access = new AccessTracker({ store });
	usage = new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath: database.dbPath });
	const logger = { info: () => {}, warn: () => {}, error: () => {} };
	runtime = new MemoryContractRuntime({ config, store, embedder, accessTracker: access, telemetryUsage: usage,
		retriever: createRetriever(store, embedder, undefined, config.retrieval), logger, stateDir: dirname(database.dbPath),
		observability: new PluginObservability(config, dirname(database.dbPath), logger) });
	await runtime.init(scope, { skinId: "codex" });
});
afterEach(async () => {
	await runtime?.close(); await access?.destroy(); await store?.close(); database?.cleanup();
});

async function row(text: string, kind: string, projectId = "agent:precision", importance = 0.7, extra = {}) {
	return store.store({ text, category: "episodic", projectId, importance,
		metadata: JSON.stringify({ precision_kind: kind, ...extra }) });
}
function start(session: string, loadedFiles?: Array<{ path: string; sha256: string; bytes: number }>) {
	return runtime.getRecall("This query must not select a work brief.", { ...scope, session },
		{ source: "auto", injectionPhase: "session-start", limit: 1, maxChars: 1, loadedFiles });
}
function textLines(result: Awaited<ReturnType<typeof runtime.getRecall>>) {
	if (result.degraded) throw new Error(result.reason);
	return result.contextText.split("\n").slice(1).map(line => line.replace(/ \[id:[^\]]+\]$/u, ""));
}

async function loadedFile(name: string, text: string) {
	const path = join(dirname(database.dbPath), name);
	await writeFile(path, text);
	return { path, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}
function recordLoadedFiles(files: Awaited<ReturnType<typeof loadedFile>>[]) {
	store.setPlaceLoadedFiles({ skinId: "codex", projectId: "agent:precision", surface: "", files, updatedAt: Date.now() });
}
async function loadedPair(firstText = "Explain the release risk before publishing. Keep release notes beside the package.") {
	const files: [Awaited<ReturnType<typeof loadedFile>>, Awaited<ReturnType<typeof loadedFile>>] = [await loadedFile("A.md", firstText),
		await loadedFile("B.md", "Use the project formatter. Keep source files in the project directory.")];
	recordLoadedFiles(files);
	return files;
}
function storedVerdicts(id: string) {
	return store.getLoadedFileJudgments(id).map(answer => ({ file: basename(answer.filePath), verdict: answer.verdict }))
		.sort((left, right) => left.file.localeCompare(right.file));
}
function found(id: string, verdict: string, quote: string) { return { rows: [{ id, verdict, quote }] }; }

/** The same host port as the nightly-choice tests; strings are deliberately raw replies. */
async function scriptedModel(replies: unknown[]) {
	return createLlmClient({ preset: "mem_claw/sno_extract_chat",
		usageClass: "research", timeoutMs: 5_000,
		routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
		agentPort: { async complete({ prompt }) {
			modelPrompts.push(prompt);
			const reply = replies.shift() ?? "No scripted reply remains.";
			return { kind: "ok", text: typeof reply === "string" ? reply : JSON.stringify(reply) };
		} },
	});
}

it.each(["session-start", "first-prompt"] as const)("selects shared and project rules and pitfalls without commitments, recording only delivered access and phase during %s", async injectionPhase => {
	const shared = await row("先给结论。然后解释原因。", "rule", "global", 0.7);
	const high = await row("Release only after the owner approves.", "rule", "agent:precision", 0.9);
	const pitfall = await row("The replica lags after a deployment.", "pitfall");
	const local = await row("Use the project release checklist.", "rule");
	const person = await row("The owner works in Pacific time.", "person", "global", 0.5);
	const release = await row("Ship the approved release.", "commitment", "agent:precision", 0.9);
	const review = await row("Review the release notes.", "commitment");
	const excluded = [
		await row("The replica may lose its port mapping.", "pitfall", "agent:precision", 1, { asserted_by: "assistant" }),
		await row("The project server is named Cedar.", "fact"),
		await row("A private project requires approval.", "rule", "agent:other"),
		await row("The global service has a pitfall.", "pitfall", "global"),
		await row("This rule is retired.", "rule", "agent:precision", 1, { superseded_by: "successor" }),
		await row("This rule is invalid.", "rule", "agent:precision", 1, { invalidated_at: "2026-11-01T00:00:00Z" }),
		await row("The assistant will deploy immediately.", "commitment", "agent:precision", 1, { asserted_by: "assistant" }),
		await row("Ship the private project.", "commitment", "agent:other"),
		await row("Ship every project.", "commitment", "global"),
		await row("Close the old incident.", "commitment", "agent:precision", 1, { superseded_by: "successor" }),
		await row("Create the cancelled release.", "commitment", "agent:precision", 1, { invalidated_at: "2026-11-01T00:00:00Z" }),
	] as const;
	database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.invalidated_at', 1) WHERE id IN (?, ?)").run(excluded[5].id, excluded[10].id);
	const duplicate = await row("先给结论。然后解释原因。", "rule");
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?").run(Date.now() - 2000, release.id);
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?").run(Date.now() - 1000, review.id);
	database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.last_accessed_at', 1, '$.lastAccessedAt', 1)").run();
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 1000 WHERE id = ?").run(pitfall.id);
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 2000 WHERE id = ?").run(local.id);
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 3000 WHERE id = ?").run(shared.id);
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = 4000 WHERE id = ?").run(duplicate.id);
	database.sqlite.prepare("INSERT INTO nodix_place_modes(skin_id, project_id, surface, mode, decided_at) VALUES ('codex', 'agent:precision', '', 'work', 1)").run();
	const result = await runtime.getRecall("hi", { ...scope, session: "selection" },
		{ source: "auto", injectionPhase, limit: 1, maxChars: 1 });
	expect.soft(textLines(result)).toEqual(["Release only after the owner approves.", "先给结论。然后解释原因。",
		"Use the project release checklist.", "The replica lags after a deployment.", "The owner works in Pacific time."]);
	if (result.degraded) throw new Error(result.reason);
	expect.soft(result.memoryIds?.map(id => store.getById(id)?.text)).toEqual([
		"Release only after the owner approves.", "先给结论。然后解释原因。",
		"Use the project release checklist.", "The replica lags after a deployment.", "The owner works in Pacific time.",
	]);
	await access.flush();
	for (const delivered of [duplicate, high, local, pitfall, person]) {
		expect(JSON.parse(store.getById(delivered.id)?.metadata ?? "{}").accessCount).toBe(1);
	}
	for (const hidden of [...excluded, shared, release, review]) expect.soft(JSON.parse(store.getById(hidden.id)?.metadata ?? "{}").accessCount ?? 0).toBe(0);
	usage.flushPending();
	expect.soft(database.sqlite.prepare(`SELECT count(*) AS count FROM nodix_memory_events WHERE event_type = 'inject'
		AND json_extract(metadata_json, '$.phase') = 'session-start'`).get()).toEqual({ count: 5 });
	expect.soft(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memory_events WHERE event_type = 'inject'").get()).toEqual({ count: 5 });
	const prompt = await runtime.getRecall("The replica may lose its port mapping.", { ...scope, session: "related-prompt" },
		{ source: "auto", injectionPhase: "prompt", minScore: 0, limit: 1 });
	if (prompt.degraded) throw new Error(prompt.reason);
	expect(prompt.memoryIds).toEqual([excluded[0].id]);
	expect(prompt.contextText).toContain(`The replica may lose its port mapping. [id:${excluded[0].id}] (said by the assistant, not confirmed)`);
	usage.flushPending();
	expect(database.sqlite.prepare(`SELECT count(*) AS count FROM nodix_memory_events WHERE event_type = 'inject'
		AND json_extract(metadata_json, '$.phase') = 'prompt'`).get()).toEqual({ count: 1 });
});

it("delivers ranked rows across scopes, then core, topic and unlabelled rows, excluding drop", async () => {
	const sharedFirst = await row("Explain the reason before acting.", "rule", "global", 0.2, { start_rank: 1 });
	const sharedSecond = await row("The owner works in Pacific time.", "person", "global", 0.9, { start_rank: 2 });
	const projectFirst = await row("Run the project release checklist.", "rule", "agent:precision", 0.2, { start_rank: 1 });
	const projectSecond = await row("The deployment may interrupt replication.", "pitfall", "agent:precision", 0.9, { start_rank: 2 });
	const unrankedShared = await row("A new shared rule awaits the nightly choice.", "rule", "global", 1, { start_label: "core" });
	const unrankedProject = await row("A new project rule awaits the nightly choice.", "rule", "agent:precision", 1, { start_label: "topic" });
	const zeroShared = await row("A shared rule was not chosen for session start.", "rule", "global", 1, { start_rank: 0 });
	const zeroProject = await row("A project rule was not chosen for session start.", "rule", "agent:precision", 1, { start_rank: 0 });
	await row("This dropped rule must not reach the session.", "rule", "global", 1, { start_rank: 1, start_label: "drop" });
	for (const [memory, timestamp] of [[sharedFirst, 1000], [projectFirst, 2000], [sharedSecond, 3000],
		[projectSecond, 4000], [unrankedShared, 5000], [unrankedProject, 6000], [zeroShared, 7000], [zeroProject, 8000]] as const) {
		database.sqlite.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?").run(timestamp, memory.id);
	}
	const result = await start("ranked-lists");
	if (result.degraded) throw new Error(result.reason);
	expect.soft(result.memoryIds?.map(id => store.getById(id)?.text)).toEqual([
		"Run the project release checklist.", "Explain the reason before acting.",
		"The deployment may interrupt replication.", "The owner works in Pacific time.",
		"A new shared rule awaits the nightly choice.", "A new project rule awaits the nightly choice.",
		"A project rule was not chosen for session start.", "A shared rule was not chosen for session start.",
	]);
	expect(textLines(result)).toEqual([
		"Run the project release checklist.", "Explain the reason before acting.",
		"The deployment may interrupt replication.", "The owner works in Pacific time.",
		"A new shared rule awaits the nightly choice.", "A new project rule awaits the nightly choice.",
		"A project rule was not chosen for session start.", "A shared rule was not chosen for session start.",
	]);
});

it.each(["global", "agent:precision"])("delivers zero-ranked %s rows after ranked rows from the other scope", async project => {
	await row("This rule was not chosen for session start.", "rule", project, 0.9, { start_rank: 0 });
	await row("This other rule was not chosen either.", "rule", project, 0.8, { start_rank: 0 });
	const otherProject = project === "global" ? "agent:precision" : "global";
	await row("Explain the reason before acting.", "rule", otherProject, 0.7, { start_rank: 1 });
	const result = await start("all-zero-ranks");
	if (result.degraded) throw new Error(result.reason);
	expect.soft(result.memoryIds?.map(id => store.getById(id)?.text)).toEqual([
		"Explain the reason before acting.", "This rule was not chosen for session start.", "This other rule was not chosen either.",
	]);
	expect(textLines(result)).toEqual([
		"Explain the reason before acting.", "This rule was not chosen for session start.", "This other rule was not chosen either.",
	]);
});

it("delivers nothing at session start with request limit zero even when ranked rows exist", async () => {
	await row("Explain the reason before acting.", "rule", "global", 0.7, { start_rank: 1 });
	await row("Run the project release checklist.", "rule", "agent:precision", 0.7, { start_rank: 1 });
	const result = await runtime.getRecall("Start the project session.", { ...scope, session: "limit-zero" },
		{ source: "auto", injectionPhase: "session-start", limit: 0 });
	expect(result).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
});

it("excludes both two-day-old and ten-day-old project commitments at session start", async () => {
	const recent = await row("Review the release notes.", "commitment");
	const old = await row("Revert the previous design.", "commitment");
	const now = Date.now();
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?").run(now - 2 * 24 * 60 * 60 * 1000, recent.id);
	database.sqlite.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?").run(now - 10 * 24 * 60 * 60 * 1000, old.id);
	const lines = textLines(await start("commitment-age"));
	expect(lines).toEqual([]);
	expect(store.getById(recent.id)?.text).toBe("Review the release notes.");
	expect(store.getById(old.id)?.text).toBe("Revert the previous design.");
});

it("keeps the same stored project commitment out of session start and recalls it for a matching prompt", async () => {
	const commitment = await row("The owner must review the release notes before publishing.", "commitment");
	const opening = await start("commitment-opening");
	expect.soft(opening).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	expect(store.getById(commitment.id)?.text).toBe("The owner must review the release notes before publishing.");
	expect(JSON.parse(store.getById(commitment.id)?.metadata ?? "{}").precision_kind).toBe("commitment");
	const prompt = await runtime.getRecall("The owner must review the release notes before publishing.",
		{ ...scope, session: "commitment-prompt" }, { source: "auto", injectionPhase: "prompt", minScore: 0, limit: 1 });
	if (prompt.degraded) throw new Error(prompt.reason);
	expect(prompt.contextText).toContain("The owner must review the release notes before publishing.");
	expect(prompt.memoryIds).toHaveLength(1);
	expect(prompt.memoryIds?.map(id => store.getById(id)?.text)).toEqual(["The owner must review the release notes before publishing."]);
	usage.flushPending();
	expect.soft(database.sqlite.prepare(`SELECT count(*) AS count FROM nodix_memory_events WHERE event_type = 'inject'
		AND json_extract(metadata_json, '$.phase') = 'session-start'`).get()).toEqual({ count: 0 });
	expect(database.sqlite.prepare(`SELECT count(*) AS count FROM nodix_memory_events WHERE event_type = 'inject'
		AND json_extract(metadata_json, '$.phase') = 'prompt'`).get()).toEqual({ count: 1 });
});

it.each(["session-start", "first-prompt"] as const)("delivers a project rule instead of a stale open todo during %s", async injectionPhase => {
	database.sqlite.prepare(`INSERT INTO nodix_memories
		(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
		VALUES ('owner-rule', 'Require owner approval before publishing the release.', 'episodic', 'agent:precision',
		0.7, ?, 'UTC', '{"precision_kind":"rule"}', 'rule-hash', 'owner-rule')`).run(Date.now());
	database.sqlite.prepare(`INSERT INTO nodix_active_task_instances
		(project_id, active_task_id, opening_command_id, canonical_tuple_json, identity_state, status, created_at_ms)
		VALUES ('agent:precision', 'stale-command', NULL, '{}', 'normal', 'active', 1)`).run();
	database.sqlite.prepare(`INSERT INTO nodix_todos
		(project_id, active_task_id, description, status, opened_at, transitioned_at, source_session, extraction_path)
		VALUES ('agent:precision', 'stale-command', 'Merge the PR directly and deploy immediately.', 'open', 1000, 1000, 'fixture', 'atomic')`).run();
	const result = await runtime.getRecall("hi", { ...scope, session: "rule-not-todo" },
		{ source: "auto", injectionPhase, limit: 1, maxChars: 1 });
	if (result.degraded) throw new Error(result.reason);
	expect(result.contextText.split("\n").slice(1)).toEqual([
		"Require owner approval before publishing the release. [id:owner-rule]",
	]);
	expect(result.contextText).not.toContain("Merge the PR directly and deploy immediately.");
	expect(result.memoryIds).toEqual(["owner-rule"]);
	await access.flush();
	expect(JSON.parse(store.getById("owner-rule")?.metadata ?? "{}").accessCount).toBe(1);
});

it("consumes one token budget in order without reserving space for project rows", async () => {
	for (let index = 0; index < 40; index++) {
		database.sqlite.prepare(`INSERT INTO nodix_memories
			(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
			VALUES (?, ?, 'episodic', 'global', 0.9, ?, 'UTC', '{"precision_kind":"rule"}', ?, ?)`).run(
			`shared-${index}`, `Shared rule ${index}: Explain the reason for every change and wait for approval before publishing.`,
			1000 + index, `shared-hash-${index}`, `shared-fact-${index}`);
	}
	await row("Use the project release checklist.", "rule", "agent:precision", 0.7);
	await row("The replica lags after a deployment.", "pitfall");
	const result = await start("shared-overflow");
	if (result.degraded) throw new Error(result.reason);
	expect.soft(textLines(result)).toEqual([
		"Shared rule 39: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 38: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 37: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 36: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 35: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 34: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 33: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 32: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 31: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 30: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 29: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 28: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 27: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 26: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 25: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 24: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 23: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 22: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 21: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 20: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 19: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 18: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 17: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 16: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 15: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 14: Explain the reason for every change and wait for approval before publishing.",
		"Shared rule 13: Explain the reason for every change and wait for approval before publishing.",
	]);
	expect.soft(result.memoryIds).toEqual([
		"shared-39", "shared-38", "shared-37", "shared-36", "shared-35", "shared-34", "shared-33", "shared-32", "shared-31",
		"shared-30", "shared-29", "shared-28", "shared-27", "shared-26", "shared-25", "shared-24", "shared-23", "shared-22",
		"shared-21", "shared-20", "shared-19", "shared-18", "shared-17", "shared-16", "shared-15", "shared-14", "shared-13",
	]);
	expect(countTokens(result.contextText)).toBeLessThanOrEqual(1000);
});

it("packs Chinese whole sentences within 1000 tokens, skips an oversized row and continues without a row limit", async () => {
	await row("超出预算的规则".repeat(100) + "。", "rule", "global", 0.2);
	const chinese = "每次改动都要说明原因，先给结论，再说需要主人决定的事情。";
	for (let index = 0; index < 22; index++) await row(`${chinese}第${index}条。`, "rule", "global", 0.9);
	await row("Short final rule.", "rule", "agent:precision", 0.1);
	const result = await start("chinese-budget");
	if (result.degraded) throw new Error(result.reason);
	expect(countTokens(result.contextText)).toBeLessThanOrEqual(1000);
	expect(result.contextText).not.toContain("超出预算的规则");
	expect(result.contextText).toContain("Short final rule.");
	expect(result.memoryIds).toHaveLength(23);
	expect(countTokens(result.contextText + "超出预算的规则".repeat(100))).toBeGreaterThan(1000);
	expect(result.contextText).toContain("每次改动都要说明原因，先给结论，再说需要主人决定的事情。");
});

it("returns an empty work brief when nothing qualifies while a chat place still searches unlabelled shared facts", async () => {
	await store.store({ text: "The shared shipping token is CHAT-7829.", category: "episodic", projectId: "global" });
	const empty = await start("unknown-place");
	expect(empty).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	database.sqlite.prepare("INSERT INTO nodix_place_modes(skin_id, project_id, surface, mode, decided_at) VALUES ('codex', 'agent:precision', '', 'work', 1)").run();
	expect(await start("work-place")).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	database.sqlite.prepare("UPDATE nodix_place_modes SET mode = 'chat'").run();
	const chat = await runtime.getRecall("The shared shipping token is CHAT-7829.", { ...scope, session: "chat-place" },
		{ source: "auto", injectionPhase: "session-start", limit: 10, maxChars: 3000 });
	if (chat.degraded) throw new Error(chat.reason);
	expect(chat.contextText).toContain("The shared shipping token is CHAT-7829.");
});

it.each(["rule", "pitfall"])("suppresses matching said and opposite judgments for %s and delivers changed rows and files", async kind => {
	const rule = await row("Always explain the release risk.", kind, kind === "rule" ? "global" : "agent:precision");
	const file = { path: "/fixture/AGENTS.md", sha256: "a".repeat(64), bytes: 31 };
	const judgment = database.sqlite.prepare(`INSERT OR REPLACE INTO nodix_loaded_file_judgments
		(memory_id, memory_content_hash, file_path, file_sha256, verdict, judged_at) VALUES (?, ?, ?, ?, ?, 1)`);
	const hash = store.getById(rule.id)?.contentHash;
	judgment.run(rule.id, hash, file.path, file.sha256, "said");
	expect(await start("matching", [file])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	for (const [session, files] of [["missing-file", []], ["no-list", undefined],
		["changed-file", [{ ...file, sha256: "b".repeat(64) }]],
		["different-path", [{ ...file, path: "/fixture/OTHER.md" }]]] as const) {
		expect(textLines(await start(session, files === undefined ? undefined : [...files]))).toEqual(["Always explain the release risk."]);
	}
	database.sqlite.prepare("UPDATE nodix_memories SET text = 'Always explain the deployment risk.', content_hash = 'changed-row-content-hash' WHERE id = ?").run(rule.id);
	expect(textLines(await start("changed-row", [file]))).toEqual(["Always explain the deployment risk."]);
	database.sqlite.prepare("UPDATE nodix_memories SET text = 'Always explain the release risk.', content_hash = ? WHERE id = ?").run(hash, rule.id);
	judgment.run(rule.id, hash, file.path, file.sha256, "not-said");
	expect(textLines(await start("not-said", [file]))).toEqual(["Always explain the release risk."]);
	judgment.run(rule.id, hash, file.path, file.sha256, "opposite");
	expect(await start("opposite", [file])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	database.sqlite.prepare("DELETE FROM nodix_loaded_file_judgments").run();
	expect(textLines(await start("missing-judgment", [file]))).toEqual(["Always explain the release risk."]);
});

it("makes no loaded-file judgment model call for a stored project commitment", async () => {
	const commitment = await row("The owner must review the release notes before publishing.", "commitment");
	await loadedPair();
	const llm = await scriptedModel([found(commitment.id, "not-said", "")]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(0);
	expect.soft(modelPrompts).toEqual([]);
	expect.soft(storedVerdicts(commitment.id)).toEqual([]);
	expect(store.getById(commitment.id)?.text).toBe("The owner must review the release notes before publishing.");
});

it("stores not-said for every file from a bare one-element find array with exactly one model call and returns 1", async () => {
	const memory = await row("Always explain the release risk.", "rule");
	const quote = "用普通的词，主动句，一句只说一件事。";
	await loadedPair(quote);
	const llm = await scriptedModel([[{ id: memory.id, quote, verdict: "not-said" }]]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(1);
	expect.soft(modelPrompts).toHaveLength(1);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "not-said" }, { file: "B.md", verdict: "not-said" }]);
});

it("finds one covering sentence across both files and hides only after two isolated covered checks", async () => {
	const memory = await row("Always explain the release risk.", "rule");
	const files = await loadedPair();
	const llm = await scriptedModel([found(memory.id, "said", "Explain the release risk before publishing."),
		{ verdict: "covered" }, { verdict: "covered" }]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(modelPrompts[0]).toContain("Explain the release risk before publishing. Keep release notes beside the package.");
	expect.soft(modelPrompts[0]).toContain("Use the project formatter. Keep source files in the project directory.");
	expect.soft(modelPrompts[0]).toContain("Always explain the release risk.");
	for (const prompt of modelPrompts.slice(1)) {
		expect.soft(prompt).toContain("Explain the release risk before publishing.");
		expect.soft(prompt).toContain("Always explain the release risk.");
		expect.soft(prompt).not.toContain("Keep release notes beside the package.");
		expect.soft(prompt).not.toContain("Use the project formatter.");
		expect.soft(prompt).not.toContain("Keep source files in the project directory.");
	}
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(await start("covered-A", [files[0]])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	expect.soft(textLines(await start("uncovered-B", [files[1]]))).toEqual(["Always explain the release risk."]);
});

it.each([
	["covered", "not-covered"], ["not-covered", "covered"],
])("keeps the memory delivered when the check replies are %s then %s", async (first, second) => {
	const memory = await row("Always explain the release risk.", "rule");
	const files = await loadedPair();
	const llm = await scriptedModel([found(memory.id, "said", "Explain the release risk before publishing."),
		{ verdict: first }, { verdict: second }]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "not-said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(textLines(await start("one-rejected-check", files))).toEqual(["Always explain the release risk."]);
});

it.each([
	{ name: "empty", quote: "" }, { name: "whitespace-only", quote: " \t\n " },
	{ name: "absent", quote: "The archive must be copied to the backup server." },
])("rejects a $name said quote without making any check call", async ({ quote }) => {
	const memory = await row("Always explain the release risk.", "rule");
	const files = await loadedPair();
	const llm = await scriptedModel([found(memory.id, "said", quote)]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(1);
	expect.soft(modelPrompts).toHaveLength(1);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "not-said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(textLines(await start("invalid-quote", files))).toEqual(["Always explain the release risk."]);
});

it("matches a covering quote despite whitespace and a line break inside the file sentence", async () => {
	const memory = await row("Always explain the release risk.", "rule");
	const files = await loadedPair("Explain the release\nrisk before publishing. Keep release notes beside the package.");
	const llm = await scriptedModel([found(memory.id, "said", "Explain  the release risk\tbefore publishing."),
		{ verdict: "covered" }, { verdict: "covered" }]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(await start("whitespace-match", [files[0]])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
});

it.each([
	{ name: "quoted file B", quote: "Use the project formatter.", file: "B.md", other: "A.md" },
	{ name: "first file for an empty quote", quote: "", file: "A.md", other: "B.md" },
])("stores opposite on the $name, appends a conflict and skips the memory only where that file is loaded", async ({ quote, file, other }) => {
	const memory = await row("Never use the project formatter.", "rule");
	const files = await loadedPair();
	const conflictPath = join(dirname(database.dbPath), "memory-loaded-file-conflicts.md");
	await writeFile(conflictPath, "# Existing conflict history\n");
	const llm = await scriptedModel([found(memory.id, "opposite", quote)]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(1);
	expect.soft(modelPrompts).toHaveLength(1);
	expect.soft(storedVerdicts(memory.id).find(answer => answer.file === file)?.verdict).toBe("opposite");
	expect.soft(storedVerdicts(memory.id).find(answer => answer.file === other)?.verdict).toBe("not-said");
	expect.soft(storedVerdicts(memory.id)).toHaveLength(2);
	const conflicts = await readFile(conflictPath, "utf8");
	expect.soft(conflicts).toContain("# Existing conflict history\n");
	expect.soft(conflicts).toContain("Never use the project formatter.");
	expect.soft(conflicts).toContain(`Memory: ${memory.id}`);
	expect.soft(conflicts).toContain(`File: ${join(dirname(database.dbPath), file)}`);
	expect.soft(conflicts.match(/\nMemory: /gu)).toHaveLength(1);
	expect.soft(await start("opposite-loaded", files)).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	expect.soft(textLines(await start("opposite-other-file", files.filter(loaded => basename(loaded.path) === other))))
		.toEqual(["Never use the project formatter."]);
});

it("keeps the measured reviewer counter-example delivered after both checks reject the quoted sentence", async () => {
	const memory = await row("The owner requires the reviewer to report ordinary-flow introduced bugs, not style.", "rule");
	const files = await loadedPair("A reviewer finding is not an order to add code. Keep review notes in the project.");
	const llm = await scriptedModel([found(memory.id, "said", "A reviewer finding is not an order to add code."),
		{ verdict: "not-covered" }, { verdict: "not-covered" }]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "not-said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(textLines(await start("reviewer-counter-example", files)))
		.toEqual(["The owner requires the reviewer to report ordinary-flow introduced bugs, not style."]);
});

it.each(["find", "first check", "second check"])("stores no partial judgment after non-JSON in the %s call and retries on a later run", async phase => {
	const memory = await row("Always explain the release risk.", "rule");
	const files = await loadedPair();
	const replies: unknown[] = phase === "find" ? ["This is not JSON."]
		: phase === "first check" ? [found(memory.id, "said", "Explain the release risk before publishing."), "This is not JSON."]
		: [found(memory.id, "said", "Explain the release risk before publishing."), { verdict: "covered" }, "This is not JSON."];
	const llm = await scriptedModel(replies);
	await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath));
	expect.soft(store.getLoadedFileJudgments(memory.id)).toEqual([]);
	expect.soft(textLines(await start("invalid-reply", files))).toEqual(["Always explain the release risk."]);
	if (phase === "find") expect.soft(modelPrompts).toHaveLength(1);
	replies.length = 0;
	replies.push(found(memory.id, "said", "Explain the release risk before publishing."), { verdict: "covered" }, { verdict: "covered" });
	modelPrompts.length = 0;
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(await start("valid-retry", [files[0]])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
});

it.each(["changed", "deleted"])("omits a %s file entirely, judges the readable file and judges the restored file on a later run", async state => {
	const memory = await row("Always explain the release risk.", "rule");
	const files: [Awaited<ReturnType<typeof loadedFile>>, Awaited<ReturnType<typeof loadedFile>>] = [await loadedFile("A.md", "Explain the release risk before publishing. Original checklist text."),
		await loadedFile("B.md", "Before publishing, explain the release risk. Keep formatter settings local.")];
	recordLoadedFiles(files);
	if (state === "changed") await writeFile(files[0].path, "Explain the release risk before publishing. Revised checklist text.");
	else await unlink(files[0].path);
	const replies: unknown[] = [found(memory.id, "said", "Before publishing, explain the release risk."),
		{ verdict: "covered" }, { verdict: "covered" }];
	const llm = await scriptedModel(replies);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(modelPrompts[0]).toContain("Before publishing, explain the release risk. Keep formatter settings local.");
	for (const prompt of modelPrompts) {
		expect.soft(prompt).not.toContain("Explain the release risk before publishing.");
		expect.soft(prompt).not.toContain("Original checklist text.");
		expect.soft(prompt).not.toContain("Revised checklist text.");
	}
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "B.md", verdict: "said" }]);
	expect.soft(textLines(await start("skipped-file", [files[0]]))).toEqual(["Always explain the release risk."]);
	expect.soft(await start("readable-file", [files[1]])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
	const current = await loadedFile("A.md", "Explain the release risk before publishing. Revised checklist text.");
	recordLoadedFiles([current, files[1]]);
	replies.length = 0;
	replies.push(found(memory.id, "said", "Explain the release risk before publishing."), { verdict: "covered" }, { verdict: "covered" });
	modelPrompts.length = 0;
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect.soft(modelPrompts).toHaveLength(3);
	expect.soft(modelPrompts[0]).toContain("Explain the release risk before publishing. Revised checklist text.");
	expect.soft(modelPrompts[0]).toContain("Before publishing, explain the release risk. Keep formatter settings local.");
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "A.md", verdict: "said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(await start("restored-file", [current])).toMatchObject({ degraded: false, contextText: "", memoryIds: [] });
});

it("does not rejudge a memory on a later run while one recorded file remains unreadable", async () => {
	const memory = await row("Use the project formatter.", "rule");
	const files = await loadedPair();
	await unlink(files[0].path);
	const llm = await scriptedModel([
		found(memory.id, "said", "Use the project formatter."), { verdict: "covered" }, { verdict: "covered" },
		found(memory.id, "said", "Use the project formatter."), { verdict: "covered" }, { verdict: "covered" },
	]);
	expect(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(3);
	expect(modelPrompts.length).toBe(3);
	expect(storedVerdicts(memory.id)).toEqual([{ file: "B.md", verdict: "said" }]);
	modelPrompts.length = 0;
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(0);
	expect.soft(modelPrompts.length).toBe(0);
	expect.soft(storedVerdicts(memory.id)).toEqual([{ file: "B.md", verdict: "said" }]);
});

it("finds each pending memory separately instead of batching memories into one prompt", async () => {
	const first = await row("Always explain the release risk.", "rule", "agent:precision", 0.7, { start_rank: 1 });
	const second = await row("Keep a copy of the deployment checklist.", "rule", "agent:precision", 0.7, { start_rank: 2 });
	const files = await loadedPair();
	const llm = await scriptedModel([found(first.id, "not-said", ""), found(second.id, "not-said", "")]);
	expect.soft(await judgeNightlyLoadedFiles(store, llm, dirname(database.dbPath))).toBe(2);
	expect.soft(modelPrompts).toHaveLength(2);
	expect.soft(modelPrompts[0]).toContain("Always explain the release risk.");
	expect.soft(modelPrompts[0]).not.toContain("Keep a copy of the deployment checklist.");
	expect.soft(modelPrompts[1]).toContain("Keep a copy of the deployment checklist.");
	expect.soft(modelPrompts[1]).not.toContain("Always explain the release risk.");
	for (const prompt of modelPrompts) {
		expect.soft(prompt).toContain("Explain the release risk before publishing. Keep release notes beside the package.");
		expect.soft(prompt).toContain("Use the project formatter. Keep source files in the project directory.");
	}
	for (const memory of [first, second]) expect.soft(storedVerdicts(memory.id))
		.toEqual([{ file: "A.md", verdict: "not-said" }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(textLines(await start("separate-memories", files)))
		.toEqual(["Always explain the release risk.", "Keep a copy of the deployment checklist."]);
});

it.each([
	{ verdict: "not-said", judgments: 200, lastDone: "nightly-budget-99", pending: "nightly-budget-100" },
	{ verdict: "said", judgments: 66, lastDone: "nightly-budget-32", pending: "nightly-budget-33" },
])("uses the shared whole-night budget for $verdict file comparisons and leaves unfinished rows unjudged", async ({ verdict, judgments, lastDone, pending }) => {
	const replies: unknown[] = [];
	for (let index = 0; index < 101; index++) {
		const id = `nightly-budget-${index}`;
		database.sqlite.prepare(`INSERT INTO nodix_memories
			(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
			VALUES (?, ?, 'episodic', 'agent:precision', 0.7, 1000, 'UTC', ?, ?, ?)`).run(
			id, `Explain the deployment requirement for component ${index}.`,
			JSON.stringify({ precision_kind: "rule", start_rank: index + 1 }),
			createHash("sha256").update(id).digest("hex"), `fact-${id}`);
		replies.push(found(id, verdict, verdict === "said" ? "Explain the deployment requirement for every component." : ""));
		if (verdict === "said") replies.push({ verdict: "covered" }, { verdict: "covered" });
	}
	await loadedPair("Explain the deployment requirement for every component. Keep deployment notes local.");
	const llm = await scriptedModel(replies);
	await judgeNightlyLoadedFiles(store, precisionNightBudget(llm).llm, dirname(database.dbPath));
	expect.soft(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_loaded_file_judgments").get()).toEqual({ count: judgments });
	expect.soft(storedVerdicts(lastDone))
		.toEqual([{ file: "A.md", verdict }, { file: "B.md", verdict: "not-said" }]);
	expect.soft(store.getLoadedFileJudgments(pending)).toEqual([]);
});
