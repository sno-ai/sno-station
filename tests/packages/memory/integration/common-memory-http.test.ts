import { execFile, fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "../../sno-station-core-crypto/_helpers";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-schema";

const repo = resolve(import.meta.dirname, "../../../..");
const original = join(repo, "packages/sno-station-mem");
const scope = { principal: userInfo().username, project: "agent:http-acceptance", session: "agent:http-acceptance:release", host: { agentId: "http-acceptance", sessionTimezone: "America/Los_Angeles" } };
const config = pluginConfigSchema.parse({ mode: "local-first", ambientLearning: true, autoRecall: true, captureAssistant: true, observe: { enabled: false }, memoryTelemetry: { enabled: false } });
const { mode, remEnhanced, agentNative, language, ...settings } = config;
const registration = { skinId: "http-acceptance", settings, routing: { mode, remEnhanced, agentNative, language } };
let root: string;
let core: string;
let dbPath: string;
let crypto: TestEnv;
let env: NodeJS.ProcessEnv;
let sidecarPid: number | undefined;
const children: ChildProcess[] = [];

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
async function client(storePath?: string) {
  const child = fork(join(root, "client.mjs"), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("client boot failed"))); });
  const connected = await exchange(child, "connect", [{ skinId: registration.skinId, storePath }]);
  if (!connected.degraded) sidecarPid = connected.pid;
  return { child, connected };
}
async function initialized(storePath?: string) {
  const { child, connected } = await client(storePath);
  if (connected.degraded) {
    const startup = await readFile(join(root, "profile/sno-station-mem/sidecar-startup.log"), "utf8").catch(() => "no startup log");
    throw new Error(`connection failed: ${connected.reason}\n${startup.slice(-6000)}`);
  }
  expect(connected).toMatchObject({ degraded: false, principal: scope.principal });
  expect(await exchange(child, "init", [scope, registration])).toMatchObject({ degraded: false });
  return child;
}
async function stopSidecar() {
  if (!sidecarPid) return;
  try { process.kill(sidecarPid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(sidecarPid, 0); } catch { sidecarPid = undefined; return; }
    await delay(50);
  }
  throw new Error(`owned sidecar did not exit: ${sidecarPid}`);
}

async function bindStore(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const bind = execFile(process.execPath, [join(core, "dist/cli.js"), "bind", path], { env, timeout: 20_000 }, error => error ? reject(error) : resolve());
    bind.stdin?.end(JSON.stringify({ mode: "local-first", embedding: config.embedding, memoryTelemetry: config.memoryTelemetry }));
  });
}

beforeEach(async () => {
  crypto = makeTestEnv("common-memory-http");
  root = await mkdtemp(join(tmpdir(), "common-memory-http-"));
  core = join(root, "core"); dbPath = join(root, "data/memory.sqlite");
  env = { ...process.env, SNO_PROFILE_DIR: join(root, "profile") };
  await cp(join(original, "dist"), join(core, "dist"), { recursive: true });
  await cp(join(original, "package.json"), join(core, "package.json"));
  for (const entry of ["drizzle", "sqlite-extensions", "config", "scripts", "generated", "skills", "fixtures"]) {
    if (existsSync(join(original, entry))) await symlink(join(original, entry), join(core, entry));
  }
  await symlink(join(repo, "node_modules"), join(core, "node_modules"));
  await mkdir(join(root, "node_modules/@snoai"), { recursive: true });
  await symlink(core, join(root, "node_modules/@snoai/sno-station-mem"));
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
  await bindStore(dbPath);
});
afterEach(async () => {
  for (const child of children.splice(0)) { child.disconnect(); child.kill("SIGTERM"); }
  if (!sidecarPid && root) {
    try { sidecarPid = JSON.parse(await readFile(join(root, "profile/station/sno-station-mem.json"), "utf8")).pid; } catch {}
  }
  await stopSidecar();
  if (root) await rm(root, { recursive: true, force: true });
  crypto?.cleanup();
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

it("refuses a foreign principal before granting engine or store access", async () => {
  const owner = await initialized();
  expect(await exchange(owner, "capture", [{ turnId: "private-tea", rewindEpoch: 0, messages: [{ role: "user", content: "My stable personal preference is jasmine tea.", at: Date.parse("2026-09-09T18:00:00Z") }] }, scope])).toMatchObject({ degraded: false, committed: true });
  const discovery = JSON.parse(await readFile(join(root, "profile/station/sno-station-mem.json"), "utf8"));
  const headers = { Authorization: `Bearer ${discovery.token}`, "Content-Type": "application/json", "x-sno-station-mem-skin": registration.skinId };
  const health = async () => await (await fetch(`http://127.0.0.1:${discovery.port}/healthz`, { headers })).json();
  const before = await health();
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/get-recall`, { method: "POST", headers, body: JSON.stringify({ scope: { ...scope, principal: `${scope.principal}-foreign` }, query: "jasmine tea", options: { source: "auto" } }) });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ degraded: true, reason: "principal-mismatch" });
  const { principal: _principal, ...missingPrincipal } = scope;
  const missing = await fetch(`http://127.0.0.1:${discovery.port}/v1/capture`, { method: "POST", headers, body: JSON.stringify({ scope: missingPrincipal, turn: { turnId: "missing", rewindEpoch: 0, messages: [] } }) });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ degraded: true, reason: "invalid-input" });
  expect((await health()).accessCounters).toEqual(before.accessCounters);
  const retained = await exchange(owner, "inspect", [{ op: "list" }, scope]);
  expect(retained.result.entries.some((row: { text: string }) => row.text.includes("jasmine tea"))).toBe(true);
});

it("refuses a requested store path different from the installed binding", async () => {
  const writer = await initialized();
  expect(await exchange(writer, "capture", [{ turnId: "bound-tea", rewindEpoch: 0, messages: [{ role: "user", content: "My stable personal preference is jasmine tea.", at: Date.parse("2026-09-09T18:00:00Z") }] }, scope])).toMatchObject({ degraded: false, committed: true });
  await stopSidecar();
  env.SNO_PROFILE_DIR = join(root, "default-profile");
  const unbound = await client();
  expect(unbound.connected.degraded).toBe(false);
  const defaultBinding = join(env.SNO_PROFILE_DIR, `station/sno-station-mem-${scope.principal}.binding.json`);
  expect(existsSync(defaultBinding)).toBe(false);
  expect(existsSync(join(env.SNO_PROFILE_DIR, "sno-station-mem", scope.principal, "memory.sqlite"))).toBe(true);
  await stopSidecar();
  await bindStore(dbPath);
  const reader = await initialized();
  const recall = await exchange(reader, "getRecall", ["What is my stable personal preference for tea?", scope, { source: "auto" }]);
  expect(recall.degraded).toBe(false); expect(recall.contextText).toContain("jasmine tea");
  const bindingPath = defaultBinding;
  const before = await readFile(bindingPath, "utf8");
  const wrongPath = join(root, "wrong.sqlite");
  await expect(bindStore(wrongPath)).rejects.toThrow();
  expect(await readFile(bindingPath, "utf8")).toBe(before);
  const { connected } = await client(wrongPath);
  expect(connected).toEqual({ degraded: true, reason: "store-mismatch" });
  expect(existsSync(wrongPath)).toBe(false);
  expect(await readFile(bindingPath, "utf8")).toBe(before);
});

it("reports daemon-down on an existing handle and never receipts a write", async () => {
  const existing = await initialized();
  await stopSidecar();
  expect(await exchange(existing, "getRecall", ["jasmine tea", scope, { source: "auto" }])).toMatchObject({ degraded: true, reason: "sidecar-unreachable" });
  expect(await exchange(existing, "capture", [{ turnId: "down", rewindEpoch: 0, messages: [] }, scope])).toEqual({ thrown: true, reason: "sidecar-unreachable" });
});
