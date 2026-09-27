/**
 * Model readiness and service start (PRD single-settings-file changes 6 and 7; REQ-1, REQ-6, REQ-7).
 *
 * Every memory session here is its own Node process that loads the built package client
 * (`packages/memory/dist/client.js`, what `@snoai/memory/client` resolves to for the Codex and Claude
 * workers) and exits, the way a hook does; the service is whatever that client starts. The embedding
 * model is really downloaded, into an empty cache, from a loopback mirror (`embedding.mirror`) that
 * serves this machine's staged copy of the pinned revision and holds every request until released.
 * Rebuild `packages/memory` before running: the service and the client are both `dist`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_PACKAGE_PATH, type SettingsDocument, writeSettingsFixture } from "../fixtures/settings-file-fixture";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLIENT_URL = pathToFileURL(join(MEMORY_PACKAGE_PATH, "dist", "client.js")).href;
const SHIPPED = JSON.parse(readFileSync(join(MEMORY_PACKAGE_PATH, "settings.default.json"), "utf8")) as {
	embedding: { model: string; revision: string };
};
const MODEL = SHIPPED.embedding.model;
const REVISION = SHIPPED.embedding.revision;
/** This machine's staged copy of the pinned model revision; the mirror serves it byte for byte. */
const STAGED_CACHE = join(homedir(), ".cache", "sno-station", "models");
const STAGED_MODEL = join(STAGED_CACHE, MODEL, REVISION);

let root: string;
const cleanups: Array<() => Promise<void> | void> = [];
const operatorHome = process.env.HOME;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "model-readiness-"));
	// The store manifest lives under the home directory; a test home keeps it out of the operator's.
	process.env.HOME = join(root, "home");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await stopServices(root);
	rmSync(root, { recursive: true, force: true });
	if (operatorHome === undefined) delete process.env.HOME;
	else process.env.HOME = operatorHome;
});

/** Settings the way `sno` writes them, local-first so no model call leaves the machine. */
function writeSettings(profileRoot: string, overrides: SettingsDocument = {}): { path: string; settings: SettingsDocument } {
	return writeSettingsFixture(profileRoot, {
		mode: "local-first", rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { observe: { enabled: false } },
		logging: { level: "debug", file: join(profileRoot, "logs", "memory-service.log") },
		// Already staged and offline: a service that prepares its model on start needs no network here.
		embedding: { cacheDir: STAGED_CACHE, offline: true },
		...overrides,
	});
}

/**
 * A production process environment: no test switches, this test's profile root, and the test home set in
 * `beforeEach`; the staged model cache above was resolved from the operator's home when this file loaded.
 */
function sessionEnv(profileRoot: string): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!key.startsWith("VITEST") && key !== "NODE_ENV" && key !== "SNO_STATION_MEM_NODE_ENV"));
	return { ...env, SNO_PROFILE_DIR: profileRoot };
}

type SessionPlan = {
	session: string;
	capture?: string;
	/** Exit this long after sending the capture if no reply came; without it the session waits for the reply. */
	captureWaitMs?: number;
	recall?: string;
	recallWaitMs?: number;
};
type SessionOutcome = {
	connect?: unknown; connectMs?: number; init?: unknown;
	capture?: unknown; captureMs?: number; recall?: unknown; recallMs?: number;
};

/** One hook-like process: connect, register as Codex with only its id, then capture and/or recall. */
const SESSION_SCRIPT = `
import { connect } from ${JSON.stringify(CLIENT_URL)};
const plan = JSON.parse(process.env.SESSION_PLAN);
const shown = value => JSON.parse(JSON.stringify(value ?? null, (_key, item) =>
	item instanceof Error ? { name: item.name, message: item.message, ...item } : item));
const settle = (promise, waitMs) => {
	const outcome = promise.then(shown, error => ({ thrown: shown(error) }));
	return waitMs === undefined ? outcome
		: Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve({ pending: waitMs }), waitMs).unref())]);
};
const out = {};
let started = performance.now();
let client;
try { client = await connect({ skinId: "codex" }); out.connect = client.degraded ? shown(client) : { degraded: false, pid: client.pid }; }
catch (error) { out.connect = { thrown: shown(error) }; }
out.connectMs = Math.round(performance.now() - started);
if (client && !client.degraded) {
	const scope = { principal: client.principal, project: "global", session: plan.session, host: { sessionId: plan.session } };
	out.init = await settle(client.init(scope, { skinId: "codex" }));
	if (plan.capture) {
		started = performance.now();
		out.capture = await settle(client.capture({ turnId: plan.session + "-turn", rewindEpoch: 0,
			messages: [{ role: "user", content: plan.capture, at: Date.now() }] }, scope), plan.captureWaitMs);
		out.captureMs = Math.round(performance.now() - started);
	}
	if (plan.recall) {
		started = performance.now();
		out.recall = await settle(client.getRecall(plan.recall, scope, { source: "manual", minScore: 0 }), plan.recallWaitMs);
		out.recallMs = Math.round(performance.now() - started);
	}
}
process.stdout.write("\\nSESSION " + JSON.stringify(out) + "\\n");
process.exit(0);
`;

function startSession(profileRoot: string, plan: SessionPlan): { child: ChildProcess; done: Promise<SessionOutcome & { exitMs: number; output: string }> } {
	const started = performance.now();
	const child = spawn(process.execPath, ["--input-type=module", "-e", SESSION_SCRIPT], {
		cwd: REPO_ROOT, env: { ...sessionEnv(profileRoot), SESSION_PLAN: JSON.stringify(plan) }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", chunk => { output += chunk; });
	child.stderr?.on("data", chunk => { output += chunk; });
	cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	const done = once(child, "exit").then(() => {
		const line = output.split("\n").find(text => text.startsWith("SESSION "));
		const outcome: SessionOutcome = line ? JSON.parse(line.slice("SESSION ".length)) : {};
		return { ...outcome, exitMs: Math.round(performance.now() - started), output };
	});
	return { child, done };
}

/** A session that must finish on its own; killed after `limitMs` so a hung hook fails the test instead of the run. */
async function session(profileRoot: string, plan: SessionPlan, limitMs = 60_000) {
	const { child, done } = startSession(profileRoot, plan);
	const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
	try { return await done; } finally { clearTimeout(timer); }
}

/** Every memory service process started for `profileRoot`, read from /proc. */
function servicePids(profileRoot: string): number[] {
	return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
		try {
			const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (!command.some(argument => argument.endsWith("/sidecar/main.js"))) return [];
			const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			return environment.includes(`SNO_PROFILE_DIR=${profileRoot}`) ? [Number(pid)] : [];
		} catch { return []; }
	});
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopServices(profileRoot: string): Promise<void> {
	const pids = servicePids(profileRoot);
	for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	const deadline = Date.now() + 15_000;
	while (pids.some(alive) && Date.now() < deadline) await delay(200);
	for (const pid of pids.filter(alive)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function discovery(profileRoot: string): { pid: number; port: number; token: string } {
	return JSON.parse(readFileSync(join(profileRoot, "station", "sidecar.json"), "utf8"));
}

async function healthz(profileRoot: string): Promise<{ status: number; body: unknown }> {
	const record = discovery(profileRoot);
	const response = await fetch(`http://127.0.0.1:${record.port}/healthz`, {
		headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(10_000),
	});
	return { status: response.status, body: await response.json() };
}

/** The way `sno` stops the service: SIGTERM to the recorded pid, then wait for the process to exit. */
async function stopByRecordedPid(profileRoot: string): Promise<number> {
	const { pid } = discovery(profileRoot);
	process.kill(pid, "SIGTERM");
	await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 200 });
	return pid;
}

function tail(path: string, chars = 4_000): string {
	try { return readFileSync(path, "utf8").slice(-chars); } catch { return `(no ${path})`; }
}

function serviceLogs(profileRoot: string): string {
	return [join(profileRoot, "logs", "memory-service.log"), join(profileRoot, "sno-station-mem", "sidecar-startup.log")]
		.map(path => `--- ${path}\n${tail(path)}`).join("\n");
}

type ModelMirror = { url: string; requested: string[]; served: string[]; release(): void };

/** A Hugging Face-shaped mirror of the staged model files; every request waits until `release()`. */
async function startModelMirror(): Promise<ModelMirror> {
	if (!existsSync(join(STAGED_MODEL, "onnx"))) throw new Error(`no staged model at ${STAGED_MODEL}; load the embedder once on this machine`);
	const prefix = `/${MODEL}/resolve/${REVISION}/`;
	const requested: string[] = [];
	const served: string[] = [];
	const held: Array<() => void> = [];
	const sockets = new Set<Socket>();
	let released = false;
	const server: Server = createServer((request, response) => {
		const path = decodeURIComponent(new URL(request.url ?? "/", "http://mirror").pathname);
		requested.push(path);
		const serve = (): void => {
			if (response.destroyed || request.socket.destroyed) return;
			response.on("error", () => undefined);
			const file = path.startsWith(prefix) ? join(STAGED_MODEL, path.slice(prefix.length)) : "";
			if (!file || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
			response.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(file).size });
			if (request.method === "HEAD") { response.end(); return; }
			response.once("finish", () => served.push(path));
			createReadStream(file).on("error", () => response.destroy()).pipe(response);
		};
		if (released) serve(); else held.push(serve);
	});
	server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mirror has no port");
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	return {
		url: `http://127.0.0.1:${address.port}`, requested, served,
		release() { released = true; for (const serve of held.splice(0)) serve(); },
	};
}

/** Settings for a first run: an empty model cache the service must fill from `mirror`. */
function writeDownloadSettings(mirror: ModelMirror): void {
	writeSettings(root, { embedding: { cacheDir: join(root, "model-cache"), offline: false, mirror: mirror.url } });
}

const codename = (): string => `VELVET-${randomBytes(4).toString("hex").toUpperCase()}`;
const RECALL_QUESTION = "What codename did we pick for the glacier expedition?";

/** Fresh sessions ask until one reads `name` back; each recall waits at most 15 s. */
async function expectReadBack(name: string, mirror: ModelMirror): Promise<void> {
	let last: unknown;
	await vi.waitFor(async () => {
		const fresh = await session(root, { session: `fresh-${randomBytes(3).toString("hex")}`, recall: RECALL_QUESTION, recallWaitMs: 15_000 });
		last = fresh.recall ?? fresh;
		expect(JSON.stringify(last)).toContain(name);
	}, { timeout: 120_000, interval: 1_000 }).catch(error => {
		throw new Error(`no fresh session read ${name} back; last recall ${JSON.stringify(last)}; mirror served ${JSON.stringify(mirror.served)}\n${serviceLogs(root)}`, { cause: error });
	});
}

describe("an accepted write survives the model download (REQ-7)", () => {
	it("keeps a capture whose sender exits during the download, and recall during the download answers empty at once", { timeout: 300_000 }, async () => {
		const mirror = await startModelMirror();
		writeDownloadSettings(mirror);
		const name = codename();

		const sender = await session(root, { session: "first-conversation",
			capture: `We named the glacier expedition ${name}; the team leaves from the north hut.`, captureWaitMs: 3_000 });
		expect(sender.connect, `${sender.output}\n${serviceLogs(root)}`).toMatchObject({ degraded: false });
		// The rig: the service really is fetching the model, and nothing has been let through yet.
		await vi.waitFor(() => expect(mirror.requested.some(path => path.startsWith(`/${MODEL}/resolve/${REVISION}/`))).toBe(true),
			{ timeout: 30_000, interval: 200 }).catch(error => { throw new Error(`the service never fetched the model\n${serviceLogs(root)}`, { cause: error }); });
		expect(mirror.served).toEqual([]);
		expect.soft(sender.capture, "the capture reply while the model downloads").toMatchObject({ degraded: false, accepted: true });

		const early = await session(root, { session: "recall-during-download", recall: RECALL_QUESTION, recallWaitMs: 10_000 });
		expect.soft(early.recallMs ?? Number.POSITIVE_INFINITY, `recall during the download: ${JSON.stringify(early.recall)}`).toBeLessThan(5_000);
		expect.soft(early.recall, "recall during the download").toMatchObject({ contextText: "" });
		expect.soft(JSON.stringify(early.recall), "recall during the download names why it is empty").toContain("model-preparing");
		expect(mirror.served).toEqual([]);

		mirror.release();
		await expectReadBack(name, mirror);
	});

	it("keeps a capture accepted during the download when the service is stopped by its pid and started again", { timeout: 300_000 }, async () => {
		const mirror = await startModelMirror();
		writeDownloadSettings(mirror);
		const name = codename();

		// This sender stays alive and waits for its own reply: the only thing that can drop the write is the stop.
		const sender = startSession(root, { session: "first-conversation",
			capture: `We named the glacier expedition ${name}; the team leaves from the north hut.` });
		await vi.waitFor(() => expect(mirror.requested.some(path => path.startsWith(`/${MODEL}/resolve/${REVISION}/`))).toBe(true),
			{ timeout: 30_000, interval: 200 }).catch(error => { throw new Error(`the service never fetched the model\n${serviceLogs(root)}`, { cause: error }); });
		await Promise.race([sender.done, delay(30_000)]);
		if (sender.child.exitCode === null) sender.child.kill("SIGKILL");
		const sent = await sender.done;
		expect(sent.capture, `the capture reply while the model downloads\n${sent.output}`).toMatchObject({ degraded: false, accepted: true });
		const firstPid = await stopByRecordedPid(root);
		expect(mirror.served).toEqual([]);

		const restarted = await session(root, { session: "after-stop" });
		expect(restarted.connect, `${restarted.output}\n${serviceLogs(root)}`).toMatchObject({ degraded: false });
		expect(servicePids(root)).toEqual([discovery(root).pid]);
		expect(discovery(root).pid).not.toBe(firstPid);

		mirror.release();
		await expectReadBack(name, mirror);
	});
});

describe("the plugin reads the file before it starts anything (REQ-1)", () => {
	it("answers the settings error within its deadline and starts no service when the file is missing", { timeout: 120_000 }, async () => {
		const settingsPath = join(root, "settings.json");
		const hook = await session(root, { session: "no-settings" }, 30_000);
		const said = JSON.stringify(hook.connect);

		expect(hook.connectMs ?? Number.POSITIVE_INFINITY, said).toBeLessThan(5_000);
		expect(hook.exitMs, "the hook process is not held past its deadline").toBeLessThan(10_000);
		expect(said).toContain(`settings unavailable: ${settingsPath}: `);
		expect(said).toContain("; run sno setup");
		expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
		expect(servicePids(root)).toEqual([]);
	});

	it("answers the service's refusal of the file by name, reports it on /healthz, and keeps one service", { timeout: 120_000 }, async () => {
		const { path } = writeSettings(root, { store: { encryptionKey: "" } });
		const refusal = `settings unavailable: ${path}: store.encryptionKey; run sno setup`;

		const first = await session(root, { session: "refused-1", capture: "The harbor deploy runs every Tuesday morning." }, 60_000);
		const second = await session(root, { session: "refused-2", capture: "The harbor deploy runs every Tuesday morning." }, 60_000);
		for (const hook of [first, second]) {
			expect.soft(JSON.stringify([hook.connect, hook.init, hook.capture]), hook.output).toContain(refusal);
			expect.soft(hook.connectMs ?? Number.POSITIVE_INFINITY, "the refusal answers at once").toBeLessThan(10_000);
		}

		expect(existsSync(join(root, "station", "sidecar.json")), `no service was started\n${serviceLogs(root)}`).toBe(true);
		const health = await healthz(root);
		expect(health.status).toBe(503);
		expect(health.body).toMatchObject({ status: "error", error: refusal });
		expect(servicePids(root)).toEqual([discovery(root).pid]);
	});
});

describe("the one service sno installed (REQ-6)", () => {
	/**
	 * A second, different copy of `@snoai/memory` laid out as a global install:
	 * `<prefix>/node_modules/@snoai/memory` with its own `dist` and a different version, its siblings the
	 * workspace's dependencies.
	 */
	function installedCopy(): string {
		const prefix = join(root, "global", "node_modules");
		const copy = join(prefix, "@snoai", "memory");
		mkdirSync(copy, { recursive: true });
		for (const entry of readdirSync(join(REPO_ROOT, "node_modules"))) {
			if (entry === "@snoai" || entry.startsWith(".")) continue;
			symlinkSync(join(REPO_ROOT, "node_modules", entry), join(prefix, entry));
		}
		for (const entry of readdirSync(join(REPO_ROOT, "node_modules", "@snoai"))) {
			if (entry !== "memory") symlinkSync(join(REPO_ROOT, "node_modules", "@snoai", entry), join(prefix, "@snoai", entry));
		}
		for (const entry of readdirSync(MEMORY_PACKAGE_PATH)) {
			if (entry === "dist") cpSync(join(MEMORY_PACKAGE_PATH, "dist"), join(copy, "dist"), { recursive: true });
			else if (entry === "package.json") {
				const manifest = JSON.parse(readFileSync(join(MEMORY_PACKAGE_PATH, entry), "utf8"));
				writeFileSync(join(copy, entry), JSON.stringify({ ...manifest, version: `${manifest.version}-installed-copy` }, null, "\t"));
			} else symlinkSync(join(MEMORY_PACKAGE_PATH, entry), join(copy, entry));
		}
		return copy;
	}

	it("starts the memoryPackage.path service, not the skin's own dependency copy", { timeout: 180_000 }, async () => {
		const copy = installedCopy();
		const copyEntry = join(copy, "dist", "sidecar", "main.js");

		// The rig: the copy runs as a service on its own, so a red below is about which copy was started.
		const rigRoot = join(root, "rig-profile");
		writeSettings(rigRoot, { memoryPackage: { path: copy } });
		const rig = spawn(process.execPath, [copyEntry], { env: sessionEnv(rigRoot), stdio: ["ignore", "pipe", "pipe"] });
		let rigOutput = "";
		rig.stdout?.on("data", chunk => { rigOutput += chunk; });
		rig.stderr?.on("data", chunk => { rigOutput += chunk; });
		cleanups.push(async () => { await stopServices(rigRoot); if (rig.exitCode === null) rig.kill("SIGKILL"); });
		await vi.waitFor(async () => {
			expect(rig.exitCode, rigOutput).toBeNull();
			expect((await healthz(rigRoot)).status).toBe(200);
		}, { timeout: 60_000, interval: 250 });
		await stopByRecordedPid(rigRoot);

		const { settings } = writeSettings(root, { memoryPackage: { path: copy } });
		const hook = await session(root, { session: "installed-copy" });
		expect(hook.connect, `${hook.output}\n${serviceLogs(root)}`).toMatchObject({ degraded: false });

		const { pid } = discovery(root);
		const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		expect(command.slice(0, 2)).toEqual([process.execPath, copyEntry]);
		expect(servicePids(root)).toEqual([pid]);
		const health = await healthz(root);
		expect(health.status).toBe(200);
		expect(health.body).toMatchObject({ status: "ok", storePath: (settings.store as { path: string }).path });
	});
});
