/** @file rem-enhanced-mode.test.ts
 * @purpose REM Enhanced and Agent Native send each REM call where the model-call table says (rem-enhanced PRD
 * REQ-1, REQ-2, REQ-4): the destination of every REM stage, the prompt each destination receives, the stop on a
 * refused call, and no pass while no plugin is connected.
 * @boundary Real sidecar, SQLite store, embeddings, REM executor, job and audit journals; two loopback recorders
 * stand in for the Sno GPU and the host model callback and answer every stage with a valid reply.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductMode } from "../../../../packages/memory/config/plugin-config-mode-schema";
import { atomicExtractionSkillReference } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import { renderRemUpdateVerificationPrompt } from "../../../../packages/memory/src/engine/rem/rem-update-judgment";
import { MODEL_CALLS, type ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../packages/memory/src/sidecar/rem-update-judgment-skill";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { evaluateRemAutomaticTriggers } from "../../../../packages/memory/src/sidecar/rem-trigger";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { callId, modelReply, type Recorder, type RecorderReply, startRecorder } from "./fixtures/model-recorders";
import { untilModelReady } from "./fixtures/model-ready";
import { type SettingsDocument, writeSettingsFixture } from "../fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const SEED_SCOPE = { principal: "caller", project: "global", session: "rem-enhanced-seed" };
const REM_IDS = ["REM1", "REM2", "REM3", "REM4", "REM5", "REM6", "REM7", "REM8"];
// Replace path: two state rows about one subject; the older one carries a second clause, which REM4 carries forward.
const OLDER_DEPLOYMENT = "The deployment runs on Kubernetes; the team deploys on Fridays.";
const NEWER_DEPLOYMENT = "The deployment runs on Nomad.";
const OLDER_OFFICE = "The office is in Berlin; the office opens at nine.";
const NEWER_OFFICE = "The office moved to Munich.";
// Update path: a retraction (REM8 picks its target, REM7 relates them, REM5 rewrites, REM6 verifies).
const OLDER_HOME = "I live in Boston, and I work at Acme.";
const RETRACTION = "I no longer live in Boston.";
const REWRITE = { proposed_current: "I work at Acme.", retired_values: ["I live in Boston"] };

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rem-enhanced-mode-"));
	database = createTestDb();
});
afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
});

function jsonAfter(content: string, prefix: string): unknown {
	const line = content.split("\n").find(candidate => candidate.startsWith(prefix));
	return line ? JSON.parse(line.slice(prefix.length)) : undefined;
}

/** A valid answer for every REM stage, the same at either destination, so a misrouted call still moves the pass on. */
function remAnswer(id: string, content: string, firstRem1: boolean): string {
	switch (id) {
		// A subject's older and newer row are a replacement; any other pair, and the first pair judged when asked, is kept.
		case "REM1": return !firstRem1 && [[OLDER_DEPLOYMENT, NEWER_DEPLOYMENT], [OLDER_OFFICE, NEWER_OFFICE]]
			.some(pair => pair.every(text => content.includes(text))) ? "replacement" : "keep";
		case "REM2": {
			const clauses = jsonAfter(content, "Eligible clauses: ") as Array<{ origin: string }>;
			return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [clauses.findIndex(clause => clause.origin === "older")] });
		}
		// Clause 0 retires and is covered; clause 1 is left uncertified, so the pass carries it (REM4).
		case "REM3": return JSON.stringify({ atoms: [{ clause_index: 0, class: "current-fact", status: "covered" }] });
		case "REM4": return JSON.stringify({ already_current: content.split("\n").filter(line => /^Clause \d+: /.test(line)).map(() => false) });
		case "REM5": return JSON.stringify(REWRITE);
		case "REM6": return JSON.stringify({ faithful: true, retired_absent: true, all_facts_accounted: true });
		case "REM7": return JSON.stringify({ supersedes: true, retires_anything: true, supersedes_everything: false });
		case "REM8": {
			const offered = (jsonAfter(content, "Candidate rows: ") ?? []) as Array<{ id: string; text: string }>;
			return JSON.stringify({ target_row_ids: offered.filter(row => row.text === OLDER_HOME).map(row => row.id) });
		}
		default: return "{}";
	}
}

type Refuse = (id: string, recorder: Recorder) => boolean;
const refusal = (): RecorderReply => ({ status: 503, body: { error: "worker-not-ready" } });

/** A recorder answering every REM stage; `refuse` picks the calls it refuses; `keepFirstPair` keeps the first REM1. */
async function recorder(control: { refuse: Refuse; keepFirstPair?: boolean } = { refuse: () => false }) {
	const endpoint = await startRecorder(closers, ({ id, content, raw }, seen) => {
		if (control.refuse(id, seen)) return refusal();
		const firstRem1 = control.keepFirstPair === true && id === "REM1" && seen.calls.filter(call => call === "REM1").length === 1;
		return modelReply(remAnswer(id, content, firstRem1), raw);
	});
	return Object.assign(control, endpoint);
}

async function contractPost(path: string, body: unknown, skin: string): Promise<Response> {
	if (!sidecar) throw new Error("missing test sidecar");
	return fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
		method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: JSON.parse(readFileSync(join(process.env.SNO_PROFILE_DIR!, "station", "sidecar.json"), "utf8")).token, "x-sno-station-mem-skin": skin },
		body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
	});
}

/** A plugin with a model callback; a registration is the skin and its model only, the mode comes from settings.json (REQ-4). */
async function registerHost(skinId: string, hostUrl: string): Promise<void> {
	const response = await contractPost("/v1/init", { scope: { ...SEED_SCOPE, session: skinId }, registration: {
		skinId,
		model: { baseUrl: `${hostUrl}/host/v1/`, credential: "loopback-credential", model: "loopback-model" },
	} }, skinId);
	expect(response.status).toBe(200);
}

/** The service reads `<profile>/settings.json` once, when its runtime opens: write it before the sidecar starts. */
function writeSettings(profile: "seed" | "mode", mode: ProductMode, overrides: SettingsDocument = {}): void {
	// A Sno GPU key the recorder ignores; without one the Sno client refuses before any request leaves.
	writeSettingsFixture(join(root, profile), { mode, store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		snoGpu: { apiKey: "loopback-recorder" }, rerank: { mode: "none" }, embedding: { cacheDir: "" },
		telemetry: { observe: { enabled: false } }, ...overrides });
}

/** Points the mode profile's Sno GPU calls at a loopback recorder. */
function pointSnoGpuAt(mode: ProductMode, url: string, overrides: SettingsDocument = {}): void {
	writeSettings("mode", mode, { snoGpu: { baseUrl: url, apiKey: "loopback-recorder" }, ...overrides });
}

const stateDir = () => join(root, "mode", "sno-station-mem");
function lines(name: string): string[] {
	const path = join(stateDir(), name);
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line.trim()) : [];
}
const audit = () => lines("audit.jsonl");
const jobIds = () => [...new Set(lines("rem-wave-jobs.jsonl").map(line => JSON.parse(line).waveId as string))];
const auditEvents = (event: string) => audit().filter(line => JSON.parse(line).event === event);
const skipped = () => [...audit(), ...lines("rem-wave-jobs.jsonl")].some(line => line.includes("rem_skipped"));
const settled = () => skipped() || auditEvents("rem_completed").length > 0 || auditEvents("rem_failed").length > 0;

async function until(check: () => boolean, ms = 60_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end && !check()) await delay(100);
}

/**
 * Stores the rows under a Local First profile (no model call), files `state` rows under their subject, then gives
 * the mode profile a due daily pass. The REM job reads its mode from that profile's settings.json.
 */
async function seedStore(episodic: string[], state: Array<[text: string, subject: string]>): Promise<void> {
	vi.stubEnv("SNO_PROFILE_DIR", join(root, "seed"));
	writeSettings("seed", "local-first");
	sidecar = await startRemSidecar();
	for (const text of [...state.map(([text]) => text), ...episodic]) {
		const response = await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content: text, category: "episodic" } }, "seed");
		expect(response.status).toBe(200);
	}
	await sidecar.stop();
	sidecar = undefined;
	const rekey = database.sqlite.prepare("UPDATE nodix_memories SET category = 'state', subject = ?, attribute = NULL WHERE text = ?");
	for (const [text, subject] of state) expect(rekey.run(subject, text).changes).toBe(1);
	const scopes = database.sqlite.prepare("SELECT DISTINCT project_id AS scope FROM nodix_memories").all() as Array<{ scope: string }>;
	const [only, ...others] = scopes;
	if (!only || others.length > 0) throw new Error(`expected one REM scope, found ${JSON.stringify(scopes)}`);
	vi.stubEnv("SNO_PROFILE_DIR", join(root, "mode"));
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(join(stateDir(), "rem-trigger-state.json"), JSON.stringify({ version: 1, scopes: { [only.scope]: {
		last_pass_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), schedule_zone: "UTC", last_covered_count: 0,
		last_volume_pass_date: null, missed_window: null, attempts: { identity: null, count: 0 },
	} } }));
}

const remSet = (recorder: Recorder) => [...new Set(recorder.calls.filter(id => id.startsWith("REM")))].sort();

describe("one REM pass sends each stage where the table says (REQ-1, REQ-2)", () => {
	const FULL_PASS: [string[], Array<[string, string]>] = [
		[OLDER_HOME, RETRACTION],
		[[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]],
	];
	// The update-path verification prompt, as the executor renders it today for this seed.
	const UPDATE_VERIFICATION = renderRemUpdateVerificationPrompt({
		judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification, source: OLDER_HOME, supersedingText: RETRACTION,
		proposedCurrent: REWRITE.proposed_current, retiredValues: REWRITE.retired_values,
	});

	it("REM Enhanced: REM1, REM3, REM4, REM5 on the Sno GPU; REM2, REM6, REM7, REM8 on the host", { timeout: 180_000 }, async () => {
		await seedStore(...FULL_PASS);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		const all = [...sno.received, ...host.received];
		expect({ reached: [...new Set(all.map(call => call.id).filter(id => id.startsWith("REM")))].sort(),
			completed: auditEvents("rem_completed").length, skipped: skipped(),
			verificationAsRendered: all.some(call => call.id === "REM6" && call.content === UPDATE_VERIFICATION) },
		"the seed must reach all eight REM stages").toEqual({ reached: REM_IDS, completed: 1, skipped: false, verificationAsRendered: true });
		const rem1OnSno = sno.received.filter(call => call.id === "REM1");
		expect({
			sno: remSet(sno), host: remSet(host),
			rem1RawVerdict: rem1OnSno.length > 0 && rem1OnSno.every(call => call.raw && call.content.trimEnd().endsWith("Verdict:")),
			rem5RewriteSkill: sno.received.some(call => call.id === "REM5" && call.content.startsWith(REM_UPDATE_JUDGMENT_SKILL.rewrite)),
			rem6Verification: host.received.some(call => call.id === "REM6" && call.content === UPDATE_VERIFICATION),
		}).toEqual({
			sno: ["REM1", "REM3", "REM4", "REM5"], host: ["REM2", "REM6", "REM7", "REM8"],
			rem1RawVerdict: true, rem5RewriteSkill: true, rem6Verification: true,
		});
	});

	it("Agent Native: all eight REM stages on the host, REM1 as the chat prompt, nothing on the Sno GPU", { timeout: 180_000 }, async () => {
		await seedStore(...FULL_PASS);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt("agent-native", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		const rem1OnHost = host.received.filter(call => call.id === "REM1");
		expect({
			sno: sno.calls, host: remSet(host), completed: auditEvents("rem_completed").length,
			rem1Chat: rem1OnHost.length > 0 && rem1OnHost.every(call => !call.raw
				&& call.content.startsWith("Adjudicate whether the newer memory replaces the older memory.")),
			rem6Verification: host.received.some(call => call.id === "REM6" && call.content === UPDATE_VERIFICATION),
		}).toEqual({ sno: [], host: REM_IDS, completed: 1, rem1Chat: true, rem6Verification: true });
	});
});

describe("REM Enhanced stops at the first refused call (REQ-4)", () => {
	it("host refuses REM2 after REM1 answered on the Sno GPU: rem_completed, the closed pair stays closed, neither trigger runs again", { timeout: 180_000 }, async () => {
		await seedStore([], [
			[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"],
			[OLDER_OFFICE, "entity:office"], [NEWER_OFFICE, "entity:office"],
		]);
		const sno = await recorder({ refuse: () => false, keepFirstPair: true });
		const host = await recorder({ refuse: id => id === "REM2" });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		const judged = [...sno.received, ...host.received].filter(call => call.id === "REM1" && call.answered);
		const keptPair = judged[0]?.content ?? "";
		expect({
			skipped: skipped(), completed: auditEvents("rem_completed").length,
			rem1AnsweredOnSno: sno.received.filter(call => call.id === "REM1" && call.answered).length,
			rem2RefusedOnHost: host.received.some(call => call.id === "REM2" && !call.answered),
			// The first refusal stops the job: no second REM2 and no later stage on either destination.
			rem2Calls: host.received.filter(call => call.id === "REM2").length,
			laterStages: [...sno.received, ...host.received]
				.filter(call => ["REM3", "REM4", "REM5", "REM6", "REM7", "REM8"].includes(call.id)).length,
		}).toEqual({ skipped: false, completed: 1, rem1AnsweredOnSno: 2, rem2RefusedOnHost: true, rem2Calls: 1, laterStages: 0 });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_scan_pairs WHERE verdict = 'keep' AND claim_state = 'done'").get()).toEqual({ count: 1 });
		const completed = JSON.parse(auditEvents("rem_completed")[0] ?? "{}");
		expect(completed.details.stats.measured).toMatchObject({ rows_considered: 4, pair_cap_binding: true, model_calls: 3 });
		expect(completed.details.stats.top_refusal_reasons).toContain("host-refused:REM2");
		host.refuse = () => false;
		await registerHost("host-skin", host.url);
		const scope = (database.sqlite.prepare("SELECT DISTINCT project_id AS scope FROM nodix_memories").get() as { scope: string }).scope;
		await evaluateRemAutomaticTriggers({ database: database.runtime.db, stateDir: stateDir(), requestedOperations: ["rem-replace", "rem-update"],
			modelCalls: JSON.parse(readFileSync(join(root, "mode", "settings.json"), "utf8")).modelCalls, volumeThreshold: 1 });
		expect({ jobs: jobIds().length, completed: auditEvents("rem_completed").length, failed: auditEvents("rem_failed").length }).toEqual({ jobs: 1, completed: 1, failed: 0 });
		expect(JSON.parse(readFileSync(join(stateDir(), "rem-trigger-state.json"), "utf8")).scopes[scope].last_covered_count).toBe(0);
	});
});

describe.each(["rem-enhanced", "agent-native"] as const)("%s interrupted completion", mode => {
	it("host refuses REM8 after keep verdicts: completes and survives registration with daily and volume due", { timeout: 180_000 }, async () => {
		await seedStore([OLDER_HOME, RETRACTION], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await startRecorder(closers, ({ id, content, raw }) => modelReply(id === "REM1" ? "keep" : remAnswer(id, content, false), raw));
		const host = await startRecorder(closers, ({ id, content, raw }) => id === "REM8" ? refusal() : modelReply(id === "REM1" ? "keep" : remAnswer(id, content, false), raw));
		pointSnoGpuAt(mode, sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped(), jobs: jobIds().length }).toEqual({ completed: 1, skipped: false, jobs: 1 });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_journal WHERE reason = 'keep' AND outcome = 'no-action'").get()).toEqual({ count: 3 });
		expect(JSON.parse(auditEvents("rem_completed")[0] ?? "{}").details.stats.top_refusal_reasons).toContain("host-refused:REM8");
		await registerHost("host-skin", host.url);
		await evaluateRemAutomaticTriggers({ database: database.runtime.db, stateDir: stateDir(), requestedOperations: ["rem-replace", "rem-update"],
			modelCalls: JSON.parse(readFileSync(join(root, "mode", "settings.json"), "utf8")).modelCalls, volumeThreshold: 1 });
		expect(jobIds()).toHaveLength(1);
	});

	it("host refuses REM8 after a replacement write: the write and its count survive", { timeout: 180_000 }, async () => {
		await seedStore([OLDER_HOME, RETRACTION], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder();
		const host = await recorder({ refuse: id => id === "REM8" });
		pointSnoGpuAt(mode, sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped() }).toEqual({ completed: 1, skipped: false });
		expect(JSON.parse(auditEvents("rem_completed")[0] ?? "{}").details.stats).toMatchObject({ applied_count: 1, measured: { rows_considered: 4, pair_cap_binding: true } });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_write_attempts WHERE writer = 'softClose' AND outcome = 'succeeded'").get()).toEqual({ count: 1 });
	});

	it("host refuses a second retirement judgment after an update write: preserves the current text and count", { timeout: 180_000 }, async () => {
		const berlinRetraction = "I no longer live in Berlin.";
		await seedStore([OLDER_HOME, RETRACTION, "I live in Berlin.", berlinRetraction], []);
		for (const [text, topic] of [[OLDER_HOME, "home"], [RETRACTION, "home"], ["I live in Berlin.", "office"], [berlinRetraction, "office"]]) {
			database.sqlite.prepare("UPDATE nodix_memories SET metadata = json_set(metadata, '$.topic', ?) WHERE text = ?").run(topic, text);
		}
		const sno = await recorder();
		const host = await recorder({ refuse: (id, seen) => id === "REM8" && seen.calls.filter(call => call === "REM8").length === 2 });
		pointSnoGpuAt(mode, sno.url, { rem: { operations: ["rem-update"] } });
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped() }).toEqual({ completed: 1, skipped: false });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories WHERE text = 'I work at Acme.'").get()).toEqual({ count: 1 });
		expect(JSON.parse(auditEvents("rem_completed")[0] ?? "{}").details.stats).toMatchObject({ applied_count: 1,
			measured: { rows_considered: 4, pair_cap_binding: true, model_calls: 5 } });
	});

	it("host refuses the first call: no valid work is not completed and registration stops after three skips", { timeout: 180_000 }, async () => {
		await seedStore([], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder();
		const host = await recorder({ refuse: () => true });
		pointSnoGpuAt(mode, sno.url);
		sidecar = await startRemSidecar();
		for (let attempt = 1; attempt <= 4; attempt++) {
			await registerHost("host-skin", host.url);
			if (attempt <= 3) await until(() => auditEvents("rem_skipped").length >= attempt);
		}
		expect({ completed: auditEvents("rem_completed").length, skipped: auditEvents("rem_skipped").length, jobs: jobIds().length }).toEqual({ completed: 0, skipped: 3, jobs: 3 });
	});
});

it("gateway failure across real host registrations stops dispatch after three attempts", { timeout: 180_000 }, async () => {
	await seedStore([], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
	const sno = await recorder();
	const host = await recorder();
	const gateway = await startRecorder(closers, () => ({ status: 500, body: { error: "dispatch unavailable" } }));
	pointSnoGpuAt("rem-enhanced", sno.url);
	sidecar = await startRemSidecar();
	const discoveryPath = join(root, "mode", "station", "sidecar.json");
	const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
	writeFileSync(discoveryPath, JSON.stringify({ ...discovery, port: Number(new URL(gateway.url).port) }));
	for (let attempt = 1; attempt <= 4; attempt++) {
		await registerHost("host-skin", host.url);
		await until(() => auditEvents("rem_failed").length >= Math.min(attempt, 3), 10_000);
	}
	await until(() => Object.values(JSON.parse(readFileSync(join(stateDir(), "rem-trigger-state.json"), "utf8")).scopes)
		.some(scope => (scope as { last_volume_pass_date: string | null }).last_volume_pass_date !== null), 5_000);
	expect({ dispatches: gateway.calls.length, failures: auditEvents("rem_failed").length, jobs: jobIds(), gpuCalls: sno.calls })
		.toEqual({ dispatches: 3, failures: 3, jobs: [], gpuCalls: [] });
});

describe.each(["empty", "error"])("Sno GPU fallback: %s", failure => {
	it("host refusal after a keep is preserved and ends the pass", { timeout: 180_000 }, async () => {
		await seedStore([], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"],
			[OLDER_OFFICE, "entity:office"], [NEWER_OFFICE, "entity:office"],
			["The project uses Git.", "entity:project"], ["The project uses Mercurial.", "entity:project"]]);
		const sno = await startRecorder(closers, ({ raw }, seen) => seen.received.length === 0 ? modelReply("keep", raw)
			: failure === "empty" ? modelReply("", raw) : { status: 500, body: { error: "model unavailable" } });
		const host = await recorder({ refuse: () => true });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped(), jobs: jobIds().length }).toEqual({ completed: 1, skipped: false, jobs: 1 });
		expect(host.calls).toEqual(["REM1"]);
		expect(new Set(sno.received.map(call => call.content)).size).toBe(2);
		expect(JSON.parse(auditEvents("rem_completed")[0] ?? "{}").details.stats.top_refusal_reasons).toContain("host-refused:REM1");
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_scan_pairs WHERE verdict = 'keep' AND claim_state = 'done'").get()).toEqual({ count: 1 });
	});
});

describe.each(["audit", "job journal"])("completion write fails: %s", target => {
	it("ends the job after its writes instead of leaving it running", { timeout: 180_000 }, async () => {
		await seedStore([], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder();
		const path = join(stateDir(), target === "audit" ? "audit.jsonl" : "rem-wave-jobs.jsonl");
		const host = await startRecorder(closers, ({ id, content, raw }) => {
			if (id === "REM2") { rmSync(path); mkdirSync(path); }
			return modelReply(remAnswer(id, content, false), raw);
		});
		pointSnoGpuAt("rem-enhanced", sno.url, { rem: { tick: false } });
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		const token = JSON.parse(readFileSync(join(root, "mode", "station", "sidecar.json"), "utf8")).token;
		const scope = (database.sqlite.prepare("SELECT DISTINCT project_id AS scope FROM nodix_memories").get() as { scope: string }).scope;
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: token },
			body: JSON.stringify({ type: "rem-replace", scope }) });
		expect(response.status).toBe(202);
		const jobId = (await response.json()).job_id;
		let state = "running";
		const end = Date.now() + 20_000;
		while (state !== "done" && Date.now() < end) {
			const job = await (await fetch(`http://127.0.0.1:${sidecar.port}/rem/jobs/${jobId}`, { headers: { [REM_SIDECAR_TOKEN_HEADER]: token } })).json();
			state = job.state;
			if (state !== "done") await delay(100);
		}
		expect(state).toBe("done");
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_write_attempts WHERE writer = 'softClose' AND outcome = 'succeeded'").get()).toEqual({ count: 1 });
	});
});

describe("REM Enhanced spends no Sno GPU call without a host that can still answer", () => {
	// The coding-agent workers that answer host calls leave after two idle minutes, and a REM Enhanced pass spends
	// minutes on Sno GPU verdicts before its first host call. On a workstation the pass kept judging on the GPU for
	// seven minutes after its worker had left, then ended rem_skipped at the first host call: every verdict wasted.
	const scopeOf = () => (database.sqlite.prepare("SELECT DISTINCT project_id AS scope FROM nodix_memories").get() as { scope: string }).scope;
	const notDue = () => writeFileSync(join(stateDir(), "rem-trigger-state.json"), JSON.stringify({ version: 1, scopes: { [scopeOf()]: {
		last_pass_at: new Date().toISOString(), schedule_zone: "UTC", last_covered_count: 0,
		last_volume_pass_date: new Date().toISOString().slice(0, 10), missed_window: null, attempts: { identity: null, count: 0 },
	} } }));
	const startPass = async () => {
		const response = await fetch(`http://127.0.0.1:${sidecar?.port}/rem/run`, {
			method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: JSON.parse(readFileSync(join(process.env.SNO_PROFILE_DIR!, "station", "sidecar.json"), "utf8")).token },
			body: JSON.stringify({ type: "rem-replace", scope: scopeOf() }), signal: AbortSignal.timeout(10_000),
		});
		expect(response.status).toBe(202);
	};
	const seedPairs = () => seedStore([], [
		[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"],
		[OLDER_OFFICE, "entity:office"], [NEWER_OFFICE, "entity:office"],
	]);

	it("stops before the next Sno GPU verdict once its host has gone", { timeout: 180_000 }, async () => {
		await seedPairs();
		notDue();
		const host = await recorder();
		const closeHost = closers.at(-1);
		const sno = await recorder({ refuse: (id, seen) => {
			// The worker leaves while the pass is still judging on the GPU.
			if (id === "REM1" && seen.calls.filter(call => call === "REM1").length === 1) void closeHost?.();
			return false;
		}, keepFirstPair: true });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await startPass();
		await until(settled);
		expect({ skipped: skipped(), completed: auditEvents("rem_completed").length, rem1OnSno: sno.calls.filter(call => call === "REM1").length, hostCalls: host.calls.length })
			.toEqual({ skipped: false, completed: 1, rem1OnSno: 1, hostCalls: 0 });
	});

	it("moves to an older host when the newest one answers that it is not ready", { timeout: 180_000 }, async () => {
		await seedPairs();
		notDue();
		const older = await recorder();
		// Still listening, but its worker refuses every call with a typed 503 (worker-not-ready).
		const newest = await recorder({ refuse: () => true });
		const sno = await recorder({ refuse: () => false, keepFirstPair: true });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("older-skin", older.url);
		await registerHost("host-skin", newest.url);
		await startPass();
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped(), refusedOnNewest: remSet(newest).includes("REM2"),
			answeredOnOlder: remSet(older).includes("REM2") })
			.toEqual({ completed: 1, skipped: false, refusedOnNewest: true, answeredOnOlder: true });
	});

	it("moves to another connected host when the one it started with has gone", { timeout: 180_000 }, async () => {
		await seedPairs();
		notDue();
		const other = await recorder();
		const first = await recorder();
		const closeFirst = closers.at(-1);
		const sno = await recorder({ refuse: (id, seen) => {
			if (id === "REM1" && seen.calls.filter(call => call === "REM1").length === 1) void closeFirst?.();
			return false;
		}, keepFirstPair: true });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("other-skin", other.url);
		// Registered last, so the pass starts with this one.
		await registerHost("host-skin", first.url);
		await startPass();
		await until(settled);
		expect({ completed: auditEvents("rem_completed").length, skipped: skipped(), firstCalls: first.calls.length,
			remOnOther: remSet(other).includes("REM2") })
			.toEqual({ completed: 1, skipped: false, firstCalls: 0, remOnOther: true });
	});
});

describe.each(["rem-enhanced", "agent-native"] as const)("%s: no connected plugin, no REM pass (REQ-4)", mode => {
	it("the tick opens no job and neither recorder receives a request", { timeout: 120_000 }, async () => {
		await seedStore([OLDER_HOME, RETRACTION], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt(mode, sno.url);
		vi.stubEnv("SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS", "500");
		sidecar = await startRemSidecar();
		// Opens the memory runtime, and with it the tick, through a registration without a model callback. A read-only
		// stats request no longer starts background work, so it cannot stand in for one.
		expect((await contractPost("/v1/init", { scope: { ...SEED_SCOPE, session: "reader" }, registration: { skinId: "reader" } }, "reader")).status).toBe(200);
		await until(() => auditEvents("rem_trigger_evaluated").length > 0, 10_000);
		await delay(2_000);
		expect({ skipLogged: audit().some(line => line.includes("skipped: no host model connected")),
			jobs: jobIds(), snoCalls: sno.calls, hostCalls: host.calls })
			.toEqual({ skipLogged: true, jobs: [], snoCalls: [], hostCalls: [] });
	});
});

/** Labels a non-REM call by its prompt: the conflict-verdict prompts belong to P1 or E10, which share a destination. */
function nonRemCall(content: string): string {
	if (content.startsWith(atomicExtractionSkillReference("capture"))) return "E1";
	if (content.includes('{"action":"open_or_refine') || content.includes('{"result":"same_instance"')) return "T1";
	if (content.includes("name: key-state-attribute")) return "E12";
	if (content.startsWith("You are generating a durable MEMORY REFLECTION entry")) return "R1";
	const id = callId(content);
	return id === "REM1" ? "P1" : id;
}

/** Where the model-call table sends a labelled call; an unknown label has none and fails the comparison. */
function tableDestination(label: string, mode: ProductMode): string {
	return label in MODEL_CALLS ? MODEL_CALLS[label as ModelCallId].destinations[mode] : `unknown call: ${label}`;
}

describe.each(["rem-enhanced", "agent-native"] as const)("%s: the other twenty calls follow the table (REQ-1)", mode => {
	const SKIN = "entry-skin";
	type Entry = { primary: string[]; settings?: SettingsDocument; run: (host: Recorder) => Promise<void> };
	const entries: Record<string, Entry> = {
		capture: { primary: ["E1"], run: async host => {
			// A capture before the embedding model is prepared is only accepted; E1 runs after preparation.
			await untilModelReady(async ({ scope, ...recall }) =>
				(await contractPost("/v1/get-recall", { ...recall, scope: { ...scope, principal: SEED_SCOPE.principal } }, "model-ready-probe")).json());
			await registerHost(SKIN, host.url);
			await (await contractPost("/v1/capture", { scope: { ...SEED_SCOPE, session: SKIN }, turn: { turnId: `capture-${mode}`, rewindEpoch: 0,
				messages: [{ role: "user", content: "I keep a blue notebook for meeting notes.", at: 1789606800000 }] } }, SKIN)).text();
		} },
		"profile write": { primary: ["P4"], run: async host => {
			await registerHost(SKIN, host.url);
			for (const content of ["My preferred code editor is Vim.", "My preferred code editor is Helix."]) {
				await (await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content, category: "profile",
					metadata: { section_name: "preferences.editor" } } }, SKIN)).text();
			}
		} },
		"task write": { primary: ["T1"], run: async host => {
			await registerHost(SKIN, host.url);
			for (const content of ["Draft the quarterly budget review for the finance team.", "Prepare the finance team's quarterly budget review draft."]) {
				await (await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content, category: "profile",
					metadata: { section_name: "active_tasks" } } }, SKIN)).text();
			}
		} },
		reflection: { primary: ["R1"], settings: { capture: { sessionStrategy: "memoryReflection" } }, run: async host => {
			await registerHost(SKIN, host.url);
			const sessionFile = join(root, "session.jsonl");
			writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: "Always keep clear notebook records for every meeting." } })}\n`);
			const response = await contractPost("/v1/on-session-end", { scope: { ...SEED_SCOPE, session: `agent:reflection:${mode}`,
				host: { workspace: root, boundary: "new", sessionFile, sessionId: `reflection-${mode}` } }, messages: [] }, SKIN);
			const text = await response.text();
			expect(response.status, text).toBe(200);
		} },
	};

	it.each(Object.keys(entries))("%s", { timeout: 120_000 }, async name => {
		const entry = entries[name];
		if (!entry) throw new Error(`unknown entry ${name}`);
		vi.stubEnv("SNO_PROFILE_DIR", join(root, "mode"));
		const sno = await startRecorder(closers, ({ raw }) => modelReply(raw ? "keep" : "{}", raw));
		const host = await startRecorder(closers, () => modelReply("{}", false));
		pointSnoGpuAt(mode, sno.url, entry.settings);
		sidecar = await startRemSidecar();
		await entry.run(host);
		const seen = (recorder: Recorder, at: string) => recorder.received.map(call => nonRemCall(call.content))
			.map(label => ({ label, at, table: tableDestination(label, mode) }));
		const calls = [...seen(sno, "sno-gpu"), ...seen(host, "host")];
		expect({
			misrouted: calls.filter(call => call.at !== call.table),
			primary: entry.primary.map(label => ({ label, reached: calls.some(call => call.label === label && call.at === tableDestination(label, mode)) })),
		}).toEqual({ misrouted: [], primary: entry.primary.map(label => ({ label, reached: true })) });
	});

	it("group maintenance", { timeout: 120_000 }, async () => {
		await seedStore([], [["The deployment is waiting on the security review.", "entity:deployment"]]);
		const sno = await startRecorder(closers, () => modelReply("{}", false));
		pointSnoGpuAt(mode, sno.url);
		const run = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
			const child = spawn(join(repoRoot, "node_modules/.bin/tsx"), ["src/engine/maintenance/run-group-crud-maintenance.ts", database.dbPath],
				{ cwd: join(repoRoot, "packages/memory"), env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", chunk => { stderr += chunk; });
			child.once("error", reject);
			child.once("close", code => done({ code, stderr }));
		});
		// No plugin's host is reachable from this command, so a host call is skipped; a Sno call is made.
		const labels = sno.received.map(call => nonRemCall(call.content));
		expect({ exitCode: run.code, misrouted: labels.filter(label => tableDestination(label, mode) !== "sno-gpu"),
			reachedSno: labels.length > 0 }, run.stderr.slice(-2000))
			.toEqual({ exitCode: 0, misrouted: [], reachedSno: mode === "rem-enhanced" });
	});
});
