/** @file local-first-mode.test.ts
 * @purpose Local First routes every model call as the model-call table says (local-first PRD REQ-2..REQ-5, REQ-7).
 * @boundary Real sidecar, SQLite store, embeddings, job and audit journals; two loopback recorders stand in
 * for the Sno GPU and the host model callback. Calls are told apart by a fixed line of each prompt.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicExtractionSkillReference } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-skill";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { modelReply, type RecorderReply, startRecorder } from "./fixtures/model-recorders";
import { untilModelReady } from "./fixtures/model-ready";
import { type SettingsDocument, writeSettingsFixture } from "../fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const SEED_SCOPE = { principal: "caller", project: "global", session: "local-first-seed" };
let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
const closers: Array<() => Promise<void>> = [];
const previousProfile = process.env.SNO_PROFILE_DIR;

/** The service reads `settings.json` once, when its runtime opens: write it before the sidecar starts. */
function writeSettings(overrides: SettingsDocument = {}): void {
	// A Sno GPU key the recorder ignores; without one the Sno client refuses before any request leaves.
	writeSettingsFixture(root, { mode: "local-first", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		snoGpu: { apiKey: "loopback-recorder" }, rerank: { mode: "none" }, embedding: { cacheDir: "" },
		telemetry: { observe: { enabled: false } }, ...overrides });
}

/** Points every Sno GPU call at a loopback recorder. */
function pointSnoGpuAt(url: string): void {
	writeSettings({ snoGpu: { baseUrl: url, apiKey: "loopback-recorder" } });
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "local-first-mode-"));
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	writeSettings();
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
});
afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

type HostMode = "answer" | "auth" | "exhausted" | "answer-first-rem-then-refuse" | "p4-then-auth" | "p4-then-exhausted" | "p4-p3-then-auth";

/** One loopback endpoint; records the call id of every prompt it receives. */
async function recorder(kind: "sno" | "host", initialMode: HostMode = "answer") {
	const state = { mode: initialMode };
	const refuse = (status: number, error: unknown): RecorderReply => ({ status, body: { error } });
	const endpoint = await startRecorder(closers, ({ id, content }, seen) => {
		if (kind === "sno") return refuse(503, "loopback Sno recorder");
		if (state.mode === "auth") return refuse(401, { kind: "error", category: "auth", message: "loopback auth refusal" });
		if (state.mode === "exhausted") return refuse(503, { kind: "error", category: "exhausted", message: "loopback quota refusal" });
		const afterP4 = state.mode === "p4-then-exhausted" ? "exhausted" : state.mode.startsWith("p4-") ? "auth" : undefined;
		if (afterP4 && ["P2", "P3", "P5", "P6"].includes(id) && !(state.mode === "p4-p3-then-auth" && id === "P3")) {
			return refuse(afterP4 === "auth" ? 401 : 503, { kind: "error", category: afterP4, message: `loopback ${afterP4} refusal` });
		}
		if (state.mode === "answer-first-rem-then-refuse" && id.startsWith("REM")
			&& seen.calls.filter(call => call.startsWith("REM")).length > 1) {
			return refuse(503, "worker-not-ready");
		}
		return modelReply(hostAnswer(id, content), false);
	});
	// The same arrays the recorder fills; `mode` stays switchable mid-test.
	return Object.assign(state, endpoint);
}

function jsonAfter(content: string, prefix: string): unknown[] {
	const line = content.split("\n").find(candidate => candidate.startsWith(prefix));
	return line ? JSON.parse(line.slice(prefix.length)) as unknown[] : [];
}

function hostAnswer(id: string, content: string): string {
	switch (id) {
		case "REM5": return JSON.stringify({ proposed_current: "", retired_values: [] });
		case "REM7": return JSON.stringify({ supersedes: false, retires_anything: false, supersedes_everything: false });
		case "REM8": return JSON.stringify({ target_row_ids: [] });
		case "REM1": return "keep";
		case "P4": {
			const clauses = jsonAfter(content, "Eligible clauses: ") as Array<{ origin: string }>;
			const stored = clauses.flatMap((clause, index) => clause.origin === "stored" ? [index] : []);
			return JSON.stringify({ verdict: "merge", retired_clause_indices: stored });
		}
		case "P2": return JSON.stringify({ lifecycle_retired_clause_indices: [0] });
		case "P3": return JSON.stringify({ retire: true });
		case "P6": return JSON.stringify({ retire: false });
		case "P5": {
			const retained = jsonAfter(content, "Retained clauses: ").map(String);
			return JSON.stringify({ abstract: "Editor preference.", overview: "The editor the user prefers.", content: retained.join(" ") });
		}
		default: return "{}";
	}
}

async function contractPost(path: string, body: unknown, skin: string): Promise<Response> {
	if (!sidecar) throw new Error("missing test sidecar");
	return fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
		method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: JSON.parse(readFileSync(join(process.env.SNO_PROFILE_DIR!, "station", "sidecar.json"), "utf8")).token, "x-sno-station-mem-skin": skin },
		body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
	});
}

/** Waits until the service has prepared its embedding model, so a capture runs instead of only being accepted. */
const modelReady = () => untilModelReady(async ({ scope, ...recall }) =>
	(await contractPost("/v1/get-recall", { ...recall, scope: { ...scope, principal: SEED_SCOPE.principal } }, "model-ready-probe")).json());

/** A registration is the skin and its model only; the mode comes from settings.json (REQ-4). */
async function registerHost(skinId: string, hostUrl: string): Promise<void> {
	const response = await contractPost("/v1/init", { scope: { ...SEED_SCOPE, session: skinId }, registration: {
		skinId,
		model: { baseUrl: `${hostUrl}/host/v1/`, credential: "loopback-credential", model: "loopback-model" },
	} }, skinId);
	expect(response.status).toBe(200);
}

async function store(skin: string, content: string, category: "episodic" | "profile", sectionName?: string) {
	const response = await contractPost("/v1/mutate", { scope: SEED_SCOPE, op: { op: "store", content, category,
		...(sectionName ? { metadata: { section_name: sectionName } } : {}) } }, skin);
	const body = await response.json() as { degraded?: boolean; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
	return { status: response.status, degraded: body.degraded, isError: body.result?.isError === true, text: body.result?.content?.[0]?.text };
}

/** Stores rows REM owns (transition wording), then stops the sidecar; returns their REM scope. */
async function seedRemRows(texts: string[]): Promise<string> {
	sidecar = await startRemSidecar();
	for (const text of texts) expect((await store("seed", text, "episodic")).status).toBe(200);
	await sidecar.stop();
	sidecar = undefined;
	const scopes = database.sqlite.prepare("SELECT DISTINCT project_id AS scope FROM nodix_memories").all() as Array<{ scope: string }>;
	const [only, ...others] = scopes;
	if (!only || others.length > 0) throw new Error(`expected one REM scope, found ${JSON.stringify(scopes)}`);
	return only.scope;
}

/** The daily pass is due: the last one was two days ago. */
function seedDueTriggerState(scope: string): void {
	writeFileSync(join(root, "sno-station-mem", "rem-trigger-state.json"), JSON.stringify({ version: 1, scopes: { [scope]: {
		last_pass_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), schedule_zone: "UTC", last_covered_count: 0,
		last_volume_pass_date: null, missed_window: null, attempts: { identity: null, count: 0 },
	} } }));
}

function lines(name: string): string[] {
	const path = join(root, "sno-station-mem", name);
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line.trim()) : [];
}
const audit = () => lines("audit.jsonl");
const jobIds = () => [...new Set(lines("rem-wave-jobs.jsonl").map(line => JSON.parse(line).waveId as string))];
const auditEvents = (event: string) => audit().filter(line => JSON.parse(line).event === event);

async function until(check: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end && !check()) await delay(100);
}

const TRANSITION_ROWS = ["I no longer live in Boston.", "I no longer drink coffee in the morning."];

describe("Local First background jobs never contact the Sno GPU", () => {
	it("runs group maintenance without a Sno request", { timeout: 120_000 }, async () => {
		const sno = await recorder("sno");
		pointSnoGpuAt(sno.url);
		await seedRemRows(["The deployment is waiting on the security review.", "The user prefers dark roast coffee."]);
		const rekey = database.sqlite.prepare("UPDATE nodix_memories SET category = ?, subject = ?, attribute = NULL WHERE text = ?");
		rekey.run("state", "entity:deployment", "The deployment is waiting on the security review.");
		rekey.run("profile", "user", "The user prefers dark roast coffee.");
		const run = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
			const child = spawn(join(repoRoot, "node_modules/.bin/tsx"),
				["src/engine/maintenance/run-group-crud-maintenance.ts", database.dbPath],
				{ cwd: join(repoRoot, "packages/memory"), env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", chunk => { stderr += chunk; });
			child.once("error", reject);
			child.once("close", code => done({ code, stderr }));
		});
		expect({ snoCalls: sno.calls, exitCode: run.code }, run.stderr.slice(-2000)).toEqual({ snoCalls: [], exitCode: 0 });
	});
});

describe("Local First writes never fail for lack of a model", () => {
	it("stores active tasks as open tasks, a reworded task as a second one", { timeout: 90_000 }, async () => {
		const sno = await recorder("sno");
		pointSnoGpuAt(sno.url);
		sidecar = await startRemSidecar();
		const first = await store("writer", "Draft the quarterly budget review for the finance team.", "profile", "active_tasks");
		const second = await store("writer", "Prepare the finance team's quarterly budget review draft.", "profile", "active_tasks");
		const openTasks = database.sqlite.prepare(
			"SELECT count(*) AS count FROM nodix_active_task_instances WHERE terminal_at_ms IS NULL").get() as { count: number };
		expect({ first, second, openTasks: openTasks.count, snoCalls: sno.calls }).toMatchObject({
			first: { status: 200, degraded: false, isError: false },
			second: { status: 200, degraded: false, isError: false },
			openTasks: 2, snoCalls: [],
		});
	});

	function profileSection(): string {
		const rows = database.sqlite.prepare(`SELECT text, json_extract(metadata, '$.l2_content') AS content
			FROM nodix_memories WHERE category = 'profile' AND lane = 'active'
				AND json_extract(metadata, '$.superseded_by') IS NULL`).all() as Array<{ text: string; content: string | null }>;
		return rows.map(row => `${row.text}\n${row.content ?? ""}`).join("\n");
	}

	it("merges a superseding profile write on the host and retires the stale clause", { timeout: 90_000 }, async () => {
		const host = await recorder("host");
		sidecar = await startRemSidecar();
		await registerHost("profile-skin", host.url);
		await store("profile-skin", "My preferred code editor is Vim.", "profile", "preferences.editor");
		const superseding = await store("profile-skin", "My preferred code editor is Helix.", "profile", "preferences.editor");
		const section = profileSection();
		expect({ status: superseding.status, p4Sent: host.calls.includes("P4"), stale: section.includes("Vim"), current: section.includes("Helix") })
			.toEqual({ status: 200, p4Sent: true, stale: false, current: true });
	});

	it("stores a line union and answers done when the host refuses with auth", { timeout: 90_000 }, async () => {
		const host = await recorder("host", "auth");
		sidecar = await startRemSidecar();
		await registerHost("profile-skin", host.url);
		const first = await store("profile-skin", "My preferred code editor is Vim.", "profile", "preferences.editor");
		const second = await store("profile-skin", "My preferred code editor is Helix.", "profile", "preferences.editor");
		const section = profileSection();
		expect({ first, second, p4Sent: host.calls.includes("P4"), union: section.includes("Vim") && section.includes("Helix") }).toMatchObject({
			first: { status: 200, degraded: false, isError: false },
			second: { status: 200, degraded: false, isError: false },
			p4Sent: true, union: true,
		});
	});

	it.each(["auth", "exhausted"] as const)("answers done and keeps the retirement queued when the host refuses with %s after P4 merged",
		{ timeout: 90_000 }, async refusal => {
			const host = await recorder("host", `p4-then-${refusal}`);
			sidecar = await startRemSidecar();
			await registerHost("profile-skin", host.url);
			// A second row stating the retired clause, so retirement has work beyond the section (P6).
			await store("profile-skin", "I write all my code in Vim.", "episodic");
			await store("profile-skin", "My preferred code editor is Vim.", "profile", "preferences.editor");
			const superseding = await store("profile-skin", "My preferred code editor is Helix.", "profile", "preferences.editor");
			const live = database.sqlite.prepare(`SELECT json_extract(metadata, '$.retire_by_name_pending') AS pending
				FROM nodix_memories WHERE category = 'profile' AND lane = 'active'
					AND json_extract(metadata, '$.superseded_by') IS NULL`).all() as Array<{ pending: string | null }>;
			const pending = live.flatMap(row => row.pending === null ? [] : (JSON.parse(row.pending) as { workItems: Array<{ positions: string[] }> }).workItems);
			expect({
				superseding, p4Answered: host.received.some(call => call.id === "P4" && call.answered),
				refusedAfterP4: host.received.some(call => ["P2", "P3", "P5", "P6"].includes(call.id) && !call.answered),
				current: profileSection().includes("Helix"), stale: profileSection().includes("Vim"),
				queuedRetirement: pending.some(item => item.positions.some(position => position.includes("Vim"))),
			}).toEqual({
				superseding: { status: 200, degraded: false, isError: false, text: superseding.text },
				p4Answered: true, refusedAfterP4: true, current: true, stale: false, queuedRetirement: true,
			});
		});

	// P3 (recheck) and P2 (lifecycle) run only for preferences.general, P2 only with a live specific sibling.
	it("general section: a refused P3 recheck keeps the clause and answers done", { timeout: 90_000 }, async () => {
		const host = await recorder("host", "p4-then-auth");
		sidecar = await startRemSidecar();
		await registerHost("profile-skin", host.url);
		await store("profile-skin", "My preferred code editor is Vim.", "profile", "preferences.general");
		const superseding = await store("profile-skin", "My preferred code editor is Helix.", "profile", "preferences.general");
		const section = profileSection();
		expect({ superseding, refusedP3: host.received.some(call => call.id === "P3" && !call.answered),
			kept: section.includes("Vim"), current: section.includes("Helix") }).toEqual({
			superseding: { status: 200, degraded: false, isError: false, text: superseding.text },
			refusedP3: true, kept: true, current: true,
		});
	});

	it("general section: a refused P2 after P3 confirmed answers done and keeps the lifecycle work queued", { timeout: 90_000 }, async () => {
		const host = await recorder("host", "p4-p3-then-auth");
		sidecar = await startRemSidecar();
		await registerHost("profile-skin", host.url);
		await store("profile-skin", "I use a mechanical keyboard with brown switches.", "profile", "preferences.keyboard");
		await store("profile-skin", "My preferred code editor is Vim.", "profile", "preferences.general");
		const superseding = await store("profile-skin", "My preferred code editor is Helix.", "profile", "preferences.general");
		const live = database.sqlite.prepare(`SELECT json_extract(metadata, '$.retire_by_name_pending') AS pending
			FROM nodix_memories WHERE category = 'profile' AND lane = 'active'
				AND json_extract(metadata, '$.superseded_by') IS NULL`).all() as Array<{ pending: string | null }>;
		const pending = live.flatMap(row => row.pending === null ? []
			: (JSON.parse(row.pending) as { workItems: Array<{ positions: string[]; lifecycleClassification?: unknown }> }).workItems);
		expect({ superseding, refusedP2: host.received.some(call => call.id === "P2" && !call.answered),
			queuedLifecycle: pending.some(item => item.lifecycleClassification !== undefined && item.positions.includes("My preferred code editor is Vim.")),
		}).toEqual({
			superseding: { status: 200, degraded: false, isError: false, text: superseding.text }, refusedP2: true, queuedLifecycle: true,
		});
	});
});

describe("A host refusal answers by operation (REQ-2)", () => {
	it.each(["exhausted", "auth"] as const)("stores an active task and answers done when the host refuses with %s", { timeout: 90_000 }, async refusal => {
		const host = await recorder("host", refusal);
		writeSettings({ mode: "agent-native" });
		sidecar = await startRemSidecar();
		await registerHost("refused-skin", host.url);
		const task = await store("refused-skin", "Draft the quarterly budget review for the finance team.", "profile", "active_tasks");
		const openTasks = database.sqlite.prepare(
			"SELECT count(*) AS count FROM nodix_active_task_instances WHERE terminal_at_ms IS NULL").get() as { count: number };
		expect({ task, openTasks: openTasks.count, hostCalled: host.calls.length > 0 }).toMatchObject({
			task: { status: 200, degraded: false, isError: false }, openTasks: 1, hostCalled: true,
		});
	});

	it.each(["exhausted", "auth"] as const)("answers a capture refused with %s as failed and commits nothing", { timeout: 90_000 }, async refusal => {
		const host = await recorder("host", refusal);
		writeSettings({ mode: "agent-native" });
		sidecar = await startRemSidecar();
		await modelReady();
		await registerHost("refused-skin", host.url);
		const response = await contractPost("/v1/capture", { scope: { ...SEED_SCOPE, session: "refused-skin" },
			turn: { turnId: `refused-${refusal}`, rewindEpoch: 0, messages: [
				{ role: "user", content: "I keep a blue notebook for meeting notes.", at: 1789606800000 },
			] } }, "refused-skin");
		const rows = database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get() as { count: number };
		expect({ status: response.status, body: await response.json(), hostCalled: host.calls.length > 0, rows: rows.count })
			.toEqual({ status: 503, body: { degraded: true, reason: "no-agent-endpoint" }, hostCalled: true, rows: 0 });
	});
});

describe("The model-call table alone decides whether capture uses a model (PRD Verification: table control)", () => {
	const SENTENCE = "I keep a blue notebook for meeting notes.";
	async function capture(skin: string, turnId: string): Promise<void> {
		await (await contractPost("/v1/capture", { scope: { ...SEED_SCOPE, session: skin }, turn: { turnId, rewindEpoch: 0, messages: [
			{ role: "user", content: SENTENCE, at: 1789606800000 },
		] } }, skin)).text();
	}
	const storedSentences = () => (database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories WHERE text LIKE ?")
		.get(`%${SENTENCE}%`) as { count: number }).count;

	it("under Local First, E1 set to host sends the captured conversation to the host instead of storing its sentences", { timeout: 90_000 }, async () => {
		const host = await recorder("host");
		sidecar = await startRemSidecar();
		await modelReady();
		// Control: the table as shipped (E1 off under Local First) stores the sentence and asks no model.
		await registerHost("table-as-shipped", host.url);
		await capture("table-as-shipped", "table-control-shipped");
		expect({ stored: storedSentences(), hostCalls: host.calls }).toEqual({ stored: 1, hostCalls: [] });
		database.sqlite.prepare("DELETE FROM nodix_memories").run();
		// The table is read from settings.json once per runtime open: change the E1 row, then restart.
		await sidecar.stop();
		writeSettings({ modelCalls: { E1: { "local-first": "host" } } });
		sidecar = await startRemSidecar();
		await modelReady();
		await registerHost("table-e1-host", host.url);
		await capture("table-e1-host", "table-control-e1-host");
		const extraction = host.received.filter(call => call.content.startsWith(atomicExtractionSkillReference("capture")));
		expect({ extractionReachedHost: extraction.length > 0, carriesTurn: extraction.every(call => call.content.includes(SENTENCE)),
			storedAsSentence: storedSentences() }).toEqual({ extractionReachedHost: true, carriesTurn: true, storedAsSentence: 0 });
	});
});

describe("Local First REM runs only while a host answers", () => {
	it("skips the tick with no connected registration, then a connection the same day dispatches", { timeout: 120_000 }, async () => {
		const sno = await recorder("sno");
		const host = await recorder("host");
		pointSnoGpuAt(sno.url);
		seedDueTriggerState(await seedRemRows(TRANSITION_ROWS));
		vi.stubEnv("SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS", "500");
		sidecar = await startRemSidecar();
		// Opens the memory runtime, and with it the tick, through a registration without a model callback. A read-only
		// stats request no longer starts background work, so it cannot stand in for one.
		expect((await contractPost("/v1/init", { scope: { ...SEED_SCOPE, session: "reader" }, registration: { skinId: "reader" } }, "reader")).status).toBe(200);
		await until(() => auditEvents("rem_trigger_evaluated").length > 0, 10_000);
		await delay(1_500);
		expect({
			skipLogged: audit().some(line => line.includes("skipped: no host model connected")),
			jobs: jobIds(), snoCalls: sno.calls, hostCalls: host.calls,
		}).toEqual({ skipLogged: true, jobs: [], snoCalls: [], hostCalls: [] });
		await registerHost("host-skin", host.url);
		await until(() => auditEvents("rem_completed").length > 0);
		// The 500 ms tick keeps running here, so it may dispatch the pass as well as the connection.
		expect({ dispatched: jobIds().length > 0, completed: auditEvents("rem_completed").length > 0, snoCalls: sno.calls,
			remOnHost: host.calls.some(call => call.startsWith("REM")), otherOnHost: host.calls.filter(call => !call.startsWith("REM")) })
			.toEqual({ dispatched: true, completed: true, snoCalls: [], remOnHost: true, otherOnHost: [] });
	});

	it("runs a due pass on the host as soon as a skin registers a model callback", { timeout: 120_000 }, async () => {
		const sno = await recorder("sno");
		const host = await recorder("host");
		pointSnoGpuAt(sno.url);
		seedDueTriggerState(await seedRemRows(TRANSITION_ROWS));
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		await until(() => auditEvents("rem_completed").length > 0);
		expect({ jobs: jobIds().length, completed: auditEvents("rem_completed").length, snoCalls: sno.calls,
			remOnHost: host.calls.some(call => call.startsWith("REM")), otherOnHost: host.calls.filter(call => !call.startsWith("REM")) })
			.toEqual({ jobs: 1, completed: 1, snoCalls: [], remOnHost: true, otherOnHost: [] });
	});

	/** Rows REM holds right now: an active claim or a non-released ledger owner. */
	function heldRows(): string[] {
		// A job that never reached REM's own tables claimed nothing.
		if (!database.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'nodix_rem_row_claims'").get()) return [];
		return (database.sqlite.prepare(`SELECT m.text FROM nodix_memories m
			WHERE m.id IN (SELECT row_id FROM nodix_rem_row_claims WHERE state = 'active')
				OR m.id IN (SELECT row_id FROM nodix_rem_relation_ledger WHERE owner <> 'none')`).all() as Array<{ text: string }>)
			.map(row => row.text);
	}
	/** Transition rows whose text an answered REM prompt carried, from `received[from]` on. */
	const remAnsweredRows = (host: Awaited<ReturnType<typeof recorder>>, from = 0) => TRANSITION_ROWS.filter(text =>
		host.received.slice(from).some(call => call.answered && call.id.startsWith("REM") && call.content.includes(text)));

	it("ends a pass whose host refuses mid-pass as rem_skipped and dispatches again on the next connection", { timeout: 120_000 }, async () => {
		const sno = await recorder("sno");
		const host = await recorder("host", "answer-first-rem-then-refuse");
		pointSnoGpuAt(sno.url);
		seedDueTriggerState(await seedRemRows(TRANSITION_ROWS));
		sidecar = await startRemSidecar();
		await registerHost("host-skin", host.url);
		const terminal = () => [...audit(), ...lines("rem-wave-jobs.jsonl")].some(line => line.includes("rem_skipped"))
			|| auditEvents("rem_completed").length > 0 || auditEvents("rem_failed").length > 0;
		await until(terminal);
		expect({
			skipped: [...audit(), ...lines("rem-wave-jobs.jsonl")].some(line => line.includes("rem_skipped")),
			completed: auditEvents("rem_completed").length, refusedAfterAnAnswer: host.calls.filter(call => call.startsWith("REM")).length >= 2,
			snoCalls: sno.calls,
		}).toEqual({ skipped: true, completed: 0, refusedAfterAnAnswer: true, snoCalls: [] });
		// The row whose REM call was refused must not stay claimed by the skipped job.
		const refusedRows = TRANSITION_ROWS.filter(text =>
			host.received.some(call => !call.answered && call.id.startsWith("REM") && call.content.includes(text)));
		expect({ refusedRows: refusedRows.length > 0, held: heldRows() }).toEqual({ refusedRows: true, held: [] });
		const firstJobs = jobIds();
		const reconnectAt = host.received.length;
		host.mode = "answer";
		await registerHost("host-skin", host.url);
		await until(() => jobIds().length > firstJobs.length && auditEvents("rem_completed").length > 0);
		// The next pass judges the released rows again, on the host, and completes.
		expect({ firstJobs: firstJobs.length, jobsAfterReconnect: jobIds().length, completed: auditEvents("rem_completed").length,
			rejudged: remAnsweredRows(host, reconnectAt).filter(text => refusedRows.includes(text)), held: heldRows() })
			.toEqual({ firstJobs: 1, jobsAfterReconnect: 2, completed: 1, rejudged: refusedRows, held: [] });
	});

	it("stops dispatching a pass its host keeps refusing after three tries, however often hosts connect", { timeout: 240_000 }, async () => {
		// Every hook that registers a model re-runs the due check. Before the fix each refused pass ended rem_skipped,
		// the skip cleared the attempt, and the next registration dispatched the same pass again: on a busy machine the
		// same daily pass ran fifty times in a day, each run re-embedding every row on every core.
		const sno = await recorder("sno");
		const host = await recorder("host", "exhausted");
		pointSnoGpuAt(sno.url);
		const scope = await seedRemRows(TRANSITION_ROWS);
		seedDueTriggerState(scope);
		sidecar = await startRemSidecar();
		const settled = () => lines("rem-wave-jobs.jsonl").map(line => JSON.parse(line) as { waveId: string; state: string })
			.reduce((latest, job) => latest.set(job.waveId, job.state), new Map<string, string>());
		for (let connection = 0; connection < 6; connection += 1) {
			const before = jobIds().length;
			await registerHost("host-skin", host.url);
			await until(() => jobIds().length > before, 5_000);
			await until(() => [...settled().values()].every(state => state !== "running" && state !== "queued"), 60_000);
		}
		const state = JSON.parse(readFileSync(join(root, "sno-station-mem", "rem-trigger-state.json"), "utf8")) as {
			scopes: Record<string, { last_volume_pass_date: string | null }> };
		expect({ jobs: jobIds().length, skipped: [...settled().values()].filter(job => job === "skipped").length,
			dayClosed: state.scopes[scope]?.last_volume_pass_date === new Date().toISOString().slice(0, 10), snoCalls: sno.calls })
			.toEqual({ jobs: 3, skipped: 3, dayClosed: true, snoCalls: [] });
	});

	it("refuses a manual start with no connected registration and invents no job", { timeout: 60_000 }, async () => {
		const sno = await recorder("sno");
		pointSnoGpuAt(sno.url);
		sidecar = await startRemSidecar();
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, {
			method: "POST", headers: { [REM_SIDECAR_TOKEN_HEADER]: JSON.parse(readFileSync(join(process.env.SNO_PROFILE_DIR!, "station", "sidecar.json"), "utf8")).token },
			body: JSON.stringify({ type: "rem-update", scope: "global" }), signal: AbortSignal.timeout(10_000),
		});
		const text = await response.text();
		await delay(500);
		expect({ ok: response.ok, reason: text.includes("no host model connected"), jobId: text.includes("job_id"), jobs: jobIds(), snoCalls: sno.calls })
			.toEqual({ ok: false, reason: true, jobId: false, jobs: [], snoCalls: [] });
	});

	it("ends a job recovered after a restart with no connected registration as rem_skipped", { timeout: 120_000 }, async () => {
		const sno = await recorder("sno");
		pointSnoGpuAt(sno.url);
		const scope = await seedRemRows(TRANSITION_ROWS);
		writeFileSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"), `${JSON.stringify({
			payloadVersion: 1, waveId: "recovered-wave", correlationId: "recovered-correlation", scope,
			requestedOperations: ["rem-update"], state: "running", startedAt: new Date().toISOString(), finishedAt: null,
			stats: { operations: 0 },
		})}\n`);
		sidecar = await startRemSidecar();
		const settled = () => lines("rem-wave-jobs.jsonl").map(line => JSON.parse(line) as { waveId: string; state: string })
			.some(job => job.waveId === "recovered-wave" && job.state !== "running" && job.state !== "queued");
		await until(settled);
		expect({ settled: settled(), skipped: audit().some(line => line.includes("rem_skipped") && line.includes("recovered-wave")),
			completed: auditEvents("rem_completed").length, snoCalls: sno.calls, held: heldRows() })
			.toEqual({ settled: true, skipped: true, completed: 0, snoCalls: [], held: [] });
		// Released, not lost: the first connection's pass judges both rows on the host and completes.
		const host = await recorder("host");
		seedDueTriggerState(scope);
		await registerHost("host-skin", host.url);
		await until(() => auditEvents("rem_completed").length > 0);
		expect({ completed: auditEvents("rem_completed").length, judged: remAnsweredRows(host), snoCalls: sno.calls, held: heldRows() })
			.toEqual({ completed: 1, judged: TRANSITION_ROWS, snoCalls: [], held: [] });
	});
});
