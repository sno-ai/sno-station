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
import { MODEL_CALLS, type ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { callId, modelReply, type Recorder, type RecorderReply, startRecorder } from "./fixtures/model-recorders";
import { untilModelReady } from "./fixtures/model-ready";
import { type SettingsDocument, writeSettingsFixture } from "../fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../../..");

const SEED_SCOPE = { principal: "caller", project: "global", session: "rem-enhanced-seed" };

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
		last_pass_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), schedule_zone: "UTC", last_pass_date: null, missed_window: null, attempts: { identity: null, count: 0 },
	} } }));
}


/** Labels a non-REM call by its prompt: the conflict-verdict prompts belong to P1 or E10, which share a destination. */
function nonRemCall(content: string): string {
	if (content.startsWith(atomicExtractionSkillReference("capture"))) return "E1";
	if (content.includes('{"action":"open_or_refine') || content.includes('{"result":"same_instance"')) return "T1";
	if (content.includes("name: key-state-attribute")) return "E12";
	if (content.startsWith("You are generating a durable MEMORY REFLECTION entry")) return "R1";
	const id = callId(content);
	return id;
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
		// No plugin's host is reachable from this command, so a host call is skipped; maintenance's calls all ship on
		// the agent, so no mode reaches Sno GPU.
		const labels = sno.received.map(call => nonRemCall(call.content));
		expect({ exitCode: run.code, misrouted: labels.filter(label => tableDestination(label, mode) !== "sno-gpu"),
			reachedSno: labels.length > 0 }, run.stderr.slice(-2000))
			.toEqual({ exitCode: 0, misrouted: [], reachedSno: false });
	});
});
