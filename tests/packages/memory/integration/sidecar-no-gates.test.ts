import { chmodSync, existsSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, watch, writeFileSync, writeSync } from "node:fs";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runMaintenancePass } from "../../../../packages/memory/src/store/maintenance";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { startSidecar } from "../../../../packages/memory/src/contract/start";
import { bindStore } from "../../../../packages/memory/src/engine/shared/paths";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { readRemAutomaticOperations } from "../../../../packages/memory/src/sidecar/rem-trigger";
import { MemoryContractRuntime } from "../../../../packages/memory/src/engine/contract-runtime";
import { MemoryRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";
import { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sidecar-no-gates-"));
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	await bindStore(database.dbPath, { mode: "local-first", retrieval: { rerank: "none" } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
});
afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

async function health(authenticated = true): Promise<void> {
	sidecar = await startRemSidecar();
	const token = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token;
	const response = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
	expect(response.status).toBe(200);
	expect((await response.json()).status).toBe("ok");
}

async function contractPost(path: string, body: unknown, skin?: string): Promise<Response> {
	if (!sidecar) throw new Error("missing test sidecar");
	return fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
		method: "POST", headers: skin === undefined ? {} : { "x-sno-station-mem-skin": skin },
		body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
	});
}

function registration(mode: "local-first" | "agent-native", model?: { baseUrl: string; credential: string; model: string }) {
	const { remEnhanced, agentNative, language: _language, mode: _mode, ...settings } = pluginConfigSchema.parse({
		mode, retrieval: { rerank: "none" }, observe: { enabled: false },
	});
	return { skinId: "body-skin", settings, routing: { mode, remEnhanced, agentNative, language: "en" }, ...(model ? { model } : {}) };
}

function runCli(args: string[], entry = "cli.js"): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const cli = fileURLToPath(new URL(`../../../../packages/memory/dist/${entry}`, import.meta.url));
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), 40_000);
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

function isolatedSidecarPids(): number[] {
	return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
		try {
			const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (!command.some(argument => argument.endsWith("/sidecar/main.js"))) return [];
			const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			return environment.includes(`SNO_PROFILE_DIR=${root}`) ? [Number(pid)] : [];
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return [];
			throw error;
		}
	});
}

describe("documented HTTP runtime claims", () => {
	it("retries discovery publication while continuing to serve", async () => {
		const discoveryPath = join(root, "station", "sidecar.json");
		mkdirSync(discoveryPath);
		sidecar = await startRemSidecar();
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
		expect(response.status).toBe(200);
		expect((await response.json()).status).toBe("ok");
		expect(statSync(discoveryPath).isFile()).toBe(false);
		rmdirSync(discoveryPath);
		expect(existsSync(discoveryPath)).toBe(false);
		await vi.waitFor(() => expect(existsSync(discoveryPath)).toBe(true), { timeout: 10_000, interval: 100 });
		const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
		expect(discovery.pid === process.pid).toBe(true);
		expect(discovery.port === sidecar.port).toBe(true);
		const discovered = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
		expect(discovered.status).toBe(200);
		expect((await discovered.json()).status).toBe("ok");
	});
	it("cancels discovery publication retries on stop", async () => {
		const discoveryPath = join(root, "station", "sidecar.json");
		mkdirSync(discoveryPath);
		sidecar = await startRemSidecar();
		await sidecar.stop();
		sidecar = undefined;
		rmdirSync(discoveryPath);
		await delay(5_500);
		expect(existsSync(discoveryPath)).toBe(false);
	});
	it.each([undefined, "   "])("selects the default skin for header %j", async skin => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const url = `http://127.0.0.1:${sidecar.port}/v1/init`;
		// fetch trims header values before sending; use node:http to send actual spaces.
		const response = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
			const request = httpRequest(url, {
				method: "POST", headers: skin === undefined ? {} : { "x-sno-station-mem-skin": skin },
			}, incoming => {
				let body = "";
				incoming.on("data", chunk => { body += chunk; });
				incoming.once("error", reject);
				incoming.once("end", () => { try { resolve({ status: incoming.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
			});
			request.setTimeout(5_000, () => request.destroy(new Error("header request timed out")));
			request.once("error", reject);
			request.end(JSON.stringify({ scope: { principal: "caller", project: "global", session: "default-skin" }, registration: registration("local-first") }));
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ degraded: false, skinId: "default" });
	});
	it("serves HTTP inspection before any init using installed settings", async () => {
		await health();
		const response = await contractPost("/v1/inspect", {
			scope: { principal: "caller", project: "global", session: "before-init" }, op: { op: "list" },
		}, "codex");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
	});
	it("initializes from installed settings without changing complete registration", async () => {
		await health();
		const scope = { principal: "caller", project: "global", session: "inherited-init" };
		const inherited = await contractPost("/v1/init", {
			scope, registration: { skinId: "body-skin", inheritInstalled: true },
		}, "hermes");
		expect(inherited.status).toBe(200);
		expect(await inherited.json()).toMatchObject({ degraded: false, skinId: "hermes" });

		const captured = await contractPost("/v1/capture", { scope,
			turn: { turnId: "inherited-init", rewindEpoch: 0, messages: [
				{ role: "user", content: "The launch color is cobalt blue.", at: 1789606800000 },
				{ role: "assistant", content: "I will remember the cobalt launch color.", at: 1789606801000 },
			] },
		}, "hermes");
		expect(captured.status).toBe(200);
		expect(await captured.json()).toMatchObject({ degraded: false, committed: true });

		const mixed = await contractPost("/v1/init", {
			scope, registration: { skinId: "body-skin", inheritInstalled: true, settings: {}, routing: {} },
		}, "hermes");
		expect(mixed.status).toBe(400);
		expect(await mixed.json()).toEqual({ degraded: true, reason: "invalid-input" });

		const complete = await contractPost("/v1/init", {
			scope, registration: registration("local-first"),
		}, "existing-client");
		expect(complete.status).toBe(200);
		expect(await complete.json()).toMatchObject({ degraded: false, skinId: "existing-client" });
	});
	it("returns a degraded reason when the agent model endpoint is absent", async () => {
		await health();
		const scope = { principal: "caller", project: "global", session: "missing-model" };
		expect((await contractPost("/v1/init", { scope, registration: registration("agent-native") })).status).toBe(200);
		const response = await contractPost("/v1/capture", { scope,
			turn: { turnId: "missing-model", rewindEpoch: 0, messages: [{ role: "user", content: "I keep a blue notebook.", at: 1789606800000 }] },
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ degraded: true, reason: "no-agent-endpoint" });
	});
	it("returns a tool refusal inside HTTP 200", async () => {
		await health();
		const response = await contractPost("/v1/mutate", {
			scope: { principal: "caller", project: "global", session: "refused" },
			op: { op: "update", id: "missing-memory", importance: 0.42 },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, result: {
			content: [{ type: "text", text: "Memory entry not found: missing-memory" }], details: {}, isError: true,
		} });
	});
	it("returns an HTTP error body for an unknown route", async () => {
		await health();
		const response = await contractPost("/v1/not-a-route", {});
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});
	it.each([
		{ kind: "error", category: "exhausted", message: "x" },
		{ kind: "cancelled", reason: "x" },
	])("sends the host model HTTP contract and relays $kind", async failure => {
		const requests: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: unknown }> = [];
		const host = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: failure }));
		});
		await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
		try {
			const address = host.address();
			if (!address || typeof address === "string") throw new Error("missing host model port");
			await health();
			const scope = { principal: "caller", project: "global", session: "host-model" };
			const initialized = await contractPost("/v1/init", { scope, registration: registration("agent-native", {
				baseUrl: `http://127.0.0.1:${address.port}/host/v1/`, credential: "loopback-credential", model: "loopback-model",
			}) });
			expect(initialized.status).toBe(200);
			const response = await contractPost("/v1/capture", { scope,
				turn: { turnId: "host-model", rewindEpoch: 0, messages: [{ role: "user", content: "I keep a blue notebook.", at: 1789606800000 }] },
			});
			expect(response.status).toBe(failure.kind === "error" ? 503 : 504);
			expect(await response.json()).toEqual({ degraded: true, reason: failure.kind === "error" ? "no-agent-endpoint" : "timeout" });
			expect(requests.length).toBeGreaterThan(0);
			for (const request of requests) {
				expect(request).toMatchObject({ method: "POST", path: "/host/v1/chat/completions", authorization: "Bearer loopback-credential" });
				const body = z.object({ model: z.string(), stream: z.boolean(), messages: z.array(z.strictObject({ role: z.string(), content: z.string() })) }).parse(request.body);
				expect(body).toMatchObject({ model: "loopback-model", stream: false });
				expect(body.messages.map(message => message.role)).toEqual(["system", "user"]);
				for (const message of body.messages) {
					expect(Object.keys(message).sort()).toEqual(["content", "role"]);
					expect(message.content).toMatch(/\S/);
				}
			}
		} finally { host.closeAllConnections(); await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve())); }
	});
	it("starts the CLI and reuses the live discovery pid", async () => {
		const discoveryPath = join(root, "station", "sidecar.json");
		expect(existsSync(discoveryPath)).toBe(false);
		try {
			const first = await runCli(["sidecar", "start"]);
			expect(first.code, first.stderr).toBe(0);
			expect(first.stdout).toMatch(/^Memory sidecar ready: pid=[1-9]\d* port=[1-9]\d*\n$/);
			const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
			expect(first.stdout).toBe(`Memory sidecar ready: pid=${discovery.pid} port=${discovery.port}\n`);
			const healthResponse = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, {
				headers: { Authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(5_000),
			});
			expect(healthResponse.status).toBe(200);
			expect(await healthResponse.json()).toMatchObject({ status: "ok", storePath: database.dbPath });
			const second = await runCli(["sidecar", "start"]);
			expect(second.code, second.stderr).toBe(0);
			expect(second.stdout).toBe(first.stdout);
			expect(JSON.parse(readFileSync(discoveryPath, "utf8")).pid).toBe(discovery.pid);
		} finally {
			if (existsSync(discoveryPath)) {
				const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
				process.kill(discovery.pid, "SIGTERM");
				await vi.waitFor(() => expect(existsSync(discoveryPath)).toBe(false), { timeout: 10_000 });
			}
		}
	});
	it.each(["missing", "dead", "stale socket"])("converges concurrent CLI starts with %s discovery", async state => {
		const discoveryPath = join(root, "station", "sidecar.json");
		if (state === "dead") {
			const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
			await once(exited, "close");
			writeFileSync(discoveryPath, JSON.stringify({ pid: exited.pid, port: 1, token: "a".repeat(64) }));
		} else expect(existsSync(discoveryPath)).toBe(false);
		if (state === "stale socket") {
			const holder = spawn(process.execPath, ["-e", `
				const server = require("node:net").createServer();
				server.listen(process.argv[1], () => process.send("bound"));
			`, join(root, "station", "sidecar.sock")], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
			try {
				const [message] = await once(holder, "message", { signal: AbortSignal.timeout(5_000) });
				expect(message).toBe("bound");
			} finally {
				const closed = once(holder, "close");
				holder.kill("SIGKILL");
				await closed;
			}
			expect(statSync(join(root, "station", "sidecar.sock")).isSocket()).toBe(true);
		}
		try {
			const [first, second] = await Promise.all([runCli(["sidecar", "start"]), runCli(["sidecar", "start"])]);
			expect(first.code, first.stderr).toBe(0);
			expect(second.code, second.stderr).toBe(0);
			expect(first.stdout === second.stdout).toBe(true);
			expect(first.stdout).toMatch(/^Memory sidecar ready: pid=[1-9]\d* port=[1-9]\d*\n$/);
			const discovery = z.object({ pid: z.number(), port: z.number() }).parse(JSON.parse(readFileSync(discoveryPath, "utf8")));
			expect(first.stdout === `Memory sidecar ready: pid=${discovery.pid} port=${discovery.port}\n`).toBe(true);
			await vi.waitFor(() => expect(isolatedSidecarPids().length).toBe(1), { timeout: 5_000 });
			const pids = isolatedSidecarPids();
			expect(pids.length).toBe(1);
			expect(pids.includes(discovery.pid)).toBe(true);
			const listeners = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).trim().split("\n")
				.filter(line => pids.some(pid => line.includes(`pid=${pid},`)));
			expect(listeners.length).toBe(1);
			expect(listeners.some(line => line.includes(`127.0.0.1:${discovery.port} `))).toBe(true);
			expect((await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) })).status).toBe(200);
			expect(statSync(join(root, "station", "sidecar.sock")).isSocket()).toBe(true);
			const socket = createConnection(join(root, "station", "sidecar.sock"));
			try {
				await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
				expect(socket.readyState).toBe("open");
			} finally { socket.destroy(); }
		} finally {
			const pids = isolatedSidecarPids();
			for (const pid of pids) process.kill(pid, "SIGTERM");
			await vi.waitFor(() => expect(isolatedSidecarPids().length).toBe(0), { timeout: 10_000 });
		}
	});
	it("exits a duplicate sidecar entry without changing discovery or the store", async () => {
		const discoveryPath = join(root, "station", "sidecar.json");
		try {
			const first = await runCli(["sidecar", "start"]);
			expect(first.code, first.stderr).toBe(0);
			const original = readFileSync(discoveryPath, "utf8");
			const discovery = z.object({ pid: z.number(), port: z.number() }).parse(JSON.parse(original));
			const storeBefore = readFileSync(database.dbPath);
			const socketBefore = statSync(join(root, "station", "sidecar.sock"));
			const second = await runCli([], "sidecar/main.js");
			expect(second.code, second.stderr).toBe(0);
			const lines = (second.stdout + second.stderr).split("\n").filter(line => line.includes("sidecar.duplicate.exit"));
			expect(lines.length).toBe(1);
			const record = z.object({ severity_text: z.string(), event_name: z.string(), attributes: z.object({ pid: z.number() }) })
				.parse(JSON.parse(lines[0] ?? "null"));
			expect(record.severity_text).toBe("INFO");
			expect(record.event_name).toBe("sidecar.duplicate.exit");
			expect(record.attributes.pid === discovery.pid).toBe(true);
			expect(readFileSync(discoveryPath, "utf8") === original).toBe(true);
			expect(readFileSync(database.dbPath).equals(storeBefore)).toBe(true);
			expect(statSync(join(root, "station", "sidecar.sock")).ino === socketBefore.ino).toBe(true);
			expect(isolatedSidecarPids().length).toBe(1);
			expect(isolatedSidecarPids().includes(discovery.pid)).toBe(true);
			const listeners = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).trim().split("\n")
				.filter(line => line.includes(`pid=${discovery.pid},`));
			expect(listeners.length).toBe(1);
			expect((await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) })).status).toBe(200);
		} finally {
			for (const pid of isolatedSidecarPids()) process.kill(pid, "SIGTERM");
			await vi.waitFor(() => expect(isolatedSidecarPids().length).toBe(0), { timeout: 10_000 });
			expect(existsSync(join(root, "station", "sidecar.sock"))).toBe(false);
		}
	});
	it.each([
		{ outcome: "recovers", readyAfter: 750 },
		{ outcome: "times out", readyAfter: -1 },
	])("waits for a live discovery pid that $outcome without spawning or rewriting discovery", async ({ readyAfter }) => {
		const child = spawn(process.execPath, ["-e", `
			const { createServer } = require("node:http");
			let ready = false, started = false;
			const server = createServer((request, response) => {
				if (!started && ${readyAfter} >= 0) {
					started = true;
					setTimeout(() => { ready = true; }, ${readyAfter});
				}
				response.writeHead(ready && request.url === "/healthz" ? 200 : 503, { "content-type": "application/json" });
				response.end(JSON.stringify({ status: ready ? "ok" : "starting" }));
			});
			server.listen(0, "127.0.0.1", () => process.send({ pid: process.pid, port: server.address().port }));
		`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
		let watcher: ReturnType<typeof watch> | undefined;
		try {
			const [message] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
			const address = z.object({ pid: z.number().int().positive(), port: z.number().int().positive() }).parse(message);
			const discoveryPath = join(root, "station", "sidecar.json");
			const original = JSON.stringify({ ...address, token: "a".repeat(64) });
			writeFileSync(discoveryPath, original);
			let rewrites = 0;
			watcher = watch(join(root, "station"), (_event, filename) => { if (filename === "sidecar.json") rewrites++; });
			const started = Date.now();
			if (readyAfter >= 0) {
				const discovery = await startSidecar();
				expect(discovery.pid).toBe(address.pid);
				expect(discovery.port).toBe(address.port);
				expect(discovery.token).toBe("a".repeat(64));
				expect(Date.now() - started).toBeGreaterThanOrEqual(750);
				const response = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ status: "ok" });
			} else {
				await expect(startSidecar()).rejects.toMatchObject({ reason: "sidecar-unresponsive" });
				expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
				expect(Date.now() - started).toBeLessThan(35_000);
			}
			await delay(50);
			expect(rewrites).toBe(0);
			expect(readFileSync(discoveryPath, "utf8")).toBe(original);
			expect(existsSync(join(root, "sno-station-mem", "sidecar-startup.log"))).toBe(false);
			expect(() => process.kill(address.pid, 0)).not.toThrow();
		} finally {
			watcher?.close();
			const closed = once(child, "close");
			child.kill("SIGTERM");
			await closed;
		}
	}, 45_000);
	it("exits 0 and removes discovery after SIGTERM to the CLI-started sidecar", async () => {
		const discoveryPath = join(root, "station", "sidecar.json");
		const exitProbe = join(root, "record-exit.cjs");
		// The detached sidecar is not our child; observe its exit without changing shutdown.
		writeFileSync(exitProbe, `process.on("exit", code => require("node:fs").writeFileSync(${JSON.stringify(root)} + "/" + process.pid + ".exit", String(code)));`);
		vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(exitProbe)}`);
		let pid: number | undefined;
		try {
			const started = await runCli(["sidecar", "start"]);
			expect(started.code, started.stderr).toBe(0);
			const discovery = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(readFileSync(discoveryPath, "utf8")));
			pid = discovery.pid;
			process.kill(pid, "SIGTERM");
			await vi.waitFor(() => expect(() => process.kill(discovery.pid, 0)).toThrowError(/ESRCH/), { timeout: 10_000 });
			pid = undefined;
			expect(readFileSync(join(root, `${discovery.pid}.exit`), "utf8")).toBe("0");
			expect(existsSync(join(root, "station", "sidecar.sock"))).toBe(false);
			expect(existsSync(discoveryPath)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			if (pid !== undefined) {
				try { process.kill(pid, "SIGTERM"); }
				catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
			}
		}
	});
	it("rejects an extra CLI argument with usage and exit 2", async () => {
		expect(await runCli(["sidecar", "start", "extra"])).toEqual({ code: 2, stdout: "",
			stderr: "Usage: sno-station-mem bind <path> | sidecar start\n" });
		expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
	});
});

describe("sidecar keeps serving", () => {
	it("restores the installed REM tick default after the pool closes", async () => {
		const configPath = join(root, "station", `sno-station-mem-${userInfo().username}.config.json`);
		const installed = JSON.parse(readFileSync(configPath, "utf8"));
		delete installed.remEnhanced;
		writeFileSync(configPath, JSON.stringify(installed));
		const pool = await MemoryRuntimePool.open();
		const { mode, remEnhanced, agentNative, language: _language, ...settings } = pool.config;
		try {
			const result = await pool.invoke("init", {
				scope: { principal: userInfo().username, project: "global", session: "tick-close" },
				registration: { skinId: "tick-close", settings, routing: { mode, agentNative, language: "en",
					remEnhanced: { occasions: remEnhanced.occasions, trigger: { tick: false } } } },
			}, "tick-close");
			expect(result).toMatchObject({ degraded: false });
			expect(readRemAutomaticOperations(configPath).tickEnabled).toBe(false);
		} finally {
			await pool.close();
		}
		expect(readRemAutomaticOperations(configPath).tickEnabled).toBe(true);
	});
	it("rejects inherited registration when the installation config cannot be read", async () => {
		const configPath = join(root, "station", `sno-station-mem-${userInfo().username}.config.json`);
		const original = readFileSync(configPath);
		writeFileSync(configPath, "{");
		const pool = await MemoryRuntimePool.open();
		try {
			await expect(pool.invoke("init", {
				scope: { principal: userInfo().username, project: "global", session: "inherited-missing-config" },
				registration: { skinId: "hermes", inheritInstalled: true },
			}, "hermes")).rejects.toThrow("memory.installation.config.unavailable");
		} finally {
			await pool.close();
			writeFileSync(configPath, original);
		}
	});
	it("rejects inherited registration when the installation config is not mode 0600", async () => {
		const configPath = join(root, "station", `sno-station-mem-${userInfo().username}.config.json`);
		chmodSync(configPath, 0o644);
		const pool = await MemoryRuntimePool.open();
		try {
			await expect(pool.invoke("init", {
				scope: { principal: userInfo().username, project: "global", session: "inherited-open-mode" },
				registration: { skinId: "hermes", inheritInstalled: true },
			}, "hermes")).rejects.toThrow("memory.installation.config.unavailable");
		} finally {
			await pool.close();
			chmodSync(configPath, 0o600);
		}
	});
	it("reads the REM tick switch across HTTP skin registrations", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const url = `http://127.0.0.1:${sidecar.port}/v1/init`;
		const configPath = join(root, "station", `sno-station-mem-${userInfo().username}.config.json`);
		const installed = JSON.parse(readFileSync(configPath, "utf8"));
		delete installed.remEnhanced;
		writeFileSync(configPath, JSON.stringify(installed));
		const { mode, remEnhanced, agentNative, language: _language, ...settings } = pluginConfigSchema.parse({ mode: "local-first", retrieval: { rerank: "none" } });
		const register = async (skinId: string, tick?: boolean): Promise<void> => {
			const response = await fetch(url, {
				method: "POST", headers: { "x-sno-station-mem-skin": skinId },
				body: JSON.stringify({ scope: { principal: userInfo().username, project: "global", session: "tick-switch" },
					registration: { skinId, settings, routing: { mode, agentNative, language: "en",
						remEnhanced: { occasions: remEnhanced.occasions, ...(tick === undefined ? {} : { trigger: { tick } }) } } } }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ degraded: false });
		};
		await register("a", false);
		expect(readRemAutomaticOperations(configPath).tickEnabled).toBe(false);
		await register("b");
		expect(readRemAutomaticOperations(configPath).tickEnabled).toBe(false);
		await register("a", true);
		expect(readRemAutomaticOperations(configPath).tickEnabled).toBe(true);
	});
	it("runs accepted delayed REM starts when shutdown overlaps body reading", async () => {
		vi.stubEnv("SNO_STATION_MEM_REM_TEST_HOLD_MS", "200");
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const url = `http://127.0.0.1:${sidecar.port}/rem/run`;
			const accepted = await fetch(url, { method: "POST", headers: { Connection: "close" }, body: JSON.stringify({ type: "rem-update", scope: "queued" }) });
			expect(accepted.status).toBe(202);
			await accepted.json();
			const request = httpRequest(url, { method: "POST", headers: { Connection: "close" } });
			const response = new Promise<number>((resolve, reject) => {
				request.on("error", reject);
				request.on("response", incoming => { incoming.resume(); incoming.on("end", () => resolve(incoming.statusCode ?? 0)); });
			});
			request.write('{"type":"rem-update",');
			await delay(20);
			expect(readFileSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"), "utf8")
				.trim().split("\n").map(line => JSON.parse(line).state)).toEqual(["queued"]);
			const started = performance.now();
			const stopped = sidecar.stop();
			request.end('"scope":"reading"}');
			expect(await response).toBe(202);
			await stopped;
			sidecar = undefined;
			expect(performance.now() - started).toBeLessThan(5_000);
			const jobs = readFileSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"), "utf8")
				.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
			expect(jobs.filter(job => job.state === "done").map(job => ({ scope: job.scope, state: job.state })).sort((a, b) => a.scope.localeCompare(b.scope))).toEqual([
				{ scope: "queued", state: "done" }, { scope: "reading", state: "done" },
			]);
		} finally { vi.unstubAllEnvs(); }
	});

	it("serves without a bearer token", () => health(false));
	it.each(["/v1/inspect", "/rem/run"])("rejects oversized request bodies at %s", async (route) => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}${route}`, { method: "POST",
			body: JSON.stringify({ scope: { principal: userInfo().username, project: "global", session: "x".repeat(8 * 1024 * 1024) }, op: { op: "list" } }),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload_too_large" });
		expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get()).toEqual({ count: 0 });
		expect((await fetch(`http://127.0.0.1:${sidecar.port}/healthz`)).status).toBe(200);
	});
	it("accepts a memory body of exactly eight MiB", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const body = JSON.stringify({ scope: { principal: userInfo().username, project: "global", session: "limit" }, op: { op: "list" } });
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body: body.padEnd(8 * 1024 * 1024, " ") });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
	});
	it("rejects invalid REM requests without allocating jobs", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		for (const [body, error] of [
			[{}, "invalid_request"], [{ type: "rem-update", scope: " " }, "invalid_request"],
			[{ types: [], scope: "global" }, "invalid_request"],
			[{ type: "typo", scope: "global" }, "unsupported_rem_type"],
		] as const) {
			const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST", body: JSON.stringify(body) });
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(error === "unsupported_rem_type" ? { error, unknownTypes: ["typo"] } : { error });
		}
		const journal = join(root, "sno-station-mem", "rem-wave-jobs.jsonl");
		expect(existsSync(journal)).toBe(false);
	});
	it("rejects mixed REM types without allocating jobs", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST",
			body: JSON.stringify({ types: ["typo", "rem-update", "old-operation"], scope: "global" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unsupported_rem_type", unknownTypes: ["typo", "old-operation"] });
		expect(existsSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"))).toBe(false);
	});
	it.each(["capture", "mutate"] as const)("retains timed-out %s until the paused write settles before closing storage", async method => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const events: string[] = [];
		const embedChunks = Embedder.prototype.embedChunks;
		const close = MemoryRuntimePool.prototype.close;
		const embedding = vi.spyOn(Embedder.prototype, "embedChunks").mockImplementationOnce(async function (texts) {
			entered.resolve();
			await release.promise;
			try { return await embedChunks.call(this, texts); }
			finally { events.push("embedding settled"); }
		});
		const closing = vi.spyOn(MemoryRuntimePool.prototype, "close").mockImplementation(async function () {
			events.push("store closing");
			try { await close.call(this); }
			finally { closed.resolve(); }
		});
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const scope = { principal: "caller", project: "global", session: "paused-write" };
			await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body: JSON.stringify({ scope, op: { op: "list" } }) });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const body = method === "capture"
				? { scope, turn: { turnId: "paused-write", rewindEpoch: 0, messages: [{ role: "user", content: "I keep a violet notebook.", at: 1789606800000 }] } }
				: { scope, op: { op: "store", content: "I keep a violet notebook.", category: "episodic" } };
			const request = fetch(`http://127.0.0.1:${sidecar.port}/v1/${method}`, { method: "POST", body: JSON.stringify(body) });
			await entered.promise;
			await vi.advanceTimersByTimeAsync(900_000);
			vi.useRealTimers();
			const response = await request;
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ degraded: true, reason: "timeout" });
			const stopping = sidecar.stop();
			sidecar = undefined;
			expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
				bound = setTimeout(() => resolve("still running"), 6_000);
			})])).toBe("stopped");
			expect(events).toEqual([]);
			release.resolve();
			await closed.promise;
			expect(events).toEqual(["embedding settled", "store closing"]);
			expect(database.sqlite.prepare("SELECT text FROM nodix_memories").all()).toEqual([]);
		} finally {
			vi.useRealTimers();
			clearTimeout(bound);
			release.resolve();
			await sidecar?.stop();
			sidecar = undefined;
			await closed.promise;
			embedding.mockRestore();
			closing.mockRestore();
		}
	}, 30_000);
	it("cancels session-end generation before any reflection file or memory write", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let aborted = false;
		const generation = vi.spyOn(RegisteredAgentPort.prototype, "complete").mockImplementationOnce(async request => {
			request.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			entered.resolve();
			await release.promise;
			return { kind: "ok", text: "## Lessons\nKeep clear notebook records." };
		});
		const pool = await MemoryRuntimePool.open();
		const controller = new AbortController();
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Keep clear notebook records." } }));
		const scope = { principal: "caller", project: "global", session: "agent:probe:session",
			host: { workspace: root, boundary: "new", sessionFile, sessionId: "session-end" } };
		const config = pluginConfigSchema.parse({ ...pool.config, mode: "agent-native", sessionStrategy: "memoryReflection" });
		const { mode, remEnhanced, agentNative, language: _language, ...settings } = config;
		let result: Promise<unknown> | undefined;
		try {
			await pool.invoke("init", { scope, registration: { skinId: "session-end", settings,
				routing: { mode, remEnhanced, agentNative, language: "en" } } }, "session-end");
			result = pool.invoke("onSessionEnd", { scope, messages: [] }, "session-end", controller.signal).catch(error => error);
			await entered.promise;
			controller.abort(new Error("session cancelled"));
			release.resolve();
			expect(await result).toEqual(new Error("session cancelled"));
			expect(aborted).toBe(true);
			expect(existsSync(join(root, "memory"))).toBe(false);
			expect(database.sqlite.prepare("SELECT text FROM nodix_memories").all()).toEqual([]);
		} finally {
			release.resolve();
			await result;
			generation.mockRestore();
			await pool.close();
		}
	});
	it("keeps a completed capture write and skips the next write after cancellation", async () => {
		const pool = await MemoryRuntimePool.open();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const embedChunks = Embedder.prototype.embedChunks;
		const embedding = vi.spyOn(Embedder.prototype, "embedChunks").mockImplementation(async function (texts) {
			if (texts.some(text => text.includes("violet"))) {
				entered.resolve();
				await release.promise;
			}
			return embedChunks.call(this, texts);
		});
		const lines: string[] = [];
		const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
		const result = pool.invoke("capture", {
			scope: { principal: "caller", project: "global", session: "partial-capture" },
			turn: { turnId: "partial-capture", rewindEpoch: 0, messages: [
				{ role: "user", content: "I keep a green notebook.", at: 1789606800000 },
				{ role: "user", content: "I keep a violet notebook.", at: 1789606800001 },
			] },
		}, "partial-capture", controller.signal).catch(error => error);
		try {
			await entered.promise;
			controller.abort(new Error("capture cancelled"));
			release.resolve();
			expect(await result).toEqual(new Error("capture cancelled"));
			expect(database.sqlite.prepare("SELECT text FROM nodix_memories").all())
				.toEqual([{ text: "I keep a green notebook." }]);
			expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memory_chunks").get()).toEqual({ count: 1 });
			const records = lines.flatMap(line => line.trim().split("\n")).filter(Boolean).map(line => JSON.parse(line));
			expect(records.filter(record => record.event_name === "memory.operation.aborted").map(record => record.attributes))
				.toEqual([{ method: "capture", outcome: "aborted", writes: 5 }]);
		} finally {
			release.resolve();
			await result;
			embedding.mockRestore();
			output.mockRestore();
			await pool.close();
		}
	});
	it("finishes a started memory transaction when cancellation arrives inside its write", async () => {
		const pool = await MemoryRuntimePool.open();
		const controller = new AbortController();
		const prepare = pool.store.sqlite.prepare.bind(pool.store.sqlite);
		const preparing = vi.spyOn(pool.store.sqlite, "prepare").mockImplementation(sql => {
			const statement = prepare(sql);
			if (sql.includes("INSERT INTO nodix_memories(")) {
				const run = statement.run.bind(statement);
				statement.run = (...params: unknown[]): unknown => {
					statement.run = run;
					const result = run(...params);
					controller.abort(new Error("transaction cancelled"));
					return result;
				};
			}
			return statement;
		});
		try {
			const result = await pool.invoke("mutate", {
				scope: { principal: "caller", project: "global", session: "atomic-cancel" },
				op: { op: "store", content: "A complete notebook record.", category: "episodic" },
			}, "atomic-cancel", controller.signal).catch(error => error);
			expect(result).toEqual(new Error("transaction cancelled"));
			expect(database.sqlite.prepare("SELECT text FROM nodix_memories").all())
				.toEqual([{ text: "A complete notebook record." }]);
			expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memory_chunks").get()).toEqual({ count: 1 });
			expect(database.sqlite.prepare("SELECT count(*) AS count FROM nodix_rem_census_rows").get()).toEqual({ count: 1 });
		} finally {
			preparing.mockRestore();
			await pool.close();
		}
	});
	it("times out a never resolving runtime call, serves another request, and stops", async () => {
		const closed = Promise.withResolvers<void>();
		const close = MemoryRuntimePool.prototype.close;
		const closing = vi.spyOn(MemoryRuntimePool.prototype, "close").mockImplementation(async function () {
			try { await close.call(this); } finally { closed.resolve(); }
		});
		const blocked = Promise.withResolvers<never>();
		const inspection = vi.spyOn(MemoryContractRuntime.prototype, "inspect")
			.mockImplementationOnce(() => blocked.promise);
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const body = JSON.stringify({ scope: { principal: "caller", project: "global", session: "deadline" }, op: { op: "list" } });
			const response = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body });
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ degraded: true, reason: "timeout" });
			const later = await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body });
			expect(later.status).toBe(200);
			expect(await later.json()).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
			const stopping = sidecar.stop();
			sidecar = undefined;
			expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
				bound = setTimeout(() => resolve("still running"), 6_000);
			})])).toBe("stopped");
			expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
		} finally {
			clearTimeout(bound);
			blocked.reject(new Error("inspection released"));
			inspection.mockRestore();
			await closed.promise;
			closing.mockRestore();
		}
	}, 45_000);
	it("bounds shutdown while a runtime call is still before its deadline", async () => {
		const closed = Promise.withResolvers<void>();
		const close = MemoryRuntimePool.prototype.close;
		const closing = vi.spyOn(MemoryRuntimePool.prototype, "close").mockImplementation(async function () {
			try { await close.call(this); } finally { closed.resolve(); }
		});
		const entered = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<never>();
		const inspection = vi.spyOn(MemoryContractRuntime.prototype, "inspect").mockImplementationOnce(() => {
			entered.resolve();
			return blocked.promise;
		});
		const controller = new AbortController();
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const request = fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", signal: controller.signal,
				body: JSON.stringify({ scope: { principal: "caller", project: "global", session: "shutdown" }, op: { op: "list" } }),
			}).catch(() => undefined);
			await entered.promise;
			const stopping = sidecar.stop();
			sidecar = undefined;
			expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
				bound = setTimeout(() => resolve("still running"), 6_000);
			})])).toBe("stopped");
			expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
			controller.abort();
			await request;
		} finally {
			controller.abort();
			clearTimeout(bound);
			blocked.reject(new Error("inspection released"));
			inspection.mockRestore();
			await closed.promise;
			closing.mockRestore();
		}
	}, 12_000);
	it.each([
		{ source: "manual" },
		{ source: "manual", aggregation: { operation: "count", terms: ["notebook"] } },
	])("aborts retrieval at the HTTP deadline for %j", async options => {
		const entered = Promise.withResolvers<void>();
		let aborted = false;
		const blocked = Promise.withResolvers<[]>();
		const retrieval = vi.spyOn(MemoryRetriever.prototype, "retrieve").mockImplementationOnce(context => {
			context.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			entered.resolve();
			return blocked.promise;
		});
		try {
			await health();
			if (!sidecar) throw new Error("missing test sidecar");
			const scope = { principal: "caller", project: "global", session: "abort" };
			await fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", body: JSON.stringify({ scope, op: { op: "list" } }) });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const request = fetch(`http://127.0.0.1:${sidecar.port}/v1/get-recall`, { method: "POST",
				body: JSON.stringify({ scope, query: "What notebook records do you remember?", options }),
			});
			await entered.promise;
			await vi.advanceTimersByTimeAsync(120_000);
			vi.useRealTimers();
			const response = await request;
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ degraded: true, reason: "timeout" });
			expect(aborted).toBe(true);
		} finally {
			vi.useRealTimers();
			blocked.resolve([]);
			retrieval.mockRestore();
		}
	});
	it("passes cancellation through automatic recall", async () => {
		const pool = await MemoryRuntimePool.open();
		const registered = registration("local-first");
		await pool.invoke("init", {
			scope: { principal: "caller", project: "global", session: "auto-abort" },
			registration: { ...registered, skinId: "auto-abort",
				settings: { ...registered.settings, autoRecall: true, ambientLearning: false } },
		}, "auto-abort");
		const entered = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<[]>();
		const controller = new AbortController();
		let aborted = false;
		const retrieval = vi.spyOn(MemoryRetriever.prototype, "retrieve").mockImplementationOnce(context => {
			context.signal?.addEventListener("abort", () => { aborted = true; blocked.resolve([]); }, { once: true });
			entered.resolve();
			return blocked.promise;
		});
		const result = pool.invoke("getRecall", {
			scope: { principal: "caller", project: "global", session: "auto-abort" },
			query: "What notebook records do you remember?", options: { source: "auto" },
		}, "auto-abort", controller.signal).catch(error => error);
		try {
			await entered.promise;
			controller.abort(new Error("test cancelled"));
			expect(aborted).toBe(true);
			expect((await result).message).toBe("test cancelled");
		} finally {
			blocked.resolve([]);
			await result;
			retrieval.mockRestore();
			await pool.close();
		}
	});
	it("keeps same-turn recall omission across a re-registration mid-turn (issue #231)", async () => {
		const pool = await MemoryRuntimePool.open();
		const registered = registration("local-first");
		const scope = { principal: "caller", project: "global", session: "reregister-mid-turn" };
		const init = () => pool.invoke("init", { scope, registration: { ...registered, skinId: "reregister",
			settings: { ...registered.settings, autoRecall: true, ambientLearning: false } } }, "reregister");
		try {
			await init();
			await pool.invoke("mutate", { scope, op: { op: "store", content: "I keep a violet notebook for field notes.", category: "episodic" } }, "reregister");
			const auto = await pool.invoke("getRecall", { scope, query: "Which notebook do I keep?", options: { source: "auto" } }, "reregister");
			expect(auto).toMatchObject({ degraded: false });
			expect((auto as { memoryIds: string[] }).memoryIds.length).toBeGreaterThan(0);
			// The skin re-registers before its next memory call, inside the same agent turn.
			await init();
			const manual = await pool.invoke("getRecall", { scope, query: "Which notebook do I keep?", options: { source: "manual" } }, "reregister");
			const details = (manual as { toolResult: { details: Record<string, unknown> } }).toolResult.details;
			expect(details.already_served_count).toBeGreaterThan(0);
		} finally {
			await pool.close();
		}
	});
	it("skips automatic recall when disabled by registration", async () => {
		const pool = await MemoryRuntimePool.open();
		const registered = registration("local-first");
		const scope = { principal: "caller", project: "global", session: "auto-disabled" };
		const retrieval = vi.spyOn(MemoryRetriever.prototype, "retrieve").mockResolvedValue([]);
		try {
			await pool.invoke("init", { scope, registration: { ...registered, skinId: "auto-disabled",
				settings: { ...registered.settings, autoRecall: false, ambientLearning: false } } }, "auto-disabled");
			const result = await pool.invoke("getRecall", {
				scope, query: "What notebook records do you remember?", options: { source: "auto" },
			}, "auto-disabled");
			expect(retrieval).toHaveBeenCalledTimes(0);
			expect(result).toMatchObject({ degraded: false, contextText: "" });
		} finally {
			retrieval.mockRestore();
			await pool.close();
		}
	});
	it("answers an unfinished memory request at its route deadline and keeps serving", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const request = httpRequest(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = new Promise<{ status: number; body: unknown }>((resolve) => {
			request.on("response", response => {
				let text = "";
				response.on("data", chunk => { text += chunk; });
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
			});
			request.on("error", () => resolve({ status: 0, body: null }));
			timer = setTimeout(() => resolve({ status: 0, body: "no response" }), 33_000);
		});
		request.write('{"scope":');
		try {
			expect(await result).toEqual({ status: 504, body: { degraded: true, reason: "timeout" } });
			expect((await fetch(`http://127.0.0.1:${sidecar.port}/healthz`)).status).toBe(200);
		} finally { clearTimeout(timer); request.destroy(); }
	}, 40_000);
	it("retries an outstanding database setup step on maintenance until it succeeds", async () => {
		database.sqlite.exec("DROP INDEX IF EXISTS nodix_idx_memories_project_fact_key_active; CREATE TABLE nodix_idx_memories_project_fact_key_active (blocked TEXT)");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		const deps = { store, dbPath: database.dbPath, stateDir: root, backupDir: join(root, "backups") };
		try {
			runMaintenancePass(deps, new Set());
			expect(store.sqlite.prepare("SELECT type FROM sqlite_master WHERE name = 'nodix_idx_memories_project_fact_key_active'").get()).toEqual({ type: "table" });
			store.sqlite.exec("DROP TABLE nodix_idx_memories_project_fact_key_active");
			runMaintenancePass(deps, new Set());
			expect(store.sqlite.prepare("SELECT type FROM sqlite_master WHERE name = 'nodix_idx_memories_project_fact_key_active'").get()).toEqual({ type: "index" });
		} finally { await store.close(); }
	});
	it("retries a failed migration and serves the missing table after repair", async () => {
		database.sqlite.exec("DROP TABLE nodix_todos; DELETE FROM __drizzle_migrations WHERE created_at = 1740000000033");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		const deps = { store, dbPath: database.dbPath, stateDir: root, backupDir: join(root, "backups") };
		const query = { projectIdFilter: ["global"], includeHistory: false, limit: 5 };
		try {
			expect(() => store.listTodos(query)).toThrow("no such table: nodix_todos");
			runMaintenancePass(deps, new Set());
			expect(() => store.listTodos(query)).toThrow("no such table: nodix_todos");
			store.sqlite.exec("DROP TABLE nodix_todo_migration_receipts");
			runMaintenancePass(deps, new Set());
			expect(store.listTodos(query)).toEqual({ items: [], totalCount: 0 });
			expect(store.sqlite.prepare("SELECT migration_id, before_count, after_count FROM nodix_todo_migration_receipts").all())
				.toEqual([{ migration_id: "0033_todo_own_store", before_count: 0, after_count: 0 }]);
		} finally { await store.close(); }
	});
	it("starts with an unreadable audit path", async () => {
		mkdirSync(join(root, "sno-station-mem", "audit.jsonl"));
		await health();
	});
	it("starts with an audit log larger than the JavaScript string limit", async () => {
		const audit = join(root, "sno-station-mem", "audit.jsonl");
		const descriptor = openSync(audit, "w");
		const line = `${JSON.stringify({ event: "probe", padding: "x".repeat(65500) })}\n`;
		try { for (let index = 0; index < 17200; index++) writeSync(descriptor, line); }
		finally { closeSync(descriptor); }
		expect(statSync(audit).size).toBeGreaterThan(1125716658);
		await health();
	});
	it("keeps keyword recall during a vector mismatch and retries vectors on reopen", async () => {
		const embedder = await createTestEmbedder();
		const first = new MemoryStore({ dbPath: database.dbPath, embedder });
		try { await first.store({ text: "First vector dimension marker.", category: "episodic", projectId: "dimension-probe" }); }
		finally { await first.close(); }
		const reopened = new MemoryStore({ dbPath: database.dbPath, vectorDim: 3, embedder });
		try {
			expect(await reopened.searchSemantic(new Float32Array(3), { projectIdFilter: ["dimension-probe"] })).toEqual([]);
			expect((await reopened.searchKeyword("marker", { projectIdFilter: ["dimension-probe"] })).map(hit => hit.entry.text))
				.toEqual(["First vector dimension marker."]);
		} finally { await reopened.close(); }
		const recovered = new MemoryStore({ dbPath: database.dbPath, embedder });
		try {
			const vector = await embedder.embed("First vector dimension marker.");
			expect((await recovered.searchSemantic(vector, { projectIdFilter: ["dimension-probe"], minScore: 0 })).map(hit => hit.entry.text))
				.toEqual(["First vector dimension marker."]);
		} finally { await recovered.close(); }
	});
	it("loads and writes while an obsolete parent FTS table remains", async () => {
		database.sqlite.exec("CREATE TABLE nodix_memories_fts (unused TEXT)");
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
		try {
			await store.store({ text: "The current store still accepts writes.", category: "episodic", projectId: "schema-probe" });
			expect(store.sqlite.prepare("SELECT text FROM nodix_memories WHERE project_id = 'schema-probe'").all())
				.toEqual([{ text: "The current store still accepts writes." }]);
		} finally { await store.close(); }
	});
	it("starts with an invalid job journal and still serves", async () => {
		writeFileSync(join(root, "sno-station-mem", "rem-wave-jobs.jsonl"), "{broken}\n");
		await health();
	});
	it("serves a bound store without the installation config file", async () => {
		rmSync(join(root, "station", `sno-station-mem-${userInfo().username}.config.json`));
		const pool = await MemoryRuntimePool.open();
		try {
			expect(await pool.invoke("inspect", { scope: { principal: "caller", project: "global", session: "probe" }, op: { op: "stats" } }, "new-skin"))
				.toEqual({ degraded: false, result: { op: "stats", total: 0, projectBreakdown: {}, categoryBreakdown: {} } });
		} finally { await pool.close(); }
	});
	it("uses installed embedding settings when a registration names another model and store", async () => {
		const config = pluginConfigSchema.parse({ mode: "local-first", retrieval: { rerank: "none" }, dbPath: "/unused/requested.sqlite", embedding: { model: "not-installed", dimensions: 3 } });
		const { mode, remEnhanced, agentNative, language: _language, ...settings } = config;
		const pool = await MemoryRuntimePool.open();
		try {
			expect(await pool.invoke("init", { scope: { principal: userInfo().username, project: "global", session: "probe" },
				registration: { skinId: "header-skin", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "header-skin"))
				.toMatchObject({ degraded: false, skinId: "header-skin" });
			expect(await pool.invoke("inspect", { scope: { principal: userInfo().username, project: "global", session: "probe" }, op: { op: "list" } }, "header-skin"))
				.toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
		} finally { await pool.close(); }
	});
	it("runs REM without enable artifacts or operational configuration", async () => {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		const response = await fetch(`http://127.0.0.1:${sidecar.port}/rem/run`, { method: "POST", headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` }, body: JSON.stringify({ type: "rem-update", scope: "global" }) });
		expect(response.status).toBe(202);
		const started = await response.json();
		let job: { state?: string; stats?: { operations: number }; error?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			job = await (await fetch(`http://127.0.0.1:${sidecar.port}/rem/jobs/${started.job_id}`, { headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")).token}` } })).json();
			if (job.state === "done" || job.state === "failed") break;
			await delay(100);
		}
		expect(job).toMatchObject({ state: "done", stats: { operations: 0 } });
	});
	it("serves an unregistered skin with installed settings", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const result = await pool.invoke("inspect", {
				scope: { principal: userInfo().username, project: "global", session: "probe" },
				op: { op: "list", limit: 5 },
			}, "fresh-skin");
			expect(result).toEqual({ degraded: false, result: { op: "list", project: "global", entries: [] } });
		} finally { await pool.close(); }
	});
	it("stores an explicitly requested category without write-authority admission", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			await pool.invoke("mutate", { scope: { principal: userInfo().username, project: "global", session: "category-probe" },
				op: { op: "store", content: "Use a notebook for clear records.", category: "lesson", metadata: { anti_pattern_signature: "notebook-record" } } }, "category-probe");
			expect(pool.store.sqlite.prepare("SELECT text, category FROM nodix_memories WHERE project_id = 'global'").all())
				.toEqual([{ text: "Use a notebook for clear records.", category: "lesson" }]);
		} finally { await pool.close(); }
	});
	it("updates time and an explicitly addressed row without operator or scope admission", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const row = await pool.store.store({ text: "An editable notebook record.", category: "episodic", projectId: "global" });
			const scope = { principal: userInfo().username, project: "global", session: "update-probe" };
			await pool.invoke("mutate", { scope, op: { op: "update", id: row.id, timestamp: 1789606000000 } }, "update-probe");
			expect(pool.store.sqlite.prepare("SELECT timestamp FROM nodix_memories WHERE id = ?").get(row.id))
				.toEqual({ timestamp: 1789606000000 });
			await pool.invoke("mutate", { scope: { ...scope, project: "other-project" }, op: { op: "update", id: row.id, importance: 0.42 } }, "update-probe");
			expect(pool.store.sqlite.prepare("SELECT importance FROM nodix_memories WHERE id = ?").get(row.id))
				.toEqual({ importance: 0.42 });
		} finally { await pool.close(); }
	});
	it("serves native recall without host workspace registration", async () => {
		const pool = await MemoryRuntimePool.open();
		try {
			const { mode, remEnhanced, agentNative, language: _language, ...settings } = pool.config;
			const scope = { principal: userInfo().username, project: "global", session: "native-probe" };
			await pool.invoke("init", { scope, registration: { skinId: "native-probe", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "native-probe");
			await pool.store.store({ text: "Native notebook marker.", category: "episodic", projectId: "global" });
			expect(await pool.invoke("getRecall", { scope, query: "Native notebook marker.", options: { source: "native", limit: 5, minScore: 0 } }, "native-probe"))
				.toMatchObject({ degraded: false, nativeHits: [{ snippet: "Native notebook marker." }] });
		} finally { await pool.close(); }
	});
	it("ignores a persisted kill switch when capturing a turn", async () => {
		writeFileSync(join(root, "sno-station-mem", "killswitch"), JSON.stringify({ reason: "integrity failure", activatedBy: "maintenance", activated: "2026-09-17T01:37:54Z" }));
		const pool = await MemoryRuntimePool.open();
		try {
			const { mode, remEnhanced, agentNative, language: _language, ...settings } = pool.config;
			const scope = { principal: userInfo().username, project: "global", session: "agent:probe:session" };
			await pool.invoke("init", { scope, registration: { skinId: "capture-probe", settings, routing: { mode, remEnhanced, agentNative, language: "en" } } }, "capture-probe");
			const result = await pool.invoke("capture", { scope,
				turn: { turnId: "capture-probe", rewindEpoch: 0, messages: [{ role: "user", content: "I keep a blue notebook.", at: 1789606800000 }] },
			}, "capture-probe");
			expect(result).toMatchObject({ degraded: false, committed: true });
			expect(pool.store.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories").get()).toEqual({ count: 1 });
		} finally { await pool.close(); }
	});
});

it("holds the socket through a discovery publication after the shutdown bound", async () => {
	const filesystem = (await import("node:fs/promises")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const { DuplicateSidecarError } = await import("../../../../packages/memory/src/sidecar/server");
	const discoveryPath = join(root, "station", "sidecar.json");
	const socketPath = join(root, "station", "sidecar.sock");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const rename = filesystem.rename;
	let pauseNext = true;
	let stopping: Promise<void> | undefined;
	let stopped = false;
	mkdirSync(discoveryPath);
	sidecar = await startRemSidecar();
	const publication = vi.spyOn(filesystem, "rename").mockImplementation(async (source, destination) => {
		if (destination === discoveryPath && pauseNext) {
			pauseNext = false;
			entered.resolve();
			await release.promise;
		}
		await rename(source, destination);
	});
	syncBuiltinESMExports();
	try {
		rmdirSync(discoveryPath);
		await entered.promise;
		stopping = sidecar.stop().then(() => { stopped = true; });
		sidecar = undefined;
		await delay(5_500);
		const contender = await startRemSidecar().then(async running => {
			await running.stop();
			return "started";
		}, error => {
			if (!(error instanceof DuplicateSidecarError)) throw error;
			return "duplicate";
		});
		expect(contender).toBe("duplicate");
		expect(stopped).toBe(false);
		const socket = createConnection(socketPath);
		try {
			await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
			expect(socket.readyState).toBe("open");
		} finally { socket.destroy(); }
		release.resolve();
		await stopping;
		expect(existsSync(socketPath)).toBe(false);
		expect(existsSync(discoveryPath)).toBe(false);
		sidecar = await startRemSidecar();
		const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
		expect(discovery.pid === process.pid).toBe(true);
		expect(discovery.port === sidecar.port).toBe(true);
		const response = await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { signal: AbortSignal.timeout(5_000) });
		expect(response.status).toBe(200);
		expect((await response.json()).status).toBe("ok");
		expect(JSON.parse(readFileSync(discoveryPath, "utf8")).token === discovery.token).toBe(true);
		writeFileSync(discoveryPath, JSON.stringify({ pid: 424242, port: 42424, token: "foreign-owner" }));
		await sidecar.stop();
		sidecar = undefined;
		expect(JSON.parse(readFileSync(discoveryPath, "utf8")))
			.toEqual({ pid: 424242, port: 42424, token: "foreign-owner" });
	} finally {
		release.resolve();
		await stopping;
		publication.mockRestore();
		syncBuiltinESMExports();
	}
}, 25_000);

it("excludes jobs accepted before recovery finishes from the startup snapshot", async () => {
	const filesystem = (await import("node:fs/promises")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const journalPath = join(root, "sno-station-mem", "rem-wave-jobs.jsonl");
	const discoveryPath = join(root, "station", "sidecar.json");
	writeFileSync(journalPath, `${JSON.stringify({
		payloadVersion: 1, waveId: "interrupted-wave", correlationId: "interrupted-correlation",
		scope: "global", requestedOperations: ["rem-update"], state: "queued",
		startedAt: null, finishedAt: null, stats: { operations: 7 },
	})}\n`);
	const previousHold = process.env.SNO_STATION_MEM_REM_TEST_HOLD_MS;
	process.env.SNO_STATION_MEM_REM_TEST_HOLD_MS = "300";
	const rename = filesystem.rename;
	let accepted: { status: number; job_id: string } | undefined;
	// Schedule a real HTTP request in the listen-to-publication window; retain the real rename.
	const publication = vi.spyOn(filesystem, "rename").mockImplementation(async (source, destination) => {
		if (destination === discoveryPath) {
			const discovery = JSON.parse(readFileSync(source, "utf8"));
			const response = await fetch(`http://127.0.0.1:${discovery.port}/rem/run`, {
				method: "POST", body: JSON.stringify({ type: "rem-update", scope: "global" }),
				signal: AbortSignal.timeout(5_000),
			});
			accepted = { status: response.status, job_id: (await response.json()).job_id };
		}
		await rename(source, destination);
	});
	syncBuiltinESMExports();
	try {
		sidecar = await startRemSidecar();
		expect(accepted?.status).toBe(202);
		if (!accepted) throw new Error("missing accepted job");
		const jobId = accepted.job_id;
		const terminalRecords = () => readFileSync(journalPath, "utf8").trim().split("\n")
			.filter(line => line.trim()).map(line => JSON.parse(line))
			.filter(job => job.state === "done" || job.state === "failed");
		await vi.waitFor(() => {
			expect(terminalRecords().filter(job => job.waveId === "interrupted-wave"))
				.toMatchObject([{ state: "failed", error: "sidecar_restart", stats: { operations: 7 } }]);
			expect(terminalRecords().filter(job => job.waveId === jobId).length).toBe(1);
		}, { timeout: 10_000, interval: 20 });
		await sidecar.stop();
		sidecar = undefined;
		const newRecords = terminalRecords().filter(job => job.waveId === jobId);
		expect(newRecords).toMatchObject([{ state: "done", stats: { operations: 0 } }]);
		expect(newRecords.map(job => job.error ?? null)).toEqual([null]);
	} finally {
		publication.mockRestore();
		syncBuiltinESMExports();
		if (previousHold === undefined) delete process.env.SNO_STATION_MEM_REM_TEST_HOLD_MS;
		else process.env.SNO_STATION_MEM_REM_TEST_HOLD_MS = previousHold;
	}
}, 20_000);

it("holds the socket after shutdown times out until the runtime task settles", async () => {
	const entered = Promise.withResolvers<void>();
	const blocked = Promise.withResolvers<never>();
	const closed = Promise.withResolvers<void>();
	const close = MemoryRuntimePool.prototype.close;
	const closing = vi.spyOn(MemoryRuntimePool.prototype, "close").mockImplementation(async function () {
		try { await close.call(this); } finally { closed.resolve(); }
	});
	const inspection = vi.spyOn(MemoryContractRuntime.prototype, "inspect").mockImplementationOnce(() => {
		entered.resolve();
		return blocked.promise;
	});
	const socketPath = join(root, "station", "sidecar.sock");
	const controller = new AbortController();
	let request: Promise<Response | undefined> | undefined;
	let bound: ReturnType<typeof setTimeout> | undefined;
	let contender: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
	try {
		await health();
		if (!sidecar) throw new Error("missing test sidecar");
		request = fetch(`http://127.0.0.1:${sidecar.port}/v1/inspect`, { method: "POST", signal: controller.signal,
			body: JSON.stringify({ scope: { principal: "caller", project: "global", session: "shutdown-guard" }, op: { op: "list" } }),
		}).catch(() => undefined);
		await entered.promise;
		const stopping = sidecar.stop();
		sidecar = undefined;
		expect(await Promise.race([stopping.then(() => "stopped"), new Promise(resolve => {
			bound = setTimeout(() => resolve("still running"), 6_000);
		})])).toBe("stopped");
		const storeBefore = readFileSync(database.dbPath);
		await expect(startRemSidecar().then(running => { contender = running; })).rejects.toThrow();
		expect(readFileSync(database.dbPath).equals(storeBefore)).toBe(true);
		expect(existsSync(join(root, "station", "sidecar.json"))).toBe(false);
		const socket = createConnection(socketPath);
		try {
			await once(socket, "connect", { signal: AbortSignal.timeout(5_000) });
			expect(socket.readyState).toBe("open");
		} finally { socket.destroy(); }
		blocked.reject(new Error("inspection released"));
		await closed.promise;
		await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false), { timeout: 5_000 });
		await health();
		await sidecar?.stop();
		sidecar = undefined;
		expect(existsSync(socketPath)).toBe(false);
	} finally {
		clearTimeout(bound);
		controller.abort();
		blocked.reject(new Error("inspection released"));
		await request;
		await contender?.stop();
		await closed.promise;
		inspection.mockRestore();
		closing.mockRestore();
	}
}, 15_000);

async function startRecallAccount(rows: number, autoRecall = true): Promise<void> {
	const store = new MemoryStore({ dbPath: database.dbPath, embedder: await createTestEmbedder() });
	try {
		for (let index = 0; index < rows; index++) {
			await store.store({
				text: (`Notebook record ${index}: The archive holds the expedition route and supply notes. ` +
					(rows > 2 ? "The notebook describes the route, water supplies, camp equipment and weather observations. ".repeat(18) : "")),
				category: "episodic", projectId: "global", importance: 0.8,
			});
		}
	} finally { await store.close(); }
	await health();
	const registered = registration("local-first");
	const response = await contractPost("/v1/init", {
		scope: { principal: "caller", project: "global", session: "recall-account" },
		registration: { ...registered, settings: { ...registered.settings,
			autoRecall, autoRecallMinRepeated: 0, autoRecallTimeoutMs: 30_000,
			retrieval: { ...registered.settings.retrieval, mode: "vector", rerank: "none",
				minScore: 0, hardMinScore: 0, recallTopK: 1 },
		} },
	});
	expect(response.status).toBe(200);
}

async function recallAccount(source: "auto" | "manual", session = "recall-account", query = "What route and supplies does the expedition notebook describe?") {
	const response = await contractPost("/v1/get-recall", {
		scope: { principal: "caller", project: "global", session }, query,
		options: { source, minScore: 0 },
	});
	expect(response.status).toBe(200);
	return response.json();
}

describe("manual recall turn account over HTTP", () => {
	it("preserves same-turn omission when the runtime is initialized again", async () => {
		await startRecallAccount(2);
		const registered = registration("local-first");
		const repeatedRegistration = { ...registered, settings: { ...registered.settings,
			autoRecall: true, autoRecallMinRepeated: 0, autoRecallTimeoutMs: 30_000,
			retrieval: { ...registered.settings.retrieval, mode: "vector" as const, rerank: "none" as const,
				minScore: 0, hardMinScore: 0, recallTopK: 1 },
		} };
		const config = { ...repeatedRegistration.settings, ...repeatedRegistration.routing };
		const embedder = await createTestEmbedder();
		const store = new MemoryStore({ dbPath: database.dbPath, embedder });
		const accessTracker = new AccessTracker({ store });
		const observability = new PluginObservability(config, root);
		const runtime = new MemoryContractRuntime({ store, embedder, accessTracker, observability,
			retriever: new MemoryRetriever(store, embedder, console, config.retrieval),
			stateDir: root, logger: console });
		const scope = { principal: "caller", project: "global", session: "recall-reregistration" };
		const query = "What route and supplies does the expedition notebook describe?";
		try {
			await runtime.init(scope, repeatedRegistration);
			const automatic = await runtime.getRecall(query, scope, { source: "auto", minScore: 0 });
			expect(automatic.memoryIds).toHaveLength(1);
			await runtime.init(scope, repeatedRegistration);
			const manual = await runtime.getRecall(query, scope, { source: "manual", minScore: 0 });
			expect(manual.toolResult?.details.already_served_count).toBe(1);
			expect(manual.toolResult?.details.memories).toHaveLength(1);
		} finally {
			await runtime.close();
			await accessTracker.destroy();
			await observability.shutdown();
			await store.close();
		}
	});

	it("logs a hashed session reference for manual recall", async () => {
		await startRecallAccount(1, false);
		const previousLogLevel = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = "info";
		const lines: string[] = [];
		const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { lines.push(String(chunk)); return true; });
		try {
			const response = await contractPost("/v1/get-recall", {
				scope: { principal: "caller", project: "global", session: "recall-log",
					host: { sessionKey: "agent:main:recall-log" } },
				query: "What route and supplies does the expedition notebook describe?",
				options: { source: "manual", minScore: 0 },
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ degraded: false, toolResult: { details: { count: 1 } } });
			const records = lines.flatMap(line => line.trim().split("\n")).map(line => JSON.parse(line));
			const completed = records.filter(record => record.event_name === "memory.recall.completed");
			expect(completed).toHaveLength(1);
			expect(completed[0].context.session_reference.visibility).toBe("hashed");
		} finally {
			output.mockRestore();
			if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = previousLogLevel;
		}
	});
	it("shares the account when auto recall has a UUID and manual recall has only the session key", async () => {
		await startRecallAccount(2);
		const scope = { principal: "caller", project: "global", session: "agent:main:recall-account" };
		const query = "What route and supplies does the expedition notebook describe?";
		const automaticResponse = await contractPost("/v1/get-recall", {
			scope: { ...scope, host: { sessionKey: scope.session, sessionId: "5548ef70-0a75-4e45-9412-3564a0d53993" } },
			query, options: { source: "auto", minScore: 0 },
		});
		expect(automaticResponse.status).toBe(200);
		const automatic = await automaticResponse.json();
		expect(automatic.memoryIds).toHaveLength(1);
		const manualResponse = await contractPost("/v1/get-recall", {
			scope: { ...scope, host: { sessionKey: scope.session } }, query, options: { source: "manual", minScore: 0 },
		});
		expect(manualResponse.status).toBe(200);
		const manual = await manualResponse.json();
		expect(manual.toolResult.details.already_served_count).toBe(1);
		expect(manual.toolResult.details.memories).toHaveLength(1);
		expect(manual.toolResult.details.memories.filter((row: { id: string }) => automatic.memoryIds.includes(row.id))).toEqual([]);
	});

	it("omits auto recall rows when manual recall has no host workspace", async () => {
		await startRecallAccount(2);
		const scope = { principal: "caller", project: root, readable: ["global"], session: "agent:main:recall-account" };
		const registered = registration("local-first");
		const initialized = await contractPost("/v1/init", {
			scope, registration: { ...registered, settings: { ...registered.settings,
				provider: { userId: "01900000-0000-7000-8000-000000000001" },
				autoRecall: true, autoRecallMinRepeated: 0, autoRecallTimeoutMs: 30_000,
				retrieval: { ...registered.settings.retrieval, mode: "vector", rerank: "none",
					minScore: 0, hardMinScore: 0, recallTopK: 1 },
			} },
		});
		expect(initialized.status).toBe(200);
		const query = "What route and supplies does the expedition notebook describe?";
		const automaticResponse = await contractPost("/v1/get-recall", {
			scope: { ...scope, host: { sessionKey: scope.session, workspace: root } },
			query, options: { source: "auto", minScore: 0 },
		});
		expect(automaticResponse.status).toBe(200);
		const automatic = await automaticResponse.json();
		expect(automatic.memoryIds).toHaveLength(1);
		const manualResponse = await contractPost("/v1/get-recall", {
			scope: { ...scope, host: { sessionKey: scope.session } }, query, options: { source: "manual", minScore: 0 },
		});
		expect(manualResponse.status).toBe(200);
		const manual = await manualResponse.json();
		expect(manual.toolResult.details.already_served_count).toBe(1);
		expect(manual.toolResult.details.memories).toHaveLength(1);
		expect(manual.toolResult.details.memories.filter((row: { id: string }) => automatic.memoryIds.includes(row.id))).toEqual([]);
	});

	it("keeps different scope sessions separate when host session keys are blank and UUIDs are absent", async () => {
		await startRecallAccount(2);
		const scope = { principal: "caller", project: "global", session: "agent:main:K1",
			host: { sessionKey: "   " } };
		const query = "What route and supplies does the expedition notebook describe?";
		const automaticResponse = await contractPost("/v1/get-recall", {
			scope, query, options: { source: "auto", minScore: 0 },
		});
		expect(automaticResponse.status).toBe(200);
		const automatic = await automaticResponse.json();
		expect(automatic.memoryIds).toHaveLength(1);
		const manualResponse = await contractPost("/v1/get-recall", {
			scope: { ...scope, session: "agent:main:K2" }, query, options: { source: "manual", minScore: 0 },
		});
		expect(manualResponse.status).toBe(200);
		const manual = await manualResponse.json();
		expect(manual.toolResult.details.already_served_count).toBeUndefined();
		expect(manual.toolResult.details.memories).toHaveLength(2);
		expect(manual.toolResult.details.memories.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(automatic.memoryIds));
	});

	it("accounts an empty or whitespace host session key under scope.session before the session UUID", async () => {
		await startRecallAccount(2, false);
		const query = "What route and supplies does the expedition notebook describe?";
		const scope = { principal: "caller", project: "global", session: "empty-key",
			host: { sessionKey: "", sessionId: "5548ef70-0a75-4e45-9412-3564a0d53993" } };
		const automatic = await contractPost("/v1/get-recall", {
			scope, query, options: { source: "auto", minScore: 0 },
		});
		expect(automatic.status).toBe(200);
		expect((await automatic.json()).contextText).toBe("");
		const first = await contractPost("/v1/get-recall", {
			scope, query, options: { source: "manual", minScore: 0 },
		});
		expect(first.status).toBe(200);
		expect((await first.json()).toolResult.details).toMatchObject({ count: 2, already_served_count: 0 });
		for (const sessionKey of ["", "   ", scope.session]) {
			const repeated = await contractPost("/v1/get-recall", {
				scope: { ...scope, host: { ...scope.host, sessionKey } },
				query, options: { source: "manual", minScore: 0 },
			});
			expect(repeated.status).toBe(200);
			expect((await repeated.json()).toolResult.details).toMatchObject({ count: 0, memories: [], already_served_count: 2 });
		}
	});

	it("omits auto and tool rows in the same turn, but serves them in a new session and turn", async () => {
		await startRecallAccount(2);
		const automatic = await recallAccount("auto");
		expect(automatic.memoryIds).toHaveLength(1);
		const first = await recallAccount("manual");
		expect(first.toolResult.details.already_served_count).toBe(1);
		expect(first.toolResult.details.memories).toHaveLength(1);
		expect(first.toolResult.details.memories.filter((row: { id: string }) => automatic.memoryIds.includes(row.id))).toEqual([]);
		expect(first.contextText).toContain("1 memories already shown in this turn were omitted.");
		const second = await recallAccount("manual", "recall-account", "What observations are recorded in the expedition notebook?");
		expect(second.toolResult.details.already_served_count).toBe(2);
		expect(second.toolResult.details.memories).toEqual([]);
		expect(second.toolResult.details.budget_used).toBe(0);
		expect(second.contextText).toContain("2 memories already shown in this turn were omitted.");
		const fresh = await recallAccount("manual", "recall-fresh-session");
		expect(fresh.toolResult.details.already_served_count).toBeUndefined();
		expect(fresh.toolResult.details.memories).toHaveLength(2);
		expect(fresh.contextText).not.toContain("memories already shown in this turn were omitted.");
		await recallAccount("auto");
		const nextTurn = await recallAccount("manual");
		expect(nextTurn.toolResult.details.already_served_count).toBe(1);
		expect(nextTurn.toolResult.details.memories).toHaveLength(1);
	});

	it("starts a fresh manual account on each prompt turn with auto recall disabled", async () => {
		await startRecallAccount(2, false);
		for (let turn = 0; turn < 2; turn++) {
			const automatic = await recallAccount("auto");
			expect(automatic.contextText).toBe("");
			const manual = await recallAccount("manual");
			expect(manual.toolResult.details.already_served_count).toBe(0);
			expect(manual.toolResult.details.memories).toHaveLength(2);
			expect(manual.contextText).toContain("The archive holds the expedition route and supply notes.");
		}
	});

	it("does not omit manual recall without a prompt turn", { timeout: 300_000 }, async () => {
		await startRecallAccount(30);
		for (let call = 0; call < 3; call++) {
			const response = await contractPost("/v1/get-recall", {
				scope: { principal: "caller", project: "global", session: "recall-account" },
				query: "What route and supplies does the expedition notebook describe?",
				options: { source: "manual", minScore: 0, tokenBudget: 20_000 },
			});
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result.toolResult.details.already_served_count).toBeUndefined();
			expect(result.toolResult.details.memories).toHaveLength(30);
			expect(result.contextText).toContain("The archive holds the expedition route and supply notes.");
		}
	});

	it("does not mark rows when manual recall is cancelled during metadata writes", { timeout: 300_000 }, async () => {
		await startRecallAccount(30, false);
		const pool = await MemoryRuntimePool.open();
		const scope = { principal: "caller", project: "global", session: "manual-abort" };
		const registered = registration("local-first");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const updateMetadata = pool.store.updateMetadata.bind(pool.store);
		const updating = vi.spyOn(pool.store, "updateMetadata").mockImplementationOnce(async (...args) => {
			const result = await updateMetadata(...args);
			entered.resolve();
			await release.promise;
			return result;
		});
		let cancelled: Promise<unknown> | undefined;
		try {
			await pool.invoke("init", { scope, registration: { ...registered, skinId: "manual-abort",
				settings: { ...registered.settings, autoRecall: false,
					retrieval: { ...registered.settings.retrieval, mode: "vector", rerank: "none", minScore: 0, hardMinScore: 0 } },
			} }, "manual-abort");
			const query = "What route and supplies does the expedition notebook describe?";
			await pool.invoke("getRecall", { scope, query, options: { source: "auto" } }, "manual-abort");
			const request = { scope, query, options: { source: "manual", minScore: 0, tokenBudget: 20_000 } };
			cancelled = pool.invoke("getRecall", request, "manual-abort", controller.signal).catch(error => error);
			await entered.promise;
			controller.abort(new Error("manual recall cancelled"));
			release.resolve();
			expect(await cancelled).toEqual(new Error("manual recall cancelled"));
			const retry = await pool.invoke("getRecall", request, "manual-abort");
			expect(retry).toMatchObject({ toolResult: { details: { count: 30, already_served_count: 0 } } });
			if (!("toolResult" in retry) || !retry.toolResult) throw new Error("missing recall result");
			expect(retry.toolResult.details.memories).toHaveLength(30);
			const following = await pool.invoke("getRecall", request, "manual-abort");
			expect(following).toMatchObject({ toolResult: { details: { count: 0, memories: [], already_served_count: 30 } } });
			if (!("toolResult" in following) || !following.toolResult) throw new Error("missing recall result");
		} finally {
			release.resolve();
			await cancelled;
			updating.mockRestore();
			await pool.close();
		}
	});
});
