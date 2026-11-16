/** Registered agents over real loopback HTTP; capture/night, parsing and SQLite writes remain real.
 * Numbers refer to the observable cases in precision-memory/design.md.
 * Only external model replies and the public registry trust document are scripted.
 */
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSchema, type Settings } from "../../../../packages/memory/config/settings";
import type { AgentModelRegistration } from "../../../../packages/memory/src/contract/inputs";
import type { PrecisionInspection } from "../../../../packages/memory/src/contract/results";
import { WORK_MEMORY_ADMISSION } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import type { AgentLlmCompletion, AgentLlmRequest } from "../../../../packages/memory/src/model/agent-llm-port";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { SNO_STATION_MEM_RELEASE_ANCHOR_URL } from "../../../../packages/memory/src/model/llmix-registry";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { runPrecisionNightly } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { modelReply, startRecorder, type Recorder } from "./fixtures/model-recorders";
import { untilModelReady } from "./fixtures/model-ready";

// Test-local descriptions of the requested metadata let these tests compile before its implementation.
type Identity = { skinId: string; vendor: string | null };
type Target = { skinId: string } | { otherVendorThan: Identity };
type ObservedRequest = AgentLlmRequest & { hostTarget?: Target };
type ObservedCompletion = AgentLlmCompletion & { responder?: Identity; checkedBySameVendor?: boolean };
type Attempt = { baseUrl: string; request: ObservedRequest; received?: string; result?: ObservedCompletion };
type Fact = { index: number; text: string; rows: Array<{ id: string; text: string }> };
type Relation = "unrelated" | "same" | "replaces" | "overlaps";
type Journal = { stage: string; outcome: string; actions_applied: number; reason: string | null;
	detail: { rows: string[]; outcome?: string; sameVendor?: boolean } };
const modes = ["agent-native", "rem-enhanced"] as const;
const oldPort = "The owner requires the service to use port 8070.";
const newPort = "The owner requires the service to use port 8090.";
const language = "The owner requires every service report to be written in Chinese.";
const causes = "The owner requires every service report to explain failure causes.";
const merged = "Write service reports in Chinese and explain failure causes.";
const admission = createHash("sha256").update(WORK_MEMORY_ADMISSION).digest("hex").slice(0, 12);
const sourceAt = 1_794_556_800_000;
let database: ReturnType<typeof createTestDb>;
let pool: MemoryRuntimePool;
let settings: Settings;
let closers: Array<() => Promise<void>>;
let agents: Map<string, Recorder>;
let attempts: Attempt[];
let nightResponses: Array<{ request: ObservedRequest; result: ObservedCompletion }>;
let relations: Map<string, Relation>;
let deletedAtAdmission: Set<string>;
let sourceActions: Map<string, { action: "correct" | "remove"; text: string }>;
let onRequest: (skin: string, request: ObservedRequest) => "gone" | undefined;
let gpu: Recorder;
const scope = { principal: userInfo().username, project: "agent:precision-routing", session: "routing-session", host: { surface: "terminal" } };

beforeEach(async () => {
	closers = []; agents = new Map(); attempts = []; nightResponses = [];
	relations = new Map(); deletedAtAdmission = new Set(); sourceActions = new Map(); onRequest = () => undefined;
	const realFetch = globalThis.fetch;
	// A substitute for the external public DID document only; signature verification still runs.
	vi.stubGlobal("fetch", ((input, init) => String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL
		? Promise.resolve(new Response(JSON.stringify({ "@context": ["https://www.w3.org/ns/did/v1"],
			id: "did:web:www.sno.ai", verificationMethod: [{ id: "did:web:www.sno.ai#sno-mem-openclaw-release",
				type: "JsonWebKey2020", controller: "did:web:www.sno.ai", publicKeyJwk: { kty: "OKP", crv: "Ed25519",
					x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" } }],
			assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"] }), { status: 200 }))
		: realFetch(input, init)) as typeof fetch);
	const complete = RegisteredAgentPort.prototype.complete;
	vi.spyOn(RegisteredAgentPort.prototype, "complete").mockImplementation(async function (this: RegisteredAgentPort, request) {
		const model = (this as unknown as { model?: AgentModelRegistration }).model;
		const attempt: Attempt = { baseUrl: model?.baseUrl ?? "unregistered", request };
		attempts.push(attempt);
		attempt.result = await complete.call(this, request);
		return attempt.result;
	});
	gpu = await startRecorder(closers, ({ content, raw }) => modelReply(JSON.stringify(answer(content)), raw));
});
afterEach(async () => {
	try { await pool?.close(); }
	finally {
		for (const close of closers) await close();
		database?.cleanup();
		vi.restoreAllMocks(); vi.unstubAllGlobals();
		pool = undefined as unknown as MemoryRuntimePool;
		database = undefined as unknown as ReturnType<typeof createTestDb>;
	}
});

async function open(mode: Settings["mode"] = "agent-native") {
	database = createTestDb();
	settings = settingsSchema.parse(writeSettingsFixture(dirname(database.dbPath), {
		mode, store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		snoGpu: { baseUrl: gpu.url, apiKey: "fixture" }, embedding: { offline: true },
		rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		logging: { level: "error" },
	}).settings);
	pool = await MemoryRuntimePool.open();
	await untilModelReady(probe => pool.invoke("getRecall", { ...probe, scope: { ...scope, ...probe.scope } }, "codex"));
}
async function register(skin: string, model: string | null = skin === "claude-code" ? "claude-exec" : "codex-exec") {
	let recorder = agents.get(skin);
	if (!recorder) {
		recorder = await startRecorder(closers, ({ content, raw }) => {
			const baseUrl = `${agents.get(skin)?.url}/v1`;
			const attempt = attempts.find(item => item.baseUrl === baseUrl && item.received === undefined && item.request.prompt === content);
			if (!attempt) throw new Error(`Unobserved registered request for ${skin}`);
			attempt.received = content;
			if (onRequest(skin, attempt.request) === "gone") {
				return { status: 503, body: { error: { kind: "error", category: "transport", message: "no-agent-endpoint" } } };
			}
			return modelReply(JSON.stringify(answer(content, attempt.request.callId)), raw);
		});
		agents.set(skin, recorder);
	}
	const result = await pool.invoke("init", { scope, registration: { skinId: skin,
		...(model === null ? {} : { model: { baseUrl: `${recorder.url}/v1`, credential: "fixture", model } }) } }, skin);
	expect(result.degraded).toBe(false);
}
function payload(prompt: string): unknown { return JSON.parse(prompt.trimEnd().split("\n").at(-1) ?? "null"); }
function answer(prompt: string, callId?: string): unknown {
	// Select a scripted protocol response, never classify the meaning of memory text.
	if (callId === "E13" || prompt.startsWith("Judge whether this conversation's place") || prompt.startsWith("Judge whether this place")) return { mode: "work" };
	if (callId === "E16" || prompt.includes("Judge each stored memory on its text alone")) {
		return { rows: (payload(prompt) as Array<{ id: string }>).map(row => deletedAtAdmission.has(row.id)
			? { id: row.id, verdict: "delete", reason: "activity record" }
			: { id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: false }) };
	}
	if (callId === "E21" || prompt.startsWith("Each fact is about to be stored") || prompt.startsWith("Does the quoted source support")) {
		const data = payload(prompt) as { facts?: Fact[]; rows?: Array<{ id: string }> };
		return data.facts ? { facts: data.facts.map(fact => ({ index: fact.index,
			rows: fact.rows.map(row => ({ id: row.id, relation: relations.get(`${fact.text}\0${row.id}`) ?? "unrelated" })) })) }
			: { rows: data.rows?.map(row => ({ id: row.id, ...(sourceActions.get(row.id) ?? { action: "keep", text: "" }) })) };
	}
	if (callId === "E22" || prompt.startsWith("Does the new statement make")) {
		return { replaces: true, faithful: true, retired_absent: true, all_facts_accounted: true };
	}
	if (callId === "E23") {
		const data = payload(prompt) as { operation: string; rows: Array<{ id: string }> };
		return data.operation === "admission deletion" ? { rows: data.rows.map(row => ({ id: row.id, confirmed: true })) } : { confirmed: true };
	}
	if (callId === "E24" || prompt.startsWith("Write one shorter sentence")) return { text: merged };
	if (callId === "E19") return { rows: (payload(prompt) as Array<{ id: string }>).map(row => ({ id: row.id, label: "core" })) };
	if (callId === "E20") return { ids: (payload(prompt) as Array<{ id: string }>).map(row => row.id) };
	if (prompt.startsWith("For each owner's rule")) return { rows: (payload(prompt) as { rows: Array<{ id: string }> }).rows.map(row => ({ id: row.id, scope: "project" })) };
	if (prompt.includes("facts:\n")) return { enrichments: [{ id: 0, kind: "standing", attribute: "preference.communication_style",
		value: newPort, ends_current: false, importance: "high", changes_current_state: false, todo: "none", close_reason: null,
		single_claim: true, relations: [], time: { kind: "none" }, ended_time: { kind: "none" } }] };
	if (prompt.includes("response_schema:") && prompt.includes("<take>") && !prompt.includes("Task:")) return {
		claims_found: [0], decisions: [{ turn_index: 0, progress_only: false }], facts: [{ id: 0, fact: newPort, kind: "rule",
			subject: "agent", subject_kind: "agent", temporal_phrase: null, ended_at_phrase: null,
			source_span: { turn_index: 0, quote: newPort } }] };
	if (prompt.includes("durable_self_statement")) return { decisions: [{ record_index: 0, durable_self_statement: true }] };
	if (prompt.includes("Task: resolve each unresolved standing subject")) return { resolutions: [] };
	return { profile_candidates: [], records: [] };
}
async function plant(id: string, text: string, extra: Record<string, unknown> = {}, at = sourceAt) {
	const row = await pool.store.store({ text, projectId: scope.project, category: "episodic", timestamp: at,
		metadata: JSON.stringify({ precision_kind: "rule", precision_judged: true, precision_admission: admission,
			writer_agent_id: "codex", start_label: "topic", source_order: { valid_from: null, session_moment: at,
				session_ordinal: 0, global_turn_index: 0, rowid: 0, conversation_id: id }, ...extra }) });
	database.sqlite.transaction(() => {
		database.sqlite.exec("PRAGMA defer_foreign_keys = ON");
		database.sqlite.prepare("UPDATE nodix_memories SET id = ?, fact_id = ? WHERE id = ?").run(id, id, row.id);
		for (const table of ["nodix_memory_chunks", "nodix_rem_memory_facets"]) database.sqlite.prepare(`UPDATE ${table} SET memory_id = ? WHERE memory_id = ?`).run(id, row.id);
		database.sqlite.prepare("UPDATE nodix_rem_census_rows SET row_id = ? WHERE row_id = ?").run(id, row.id);
	})();
	return id;
}
function meta(id: string): Record<string, unknown> { return JSON.parse(pool.store.getById(id)?.metadata ?? "{}"); }
function route(skin: string, callId: string) {
	return attempts.filter(item => item.baseUrl === `${agents.get(skin)?.url}/v1` && item.request.callId === callId);
}
function routed(skin: string, callId: string) {
	const calls = route(skin, callId);
	expect.soft(calls.length, `${skin} must receive ${callId}`).toBeGreaterThan(0);
	for (const call of calls) expect.soft(call.received, `${skin}:${callId} HTTP body`).toBe(call.request.prompt);
	return calls;
}
function target(skin: string, callId: string, proposer: Identity) {
	for (const call of routed(skin, callId)) expect.soft(call.request.hostTarget).toEqual({ otherVendorThan: proposer });
}
function journal(type: "atomic-extraction" | "precision-nightly" = "precision-nightly"): Journal[] {
	return (database.sqlite.prepare("SELECT stage, outcome, actions_applied, reason, detail FROM nodix_rem_journal WHERE job_type = ? ORDER BY sequence").all(type) as Array<Omit<Journal, "detail"> & { detail: string }> )
		.map(row => ({ ...row, detail: JSON.parse(row.detail) }));
}
function captureOutcome(outcome: string, sameVendor?: boolean) {
	const entries = journal("atomic-extraction").filter(row => row.stage === "write-judgement" && row.detail.outcome === outcome);
	expect.soft(entries.length, `capture ${outcome} journal`).toBeGreaterThan(0);
	for (const entry of entries) if (sameVendor !== undefined) expect.soft(entry.detail.sameVendor).toBe(sameVendor);
}
async function inspect(sameVendor: boolean) {
	const output = await pool.invoke("inspect", { scope, op: { op: "precision" } }, "codex");
	expect.soft(output.degraded).toBe(false);
	const result = (output as { result: PrecisionInspection }).result;
	expect.soft(result.sameVendor).toBe(sameVendor);
	expect.soft(result.lines.filter(line => line === "checked by the same vendor")).toEqual(sameVendor ? ["checked by the same vendor"] : []);
	return result;
}
async function replacement(pending = false, prefix = "") {
	const old = await plant(`${prefix}stale-port`, oldPort);
	const fresh = await plant(`${prefix}pending-port`, newPort, pending ? { precision_check: "pending" } : {}, sourceAt + 1000);
	relations.set(`${newPort}\0${old}`, "replaces");
	return { old, fresh };
}
async function capture(skin: string, model?: string | null) {
	const result = await pool.invoke("capture", { scope: { ...scope, session: randomUUID() }, turn: { turnId: randomUUID(), rewindEpoch: 0,
		messages: [{ role: "user", content: newPort, at: sourceAt + 10_000 }] } }, skin);
	expect(result).toMatchObject({ degraded: false, committed: true });
	// Init drains the runtime's queued close, as in precision-write-judgement.test.ts.
	await register(skin, model);
}
async function night() {
	const chain = pool.connectedRemPort();
	if (!chain) throw new Error("Fixture registered no model");
	const reachable = chain.reachable?.bind(chain);
	await runPrecisionNightly({ settings, mode: settings.mode, waveId: "routing-night", agentPort: {
		complete: async request => { const result = await chain.complete(request); nightResponses.push({ request, result }); return result; },
		...(reachable ? { reachable } : {}),
	} });
}
async function nightChanges() {
	const pair = await replacement();
	await plant("merge-language", language, {}, sourceAt + 3000);
	await plant("merge-causes", causes, {}, sourceAt + 4000);
	relations.set(`${causes}\0merge-language`, "overlaps");
	await plant("duplicate-kept", "The owner requires dated release reports.");
	const duplicate = "The owner wants the date on every release report.";
	await plant("duplicate-removed", duplicate, {}, sourceAt + 2000);
	relations.set(`${duplicate}\0duplicate-kept`, "same");
	await plant("source-correct", "The owner requires nightly service reports.", { source_span: { quote: "The owner requires weekly service reports." } });
	sourceActions.set("source-correct", { action: "correct", text: "The owner requires weekly service reports." });
	await plant("source-remove", "A temporary report was printed.", { source_span: { quote: "Print this temporary report." } });
	sourceActions.set("source-remove", { action: "remove", text: "" });
	await plant("admission-remove", "The temporary command finished.", { precision_admission: undefined });
	deletedAtAdmission.add("admission-remove");
	return pair;
}
function nightEffects(old: string, fresh: string, sameVendor: boolean) {
	expect.soft(meta(old).superseded_by).toBe(fresh);
	expect.soft(meta("merge-language").superseded_by).toEqual(expect.any(String));
	expect.soft(meta("merge-causes").superseded_by).toBe(meta("merge-language").superseded_by);
	expect.soft(pool.store.getById(String(meta("merge-language").superseded_by))?.text).toBe(merged);
	for (const id of ["duplicate-removed", "admission-remove", "source-remove"]) expect.soft(pool.store.getById(id), id).toBeUndefined();
	expect.soft(pool.store.getById("source-correct")?.text).toBe("The owner requires weekly service reports.");
	const changes = journal().filter(row => row.actions_applied > 0);
	expect.soft(changes.map(row => row.stage)).toEqual(expect.arrayContaining(["replacement", "merge", "duplicate", "admission", "source-sentence"]));
	for (const entry of changes) expect.soft(entry.detail.sameVendor, `${entry.stage} vendor detail`).toBe(sameVendor);
}

describe("registered checking side", () => {
	it("case 1: local-first judgement calls contact no registered endpoint", async () => {
		await open("local-first"); await register("claude-code"); await register("codex"); await register("cursor", "cursor-exec");
		const llm = createLlmClient({ preset: "mem_claw/sno_ai_extract", apiKey: "fixture", baseURL: gpu.url,
			routing: { mode: settings.mode, language: "en", modelCalls: settings.modelCalls }, agentPort: pool.connectedRemPort() });
		for (const callId of ["E13", "E16", "E21", "E24", "E22", "E23"] as const) {
			expect(await llm.completeText({ callId, prompt: "off route", maxTokens: 32, emptyReplyAttempts: 1 })).toBeNull();
		}
		expect(attempts).toEqual([]); expect(gpu.received).toEqual([]);
		for (const agent of agents.values()) expect(agent.received).toEqual([]);
	});

	for (const mode of modes) for (const proposer of ["claude-code", "codex"]) {
		it(`case 2: ${mode} capture prefers ${proposer} and another vendor checks`, async () => {
			await open(mode); await register("claude-code"); await register("codex");
			await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
			await capture(proposer);
			const checker = proposer === "claude-code" ? "codex" : "claude-code";
			routed(proposer, "E13"); routed(proposer, "E21");
			target(checker, "E22", { skinId: proposer, vendor: proposer === "codex" ? "openai" : "anthropic" });
			expect.soft(route(proposer, "E22")).toEqual([]);
			expect.soft(meta("stale-port").superseded_by).toEqual(expect.any(String));
			captureOutcome("replaced", false);
		});
	}
	it("case 3: unregistered capture model uses the newest connected proposer identity", async () => {
		await open(); await register("claude-code"); await register("codex"); await register("cursor", null);
		await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
		await capture("cursor", null);
		routed("codex", "E21"); target("claude-code", "E22", { skinId: "codex", vendor: "openai" });
		expect.soft(agents.get("cursor")?.received).toEqual([]);
		expect.soft(meta("stale-port").superseded_by).toEqual(expect.any(String)); captureOutcome("replaced", false);
	});
	it.each(modes)("case 4: %s night routes every proposal and change to opposite vendors", async mode => {
		await open(mode); await register("claude-code"); await register("codex");
		const { old, fresh } = await nightChanges(); await night();
		for (const id of ["E13", "E16", "E21", "E24"]) routed("codex", id);
		expect.soft(route("codex", "E16")).toHaveLength(3);
		target("claude-code", "E22", { skinId: "codex", vendor: "openai" });
		target("claude-code", "E23", { skinId: "codex", vendor: "openai" });
		expect.soft(route("claude-code", "E23").map(call => (payload(call.request.prompt) as { operation: string }).operation))
			.toEqual(expect.arrayContaining(["admission deletion", "duplicate deletion", "source correct", "source remove"]));
		nightEffects(old, fresh, false); await inspect(false);
	});
	it("case 5: one Codex capture uses a separate confirmation and reports the same vendor", async () => {
		await open(); await register("codex"); await plant("capture-old", oldPort); relations.set(`${newPort}\0capture-old`, "replaces");
		await capture("codex"); routed("codex", "E21"); target("codex", "E22", { skinId: "codex", vendor: "openai" });
		captureOutcome("replaced", true);
	});
	it("case 5: one Codex night uses separate confirmations and reports the same vendor", async () => {
		await open(); await register("codex");
		const { old, fresh } = await nightChanges(); await night();
		for (const id of ["E16", "E24", "E22", "E23"]) routed("codex", id);
		nightEffects(old, fresh, true); await inspect(true);
		for (const response of nightResponses.filter(call => ["E22", "E23"].includes(call.request.callId ?? ""))) {
			expect.soft(response.result.checkedBySameVendor).toBe(true);
		}
	});
	it.each(modes)("case 6: %s capture falls back to its proposer when the other vendor refuses", async mode => {
		await open(mode); await register("claude-code"); await register("codex");
		await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
		onRequest = (skin, request) => skin === "claude-code" && request.callId === "E22" ? "gone" : undefined;
		await capture("codex");
		target("claude-code", "E22", { skinId: "codex", vendor: "openai" });
		target("codex", "E22", { skinId: "codex", vendor: "openai" });
		expect.soft(attempts.filter(call => call.request.callId === "E22").map(call => call.baseUrl)).toEqual([
			`${agents.get("claude-code")?.url}/v1`, `${agents.get("codex")?.url}/v1`,
		]);
		expect.soft(meta("stale-port").superseded_by).toEqual(expect.any(String)); captureOutcome("replaced", true);
	});
	it("case 6: a failed other-vendor check falls back per operation and recovery clears that operation's marker", async () => {
		await open(); await register("claude-code"); await register("codex");
		const first = await replacement(true, "first-");
		const secondOld = "The owner requires the database to use port 5432.";
		const secondNew = "The owner requires the database to use port 6432.";
		await plant("second-old", secondOld); await plant("second-new", secondNew, { precision_check: "pending" }, sourceAt + 2000);
		relations.set(`${secondNew}\0second-old`, "replaces");
		onRequest = (skin, request) => skin === "claude-code" && request.callId === "E22"
			&& (payload(request.prompt) as { older: { id: string } }).older.id === first.old ? "gone" : undefined;
		await night();
		// Pending rows keep their existing store order; the second operation sees a recovered checker.
		expect.soft(meta("second-old").superseded_by).toBe("second-new");
		expect.soft(meta(first.old).superseded_by).toBe(first.fresh);
		const replacements = journal().filter(row => row.outcome === "replaced");
		expect.soft(replacements.map(row => ({ rows: row.detail.rows, sameVendor: row.detail.sameVendor }))).toEqual([
			{ rows: [first.fresh, first.old], sameVendor: true },
			{ rows: ["second-new", "second-old"], sameVendor: false },
		]);
		const checks = nightResponses.filter(call => call.request.callId === "E22");
		expect.soft(checks.map(call => call.result.checkedBySameVendor)).toEqual([true, false]);
		routed("claude-code", "E22"); routed("codex", "E22"); await inspect(true);
	});
	it("case 7: failed capture checks preserve the old row and write the new row pending", async () => {
		await open(); await register("claude-code"); await register("codex");
		await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
		onRequest = (_skin, request) => request.callId === "E22" ? "gone" : undefined;
		await capture("codex");
		routed("claude-code", "E22"); routed("codex", "E22");
		expect(pool.store.getById("stale-port")).toBeDefined();
		expect.soft(meta("stale-port")).not.toHaveProperty("superseded_by");
		expect.soft(meta("stale-port")).not.toHaveProperty("supersede_reason");
		const fresh = pool.store.readActivePrecisionRows(scope.project).find(row => row.text === newPort);
		expect.soft(fresh).toBeDefined(); expect.soft(JSON.parse(fresh?.metadata ?? "{}").precision_check).toBe("pending");
		captureOutcome("failed");
	});
	it.each(["E22", "E23"] as const)("case 7: failed nightly %s checks apply no action and appear in doctor failures", async checkId => {
		await open(); await register("claude-code"); await register("codex");
		if (checkId === "E22") await replacement(true);
		else { await plant("admission-remove", "The temporary command finished.", { precision_admission: undefined }); deletedAtAdmission.add("admission-remove"); }
		onRequest = (_skin, request) => request.callId === checkId ? "gone" : undefined;
		await night(); routed("claude-code", checkId); routed("codex", checkId);
		const failures = journal().filter(row => row.outcome === "failed");
		expect.soft(failures.length).toBeGreaterThan(0);
		for (const row of failures) expect.soft(row.actions_applied).toBe(0);
		expect.soft(journal().filter(row => row.actions_applied > 0)).toEqual([]);
		const report = await inspect(false);
		expect.soft(report.nights.flatMap(item => item.failures).length).toBeGreaterThan(0);
		if (checkId === "E22") {
			expect(pool.store.getById("stale-port")).toBeDefined();
			expect.soft(meta("stale-port")).not.toHaveProperty("superseded_by");
			expect.soft(meta("stale-port")).not.toHaveProperty("supersede_reason");
			expect.soft(pool.store.getById("pending-port")).toBeDefined();
			expect.soft(report.lines).toContain("project routing-night: failed pair: no-agent-endpoint; rows pending-port, stale-port");
		} else expect.soft(pool.store.getById("admission-remove")).toBeDefined();
	});
	for (const skin of ["cursor", "hermes", "openclaw"]) for (const model of ["anthropic:claude-sonnet-4-5", "openai:gpt-5", `${skin}-exec`]) {
		it(`case 8: ${skin} model ${model} answers a check with unknown vendor and records same vendor`, async () => {
			await open(); await register(skin, model); await register("codex");
			await replacement(true);
			onRequest = (checker, request) => checker === "codex" && request.callId === "E22" ? "gone" : undefined;
			await night();
			target("codex", "E22", { skinId: "codex", vendor: "openai" });
			target(skin, "E22", { skinId: "codex", vendor: "openai" });
			expect.soft(nightResponses.filter(call => call.request.callId === "E22").map(call => ({
				responder: call.result.responder, sameVendor: call.result.checkedBySameVendor,
			}))).toEqual([{ responder: { skinId: skin, vendor: null }, sameVendor: true }]);
			expect.soft(meta("stale-port").superseded_by).toBe("pending-port");
			expect.soft(journal().filter(row => row.outcome === "replaced").map(row => row.detail.sameVendor)).toEqual([true]);
		});
	}
	it.each(["local:model", "anthropic:x"])("unknown checker %s records a Codex proposal as same vendor", async model => {
		await open(); await register("cursor", model); await register("codex");
		await replacement(true);
		onRequest = (skin, request) => skin === "codex" && request.callId === "E22" ? "gone" : undefined;
		await night();
		expect.soft(nightResponses.filter(call => call.request.callId === "E21").map(call => call.result.responder))
			.toEqual([{ skinId: "codex", vendor: "openai" }]);
		target("cursor", "E22", { skinId: "codex", vendor: "openai" });
		expect.soft(nightResponses.filter(call => call.request.callId === "E22").map(call => ({
			responder: call.result.responder, sameVendor: call.result.checkedBySameVendor,
		}))).toEqual([{ responder: { skinId: "cursor", vendor: null }, sameVendor: true }]);
		expect.soft(meta("stale-port").superseded_by).toBe("pending-port");
		expect.soft(journal().filter(row => row.outcome === "replaced").map(row => row.detail.sameVendor)).toEqual([true]);
		await inspect(true);
	});
	it.each(["local:model", "anthropic:x"])("unknown checker %s does not displace registered Claude Code", async model => {
		await open(); await register("claude-code"); await register("cursor", model); await register("codex");
		await replacement(true); await night();
		expect.soft(nightResponses.filter(call => call.request.callId === "E21").map(call => call.result.responder))
			.toEqual([{ skinId: "codex", vendor: "openai" }]);
		target("claude-code", "E22", { skinId: "codex", vendor: "openai" });
		expect.soft(route("cursor", "E22")).toEqual([]);
		expect.soft(nightResponses.filter(call => call.request.callId === "E22").map(call => ({
			responder: call.result.responder, sameVendor: call.result.checkedBySameVendor,
		}))).toEqual([{ responder: { skinId: "claude-code", vendor: "anthropic" }, sameVendor: false }]);
		expect.soft(meta("stale-port").superseded_by).toBe("pending-port");
		expect.soft(journal().filter(row => row.outcome === "replaced").map(row => row.detail.sameVendor)).toEqual([false]);
		await inspect(false);
	});
	it.each(["cursor", "hermes", "openclaw"])("case 8: opaque %s capture reports unknown identity as same vendor", async skin => {
		await open(); await register(skin, `${skin}-exec`);
		await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
		await capture(skin, `${skin}-exec`);
		routed(skin, "E21"); target(skin, "E22", { skinId: skin, vendor: null }); captureOutcome("replaced", true);
	});
	it.each(["cursor", "hermes", "openclaw"])("case 8: opaque %s alone reports unknown identity as same vendor", async skin => {
		await open(); await register(skin, `${skin}-exec`);
		const { old, fresh } = await replacement(); await night();
		routed(skin, "E21"); target(skin, "E22", { skinId: skin, vendor: null });
		expect.soft(meta(old).superseded_by).toBe(fresh);
		expect.soft(journal().find(row => row.outcome === "replaced")?.detail.sameVendor).toBe(true);
		await inspect(true);
	});
	it("case 9: capture uses the actual fallback proposer for checking", async () => {
		await open(); await register("claude-code"); await register("codex");
		await plant("stale-port", oldPort); relations.set(`${newPort}\0stale-port`, "replaces");
		onRequest = (skin, request) => skin === "codex" && request.callId === "E21" ? "gone" : undefined;
		await capture("codex"); routed("codex", "E21"); routed("claude-code", "E21");
		target("codex", "E22", { skinId: "claude-code", vendor: "anthropic" });
		expect.soft(meta("stale-port").superseded_by).toEqual(expect.any(String)); captureOutcome("replaced", false);
	});
	it("case 9: a fallback proposer supplies the identity used for checking", async () => {
		await open(); await register("claude-code"); await register("codex"); await replacement();
		onRequest = (skin, request) => skin === "codex" && request.callId === "E21" ? "gone" : undefined;
		await night(); routed("codex", "E21"); routed("claude-code", "E21");
		target("codex", "E22", { skinId: "claude-code", vendor: "anthropic" });
		expect.soft(meta("stale-port").superseded_by).toBe("pending-port");
		expect.soft(journal().find(row => row.outcome === "replaced")?.detail.sameVendor).toBe(false); await inspect(false);
	});
	it.each([false, true])("case 9: admission votes stay on the first responder, lost proposer %s", async lost => {
		await open(); await register("claude-code"); await register("codex");
		await plant("admission-remove", "The temporary command finished.", { precision_admission: undefined }); deletedAtAdmission.add("admission-remove");
		let claudeVotes = 0;
		onRequest = (skin, request) => {
			if (request.callId !== "E16") return;
			if (skin === "codex") return claudeVotes === 0 ? "gone" : undefined;
			claudeVotes += 1;
			if (lost && claudeVotes > 1) return "gone";
		};
		await night();
		const votes = routed("claude-code", "E16");
		for (const vote of votes.slice(1)) expect.soft(vote.request.hostTarget).toEqual({ skinId: "claude-code" });
		expect.soft(route("codex", "E16"), "only the initial vote may try Codex").toHaveLength(1);
		if (lost) {
			expect.soft(pool.store.getById("admission-remove")).toBeDefined();
			expect.soft(journal().some(row => row.stage === "admission" && row.outcome === "failed")).toBe(true);
			expect.soft(route("codex", "E23")).toEqual([]);
		} else {
			expect.soft(votes).toHaveLength(3); target("codex", "E23", { skinId: "claude-code", vendor: "anthropic" });
			expect.soft(pool.store.getById("admission-remove")).toBeUndefined(); await inspect(false);
		}
	});
	it("case 10: nested merge and remaining batched pair keep their own proposer identities", async () => {
		await open(); await register("claude-code"); await register("codex");
		await replacement();
		await plant("merge-language", language, {}, sourceAt + 2000); await plant("merge-causes", causes, {}, sourceAt + 3000);
		relations.set(`${causes}\0merge-language`, "overlaps");
		onRequest = (skin, request) => skin === "codex" && request.callId === "E24" ? "gone" : undefined;
		await night();
		const batch = route("codex", "E21").find(call => (payload(call.request.prompt) as { facts?: Fact[] }).facts?.length === 4);
		expect.soft(batch, "one original E21 batch contains both operations").toBeDefined();
		routed("claude-code", "E24");
		const mergeChecks = route("codex", "E22").filter(call => "proposed_current" in (payload(call.request.prompt) as object));
		expect.soft(mergeChecks.length).toBeGreaterThan(0);
		for (const call of mergeChecks) expect.soft(call.request.hostTarget).toEqual({ otherVendorThan: { skinId: "claude-code", vendor: "anthropic" } });
		const pairChecks = route("claude-code", "E22").filter(call => "older" in (payload(call.request.prompt) as object));
		expect.soft(pairChecks.length).toBeGreaterThan(0);
		for (const call of pairChecks) expect.soft(call.request.hostTarget).toEqual({ otherVendorThan: { skinId: "codex", vendor: "openai" } });
		expect.soft(meta("stale-port").superseded_by).toBe("pending-port");
		expect.soft(meta("merge-language").superseded_by).toBe(meta("merge-causes").superseded_by);
		expect.soft(meta("merge-language").superseded_by).toEqual(expect.any(String));
		const changes = journal().filter(row => ["merged", "replaced"].includes(row.outcome));
		expect.soft(changes.map(row => row.outcome).sort()).toEqual(["merged", "replaced"]);
		for (const row of changes) expect.soft(row.detail.sameVendor).toBe(false); await inspect(false);
	});
});
