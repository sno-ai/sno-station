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
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { atomicExtractionSkillReference } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import { renderRemUpdateVerificationPrompt } from "../../../../packages/memory/src/engine/rem/rem-update-judgment";
import { bindStore } from "../../../../packages/memory/src/engine/shared/paths";
import { MODEL_CALLS, type ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../packages/memory/src/sidecar/rem-update-judgment-skill";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { callId, modelReply, type Recorder, type RecorderReply, startRecorder } from "./fixtures/model-recorders";
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
	// A key the recorder ignores; without one the Sno client refuses before any request leaves.
	vi.stubEnv("SNO_MEM_CLAW_LLM_API_KEY", "loopback-recorder");
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
		method: "POST", headers: { "x-sno-station-mem-skin": skin },
		body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
	});
}

/** A plugin with a model callback; routing is the mode and the language only (REQ-3). */
async function registerHost(skinId: string, hostUrl: string, mode: ProductMode, extra: Record<string, unknown> = {}): Promise<void> {
	const { remEnhanced: _remEnhanced, agentNative: _agentNative, language: _language, mode: _mode, ...settings } = pluginConfigSchema.parse({
		mode, retrieval: { rerank: "none" }, observe: { enabled: false }, ...extra,
	}) as Record<string, unknown>;
	const response = await contractPost("/v1/init", { scope: { ...SEED_SCOPE, session: skinId }, registration: {
		skinId, settings, routing: { mode, language: "en" },
		model: { baseUrl: `${hostUrl}/host/v1/`, credential: "loopback-credential", model: "loopback-model" },
	} }, skinId);
	expect(response.status).toBe(200);
}

/** The service reads `<profile>/settings.json` once, when its runtime opens: write it before the sidecar starts. */
function writeSettings(profile: "seed" | "mode", mode: ProductMode, overrides: SettingsDocument = {}): void {
	writeSettingsFixture(join(root, profile), { mode, store: { path: database.dbPath }, rerank: { mode: "none" },
		embedding: { cacheDir: "" }, telemetry: { observe: { enabled: false } }, ...overrides });
}

/** Points the mode profile's Sno GPU calls at a loopback recorder; the configured base URL wins over the environment. */
function pointSnoGpuAt(mode: ProductMode, url: string, overrides: SettingsDocument = {}): void {
	vi.stubEnv("GPU_BASE_URL", url);
	writeSettings("mode", mode, { snoGpu: { baseUrl: url }, ...overrides });
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
 * Stores the rows under a Local First profile (no model call), files `state` rows under their subject, then binds
 * the same store under the mode being tested with a due daily pass. The REM job reads its mode from this binding.
 */
async function seedStore(mode: ProductMode, episodic: string[], state: Array<[text: string, subject: string]>): Promise<void> {
	vi.stubEnv("SNO_PROFILE_DIR", join(root, "seed"));
	await bindStore(database.dbPath, { mode: "local-first", retrieval: { rerank: "none" } });
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
	await bindStore(database.dbPath, { mode, retrieval: { rerank: "none" } });
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
		await seedStore("rem-enhanced", ...FULL_PASS);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url, "rem-enhanced");
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
		await seedStore("agent-native", ...FULL_PASS);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt("agent-native", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url, "agent-native");
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
	it("host refuses REM2 after REM1 answered on the Sno GPU: rem_skipped, the closed pair stays closed, the next pass runs", { timeout: 180_000 }, async () => {
		await seedStore("rem-enhanced", [], [
			[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"],
			[OLDER_OFFICE, "entity:office"], [NEWER_OFFICE, "entity:office"],
		]);
		const sno = await recorder({ refuse: () => false, keepFirstPair: true });
		const host = await recorder({ refuse: id => id === "REM2" });
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url, "rem-enhanced");
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
		}).toEqual({ skipped: true, completed: 0, rem1AnsweredOnSno: 2, rem2RefusedOnHost: true, rem2Calls: 1, laterStages: 0 });
		const firstJobs = jobIds();
		const before = { sno: sno.received.length, host: host.received.length };
		host.refuse = () => false;
		await registerHost("host-skin", host.url, "rem-enhanced");
		await until(() => jobIds().length > firstJobs.length && (auditEvents("rem_completed").length > 0 || auditEvents("rem_failed").length > 0));
		const rejudged = [...sno.received.slice(before.sno), ...host.received.slice(before.host)]
			.filter(call => call.id === "REM1" && [OLDER_DEPLOYMENT, NEWER_DEPLOYMENT, OLDER_OFFICE, NEWER_OFFICE]
				.filter(text => keptPair.includes(text)).every(text => call.content.includes(text)));
		expect({ firstJobs: firstJobs.length, jobs: jobIds().length, completed: auditEvents("rem_completed").length,
			failed: auditEvents("rem_failed").length, keptPairJudgedAgain: rejudged.length })
			.toEqual({ firstJobs: 1, jobs: 2, completed: 1, failed: 0, keptPairJudgedAgain: 0 });
	});

	it("Sno GPU refuses REM1: rem_skipped and the host receives no REM call", { timeout: 180_000 }, async () => {
		await seedStore("rem-enhanced", [], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder({ refuse: id => id === "REM1" });
		const host = await recorder();
		pointSnoGpuAt("rem-enhanced", sno.url);
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url, "rem-enhanced");
		await until(settled);
		expect({ skipped: skipped(), completed: auditEvents("rem_completed").length,
			rem1RefusedOnSno: sno.received.some(call => call.id === "REM1" && !call.answered), hostRem: remSet(host) })
			.toEqual({ skipped: true, completed: 0, rem1RefusedOnSno: true, hostRem: [] });
	});
});

describe.each(["rem-enhanced", "agent-native"] as const)("%s: no connected plugin, no REM pass (REQ-4)", mode => {
	it("the tick opens no job and neither recorder receives a request", { timeout: 120_000 }, async () => {
		await seedStore(mode, [OLDER_HOME, RETRACTION], [[OLDER_DEPLOYMENT, "entity:deployment"], [NEWER_DEPLOYMENT, "entity:deployment"]]);
		const sno = await recorder();
		const host = await recorder();
		pointSnoGpuAt(mode, sno.url);
		vi.stubEnv("SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS", "500");
		sidecar = await startRemSidecar();
		// Opens the memory runtime, and with it the tick, through a registration without a model callback.
		expect((await contractPost("/v1/inspect", { scope: SEED_SCOPE, op: { op: "stats" } }, "reader")).status).toBe(200);
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
			await registerHost(SKIN, host.url, mode);
			await (await contractPost("/v1/capture", { scope: { ...SEED_SCOPE, session: SKIN }, turn: { turnId: `capture-${mode}`, rewindEpoch: 0,
				messages: [{ role: "user", content: "I keep a blue notebook for meeting notes.", at: 1789606800000 }] } }, SKIN)).text();
		} },
		"profile write": { primary: ["P4"], run: async host => {
			await registerHost(SKIN, host.url, mode);
			for (const content of ["My preferred code editor is Vim.", "My preferred code editor is Helix."]) {
				await (await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content, category: "profile",
					metadata: { section_name: "preferences.editor" } } }, SKIN)).text();
			}
		} },
		"task write": { primary: ["T1"], run: async host => {
			await registerHost(SKIN, host.url, mode);
			for (const content of ["Draft the quarterly budget review for the finance team.", "Prepare the finance team's quarterly budget review draft."]) {
				await (await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content, category: "profile",
					metadata: { section_name: "active_tasks" } } }, SKIN)).text();
			}
		} },
		reflection: { primary: ["R1"], settings: { capture: { sessionStrategy: "memoryReflection" } }, run: async host => {
			await registerHost(SKIN, host.url, mode, { sessionStrategy: "memoryReflection" });
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
		await bindStore(database.dbPath, { mode, retrieval: { rerank: "none" } });
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
		await seedStore(mode, [], [["The deployment is waiting on the security review.", "entity:deployment"]]);
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
