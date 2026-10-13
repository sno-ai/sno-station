import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const sno = execFileSync("which", ["sno"], { encoding: "utf8" }).trim();

async function probe(code: string, env: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "native-cleanup-test-"));
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
		cwd: repo, env: { ...process.env, TMPDIR: root, SNO_BINARY: sno, SNO_PROFILE_DIR: join(root, "caller-profile"), ...env }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let errors = "";
	child.stdout.on("data", part => { output += part; });
	child.stderr.on("data", part => { errors += part; });
	const closed = new Promise<number | null>(done => child.once("close", done));
	const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
	try {
		await closed;
		return { output, errors, profiles: readdirSync(root).filter(name => name.startsWith("mem-update-")) };
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
}

it.each(["claude", "cursor"])("%s removes its profile if setup fails before connecting", async skin => {
	const code = skin === "claude"
		? 'await (await import("./tests/apps/mem-claude/e2e-agent/run-parity-01-explicit-remember-e2e.mjs")).createClaudeNative("cleanup-failure");'
		: 'process.argv[1] = new URL("./tests/apps/mem-cursor/e2e-agent/run-parity-01-explicit-remember-e2e.mjs", import.meta.url).pathname; await import("./tests/apps/mem-cursor/e2e-agent/run-parity-01-explicit-remember-e2e.mjs");';
	const result = await probe(code, { SNO_BINARY: "/missing-test-sno" });
	expect(result.errors).toContain("ENOENT");
	expect(result.profiles).toEqual([]);
}, 65_000);

it("Cursor connects to its test profile and cleans up when the agent command cannot start", async () => {
	const result = await probe('process.argv[1] = new URL("./tests/apps/mem-cursor/e2e-agent/run-parity-01-explicit-remember-e2e.mjs", import.meta.url).pathname; await import("./tests/apps/mem-cursor/e2e-agent/run-parity-01-explicit-remember-e2e.mjs");',
		{ CURSOR_AGENT_BIN: "/missing-test-cursor-agent" });
	const line = result.output.split("\n").find(value => value.startsWith('{"passed":'));
	expect(line, result.errors).toBeDefined();
	const proof = JSON.parse(line ?? "null");
	expect(proof.passed).toBe(false);
	expect(proof.checks).toEqual({ installed: true });
	expect(proof.failure).toContain("Cursor did not print a memory id");
	expect(result.profiles).toEqual([]);
}, 65_000);

it.each([false, true])("Codex removes its profile when the supplied journey fails=%s without running Codex", async fails => {
	const result = await probe(`
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { runNativeCase } from "./tests/apps/mem-codex/e2e-agent/run-parity-01-explicit-remember-e2e.mjs";
let profile, worker, service;
const saved = { home: process.env.HOME, profile: process.env.SNO_PROFILE_DIR };
try {
  try { await runNativeCase(async ({ fixture }) => {
    profile = fixture.profile; service = fixture.client.pid;
    worker = spawn(process.execPath, ["--import", "tsx", "apps/mem-codex/src/cli.ts", "worker"], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = ""; worker.stdout.on("data", part => { output += part; }); worker.stderr.on("data", part => { output += part; });
    const deadline = Date.now() + 10000;
    while (!output.includes('"event":"worker-registered"') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!output.includes('"event":"worker-registered"')) throw new Error("worker did not register: " + output);
    if (${fails}) throw new Error("journey failure");
  }); } catch (error) { if (error.message !== "journey failure") throw error; }
  const live = pid => { try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {encoding:"utf8"}).trim().startsWith("Z"); } catch { return false; } };
  let lateDegraded = false;
  if (!existsSync(profile)) {
    const previousProfile = process.env.SNO_PROFILE_DIR;
    process.env.SNO_PROFILE_DIR = profile;
    lateDegraded = (await (await import("./packages/memory/dist/client.js")).connect({skinId:"codex"})).degraded;
    if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previousProfile;
  }
  console.log("CLEANUP_RESULT " + JSON.stringify({ lateDegraded, profileExists: existsSync(profile), workerAlive: live(worker.pid), serviceAlive: live(service), homeRestored: process.env.HOME === saved.home, profileRestored: process.env.SNO_PROFILE_DIR === saved.profile }));
} finally {
  for (const pid of [worker?.pid, service]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (profile) {
    const discovery = join(profile, "station/sidecar.json");
    if (existsSync(discovery)) { try { process.kill(JSON.parse(readFileSync(discovery,"utf8")).pid,"SIGKILL"); } catch {} }
    rmSync(profile, {recursive:true,force:true});
  }
}
`);
	const line = result.output.split("\n").find(value => value.startsWith("CLEANUP_RESULT "));
	expect(line, result.errors).toBeDefined();
	expect(JSON.parse(line?.slice(15) ?? "null")).toEqual({ lateDegraded: true, profileExists: false, workerAlive: false,
		serviceAlive: false, homeRestored: true, profileRestored: true });
	expect(result.profiles).toEqual([]);
}, 65_000);

it("Claude stops its worker before the service and removes the profile even when the journey failed", async () => {
	const result = await probe(`
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { createClaudeNative } from "./tests/apps/mem-claude/e2e-agent/run-parity-01-explicit-remember-e2e.mjs";
const saved = process.env.SNO_PROFILE_DIR;
let test, worker;
try {
  test = await createClaudeNative("cleanup");
  worker = spawn(process.execPath, ["--import", "tsx", "apps/mem-claude/src/cli.ts", "worker"], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = ""; worker.stdout.on("data", part => { output += part; }); worker.stderr.on("data", part => { output += part; });
  const deadline = Date.now() + 10000;
  while (!output.includes('"event":"worker-registered"') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,25));
  if (!output.includes('"event":"worker-registered"')) throw new Error("worker did not register: " + output);
  await test.finish(new Error("journey failure"));
  const live = pid => { try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {encoding:"utf8"}).trim().startsWith("Z"); } catch { return false; } };
  let lateDegraded = false;
  if (!existsSync(test.proof.profile)) {
    const previousProfile = process.env.SNO_PROFILE_DIR;
    process.env.SNO_PROFILE_DIR = test.proof.profile;
    lateDegraded = (await (await import("./packages/memory/dist/client.js")).connect({skinId:"claude-code"})).degraded;
    if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previousProfile;
  }
  console.log("CLEANUP_RESULT " + JSON.stringify({ lateDegraded, profileExists: existsSync(test.proof.profile), workerAlive: live(worker.pid), serviceAlive: live(test.proof.servicePid), profileRestored: process.env.SNO_PROFILE_DIR === saved }));
} finally {
  for (const pid of [worker?.pid, test?.proof.servicePid]) if (pid) { try { process.kill(pid,"SIGKILL"); } catch {} }
  if (test) {
    const discovery = join(test.proof.profile,"station/sidecar.json");
    if (existsSync(discovery)) { try { process.kill(JSON.parse(readFileSync(discovery,"utf8")).pid,"SIGKILL"); } catch {} }
    rmSync(test.proof.profile,{recursive:true,force:true});
  }
}
`);
	const line = result.output.split("\n").find(value => value.startsWith("CLEANUP_RESULT "));
	expect(line, result.errors).toBeDefined();
	expect(JSON.parse(line?.slice(15) ?? "null")).toEqual({ lateDegraded: true, profileExists: false, workerAlive: false,
		serviceAlive: false, profileRestored: true });
	expect(result.profiles).toEqual([]);
}, 65_000);
