import { execFile, fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type SettingsDocument, writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { untilModelReady } from "./fixtures/model-ready";
import { modelReply, startRecorder } from "./fixtures/model-recorders";

const repo = resolve(import.meta.dirname, "../../../..");
const original = join(repo, "packages/memory");
const scope = { principal: userInfo().username, project: "agent:http-acceptance", session: "agent:http-acceptance:release", host: { agentId: "http-acceptance", sessionTimezone: "America/Los_Angeles" } };
// A registration is the skin only; everything else comes from settings.json (REQ-4).
const registration = { skinId: "http-acceptance" };
let root: string;
let core: string;
let dbPath: string;
let storeKey: string;
let env: NodeJS.ProcessEnv;
let sidecarPid: number | undefined;
const children: ChildProcess[] = [];
const extraRoots: { root: string; pid: number | undefined }[] = [];

async function exchange(child: ChildProcess, method: string, args: unknown[]): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`client deadline: ${method}`)); }, 110_000);
    const receive = (value: unknown) => { cleanup(); resolve(value); };
    const exited = () => { cleanup(); reject(new Error(`client exited: ${method}`)); };
    function cleanup() { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); }
    child.once("message", receive); child.once("exit", exited);
    child.send({ method, args });
  });
}
async function client(storePath?: string, profileDir?: string) {
  const childEnv = profileDir ? { ...env, SNO_PROFILE_DIR: profileDir } : env;
  const child = fork(join(root, "client.mjs"), [], { env: childEnv, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("client boot failed"))); });
  const connected = await exchange(child, "connect", [{ skinId: registration.skinId, storePath }]);
  if (!connected.degraded && !profileDir) sidecarPid = connected.pid;
  return { child, connected };
}
async function initialized(storePath?: string, withRegistration: object = registration) {
  const { child, connected } = await client(storePath);
  if (connected.degraded) {
    const startup = await readFile(join(root, "profile/sno-station-mem/sidecar-startup.log"), "utf8").catch(() => "no startup log");
    throw new Error(`connection failed: ${connected.reason}\n${startup.slice(-6000)}`);
  }
  expect(connected).toMatchObject({ degraded: false, principal: scope.principal });
  expect(await exchange(child, "init", [scope, withRegistration])).toMatchObject({ degraded: false });
  // Before its embedding model is prepared the service only accepts a capture; these tests need it committed.
  await untilModelReady(({ scope: probe, query, options }) => exchange(child, "getRecall", [query, { ...scope, ...probe }, options]));
  return child;
}
async function stopSidecar() {
  if (!sidecarPid) return;
  try { process.kill(sidecarPid, "SIGTERM"); } catch { return; }
  // A sidecar resumed from SIGSTOP finishes its interrupted work before it exits; allow up to 30 s.
  for (let i = 0; i < 600; i++) {
    try { process.kill(sidecarPid, 0); } catch { sidecarPid = undefined; return; }
    await delay(50);
  }
  throw new Error(`owned sidecar did not exit within 30 s: ${sidecarPid}`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
  throw new Error(`process did not exit: ${pid}`);
}
async function storeHolders(): Promise<string[]> {
  return await new Promise(resolve => {
    execFile("lsof", ["-t", "--", dbPath], { timeout: 10_000 }, (_error, stdout) => resolve(stdout.split("\n").filter(Boolean).sort()));
  });
}
async function sidecarProcesses(): Promise<number[]> {
  const entry = join(core, "dist/sidecar/main.js");
  const pids: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const cmdline = await readFile(join("/proc", name, "cmdline"), "utf8").catch(() => "");
    if (cmdline.split("\0").includes(entry)) pids.push(Number(name));
  }
  return pids.sort((a, b) => a - b);
}
async function settledSidecarProcesses(): Promise<number[]> {
  // Losing starters exit 75 once the lifecycle lock refuses them; wait for the table to settle.
  let seen = await sidecarProcesses();
  for (let i = 0; i < 200 && seen.length > 1; i++) { await delay(100); seen = await sidecarProcesses(); }
  return seen;
}
async function discoveredPid(): Promise<number> {
  return JSON.parse(await readFile(join(root, "profile/station/sidecar.json"), "utf8")).pid;
}
async function stateFiles(): Promise<string[]> {
  const files = await readdir(join(root, "profile/sno-station-mem"), { recursive: true });
  return files.filter(name => !name.endsWith(".log")).sort();
}

/** The installed settings, written where the sidecar reads them once when its runtime opens; the client starts `core`'s service. */
function writeSettings(profileDir: string, storePath: string, overrides: SettingsDocument = {}): void {
  writeSettingsFixture(profileDir, { mode: "local-first", store: { path: storePath, encryptionKey: storeKey }, embedding: { cacheDir: "" },
    memoryPackage: { path: core, node: process.execPath },
    telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } }, ...overrides });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "common-memory-http-"));
  core = join(root, "core"); dbPath = join(root, "data/memory.sqlite");
  // One store key per test; a test home keeps the store manifest out of the operator's.
  storeKey = randomBytes(32).toString("hex");
  env = { ...process.env, SNO_PROFILE_DIR: join(root, "profile"), HOME: join(root, "home") };
  await cp(join(original, "dist"), join(core, "dist"), { recursive: true });
  await cp(join(original, "package.json"), join(core, "package.json"));
  for (const entry of ["drizzle", "sqlite-extensions", "config", "scripts", "generated", "skills", "fixtures"]) {
    if (existsSync(join(original, entry))) await symlink(join(original, entry), join(core, entry));
  }
  await symlink(join(repo, "node_modules"), join(core, "node_modules"));
  await mkdir(join(root, "node_modules/@snoai"), { recursive: true });
  await symlink(core, join(root, "node_modules/@snoai/memory"));
  await cp(join(import.meta.dirname, "fixtures/common-memory-client.mjs"), join(root, "client.mjs"));
  const plant = process.env.ZEBRA_D7_PLANT;
  if (plant) {
    const needle = plant === "principal"
      ? 'if (parseInput(method, raw).scope.principal !== this.principal) throw new ContractError("principal-mismatch");'
      : 'if (requestedPath && path.resolve(requestedPath) !== binding.storePath) throw new ContractError("store-mismatch");';
    let changed = 0;
    for (const file of await readdir(join(core, "dist"))) {
      if (!file.endsWith(".js")) continue;
      if (plant === "store" && !file.startsWith("profile-")) continue;
      const path = join(core, "dist", file), text = await readFile(path, "utf8");
      if (text.includes(needle)) { await writeFile(path, text.replace(needle, "/* acceptance defect plant: guard removed */")); changed++; }
    }
    expect(changed).toBe(1);
  }
  if (process.env.QCG5_PLANT === "fixed-lock") {
    // Acceptance defect plant: the sidecar lock path taken from a fixed location outside the profile root.
    const needle = 'return path.join(getSnoStationMemStateDir(), "sidecar.lock");';
    let changed = 0;
    for (const file of await readdir(join(core, "dist"))) {
      if (!file.endsWith(".js")) continue;
      const path = join(core, "dist", file), text = await readFile(path, "utf8");
      if (text.includes(needle)) { await writeFile(path, text.replace(needle, `return ${JSON.stringify(join(tmpdir(), "qcg5-fixed-sidecar.lock"))};`)); changed++; }
    }
    expect(changed).toBe(1);
  }
  writeSettings(join(root, "profile"), dbPath);
});
afterEach(async () => {
  for (const child of children.splice(0)) { child.disconnect(); child.kill("SIGTERM"); }
  if (!sidecarPid && root) {
    try { sidecarPid = JSON.parse(await readFile(join(root, "profile/station/sidecar.json"), "utf8")).pid; } catch {}
  }
  await stopSidecar();
  for (const extra of extraRoots.splice(0)) {
    if (extra.pid) { try { process.kill(extra.pid, "SIGTERM"); } catch {} }
    await rm(extra.root, { recursive: true, force: true });
  }
  if (root) await rm(root, { recursive: true, force: true });
});

it("captures in one published client process, recalls in another, forgets and reads back", async () => {
  const writer = await initialized();
  const turn = { turnId: "http-tea", rewindEpoch: 0, messages: [{ role: "user", content: "My stable personal preference is jasmine tea.", at: Date.parse("2026-09-09T18:00:00Z") }] };
  expect(await exchange(writer, "capture", [turn, scope])).toMatchObject({ degraded: false, committed: true });
  const reader = await initialized();
  expect(reader.pid).not.toBe(writer.pid);
  const recall = await exchange(reader, "getRecall", ["What is my stable personal preference for tea?", scope, { source: "auto" }]);
  expect(recall.degraded).toBe(false); expect(recall.contextText).toContain("jasmine tea");
  const listed = await exchange(reader, "inspect", [{ op: "list" }, scope]);
  expect(listed.degraded).toBe(false);
  const entry = listed.result.entries.find((row: { text: string }) => row.text.includes("jasmine tea"));
  expect(entry).toBeDefined();
  expect(await exchange(reader, "mutate", [{ op: "forget", id: entry.id }, scope])).toMatchObject({ degraded: false });
  const readback = await exchange(reader, "inspect", [{ op: "get", id: entry.id }, scope]);
  expect(readback).toMatchObject({ degraded: false, result: { entry: null } });
});

it("QCG-5: 32 concurrent first connects share one sidecar and one port; a 2 s startup delay still yields one; a second profile root yields two", async () => {
  const first = await connectMany(32);
  const pid = first[0].pid;
  expect(new Set(first.map(c => c.pid))).toEqual(new Set([pid]));
  expect(new Set(first.map(c => c.port)).size).toBe(1);
  expect(await settledSidecarProcesses()).toEqual([pid]);
  expect(await discoveredPid()).toBe(pid);

  await stopSidecar();
  for (const child of children.splice(0)) { child.disconnect(); child.kill("SIGTERM"); }
  const entry = join(core, "dist/sidecar/main.js");
  const marker = "//#region src/sidecar/main.ts";
  const text = await readFile(entry, "utf8");
  expect(text.includes(marker)).toBe(true);
  await writeFile(entry, text.replace(marker, `await new Promise(resolve => globalThis.setTimeout(resolve, 2000));\n${marker}`));
  const startedAt = Date.now();
  const delayed = await connectMany(32);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000);
  const delayedPid = delayed[0].pid;
  expect(delayedPid).not.toBe(pid);
  expect(new Set(delayed.map(c => c.pid))).toEqual(new Set([delayedPid]));
  expect(await settledSidecarProcesses()).toEqual([delayedPid]);

  const secondRoot = await mkdtemp(join(tmpdir(), "common-memory-http-second-"));
  const secondProfile = join(secondRoot, "profile");
  extraRoots.push({ root: secondRoot, pid: undefined });
  writeSettings(secondProfile, join(secondRoot, "data/memory.sqlite"));
  const [second] = await Promise.all([client(undefined, secondProfile), client()]);
  expect(second.connected).toMatchObject({ degraded: false, principal: userInfo().username });
  extraRoots[0].pid = second.connected.pid;
  expect(second.connected.pid).not.toBe(delayedPid);
  expect((await settledSidecarProcesses()).sort()).toEqual([delayedPid, second.connected.pid].sort());
  expect(JSON.parse(await readFile(join(secondProfile, "station/sidecar.json"), "utf8")).pid).toBe(second.connected.pid);
  expect(await discoveredPid()).toBe(delayedPid);
}, 180_000);
