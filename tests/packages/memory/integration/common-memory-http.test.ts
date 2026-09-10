import { execFile, fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  return JSON.parse(await readFile(join(root, "profile/station/sno-station-mem.json"), "utf8")).pid;
}
async function stateFiles(): Promise<string[]> {
  const files = await readdir(join(root, "profile/sno-station-mem"), { recursive: true });
  return files.filter(name => !name.endsWith(".log")).sort();
}

async function bindStore(path: string, profileDir?: string): Promise<void> {
  const bindEnv = profileDir ? { ...env, SNO_PROFILE_DIR: profileDir } : env;
  await new Promise<void>((resolve, reject) => {
    const bind = execFile(process.execPath, [join(core, "dist/cli.js"), "bind", path], { env: bindEnv, timeout: 20_000 }, error => error ? reject(error) : resolve());
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
  await bindStore(dbPath);
});
afterEach(async () => {
  for (const child of children.splice(0)) { child.disconnect(); child.kill("SIGTERM"); }
  if (!sidecarPid && root) {
    try { sidecarPid = JSON.parse(await readFile(join(root, "profile/station/sno-station-mem.json"), "utf8")).pid; } catch {}
  }
  await stopSidecar();
  for (const extra of extraRoots.splice(0)) {
    if (extra.pid) { try { process.kill(extra.pid, "SIGTERM"); } catch {} }
    await rm(extra.root, { recursive: true, force: true });
  }
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

it("QCG-6: a killed sidecar holds no turn, a stale discovery file is replaced by one new sidecar, and a paused sidecar is refused", async () => {
  const existing = await initialized();
  const killed = await discoveredPid();
  expect(await storeHolders()).toEqual([String(killed)]);
  process.kill(killed, "SIGKILL");
  await waitForExit(killed);
  sidecarPid = undefined;
  expect(await discoveredPid()).toBe(killed);
  const mtimeBefore = (await stat(dbPath)).mtimeMs;
  const filesBefore = await stateFiles();

  const recall = await exchange(existing, "getRecall", ["jasmine tea", scope, { source: "auto" }]);
  expect(recall).toMatchObject({ degraded: true, reason: "sidecar-unreachable" });
  expect(recall.hits ?? []).toEqual([]);
  expect(await exchange(existing, "capture", [{ turnId: "down", rewindEpoch: 0, messages: [{ role: "user", content: "lost turn", at: Date.now() }] }, scope])).toEqual({ thrown: true, reason: "sidecar-unreachable" });
  if (process.env.QCG6_PLANT === "direct-store") {
    // Acceptance defect plant: a client built with a direct store import writes during the outage.
    const { getDek, openEncryptedDb } = await import("@snoai/sno-station-core-crypto");
    const direct = openEncryptedDb(dbPath, await getDek());
    direct.exec("CREATE TABLE qcg6_plant (held TEXT)");
    direct.close();
  }
  expect(await storeHolders()).toEqual([]);
  expect((await stat(dbPath)).mtimeMs).toBe(mtimeBefore);
  expect(await stateFiles()).toEqual(filesBefore);

  const fresh = await initialized();
  const replacement = await discoveredPid();
  expect(replacement).not.toBe(killed);
  expect(await sidecarProcesses()).toEqual([replacement]);
  expect(await exchange(fresh, "getRecall", ["jasmine tea", scope, { source: "auto" }])).toMatchObject({ degraded: false });
  expect(await storeHolders()).toEqual([String(replacement)]);

  process.kill(replacement, "SIGSTOP");
  try {
    const paused = await client();
    expect(paused.connected).toEqual({ degraded: true, reason: "sidecar-unresponsive" });
    expect(await sidecarProcesses()).toEqual([replacement]);
  } finally { process.kill(replacement, "SIGCONT"); }
  const resumed = await client();
  expect(resumed.connected).toMatchObject({ degraded: false, pid: replacement });
});

async function connectMany(count: number): Promise<{ pid: number; port: number; principal: string }[]> {
  const results = await Promise.all(Array.from({ length: count }, () => client()));
  return results.map(({ connected }) => {
    expect(connected).toMatchObject({ degraded: false, principal: userInfo().username });
    return connected;
  });
}

it("QCG-5: 32 concurrent first connects share one sidecar, one port and one binding; a 2 s startup delay still yields one; a second profile root yields two", async () => {
  const first = await connectMany(32);
  const pid = first[0].pid;
  expect(new Set(first.map(c => c.pid))).toEqual(new Set([pid]));
  expect(new Set(first.map(c => c.port)).size).toBe(1);
  expect(await settledSidecarProcesses()).toEqual([pid]);
  expect(await discoveredPid()).toBe(pid);
  const bindings = (await readdir(join(root, "profile/station"))).filter(name => name.endsWith(".binding.json"));
  expect(bindings).toEqual([`sno-station-mem-${userInfo().username}.binding.json`]);
  expect(JSON.parse(await readFile(join(root, "profile/station", bindings[0]), "utf8")).storePath).toBe(dbPath);

  await stopSidecar();
  for (const child of children.splice(0)) { child.disconnect(); child.kill("SIGTERM"); }
  const entry = join(core, "dist/sidecar/main.js");
  const marker = "//#region package.json";
  const text = await readFile(entry, "utf8");
  expect(text.includes(marker)).toBe(true);
  await writeFile(entry, text.replace(marker, `await new Promise(resolve => setTimeout(resolve, 2000));\n${marker}`));
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
  await bindStore(join(secondRoot, "data/memory.sqlite"), secondProfile);
  const [second] = await Promise.all([client(undefined, secondProfile), client()]);
  expect(second.connected).toMatchObject({ degraded: false, principal: userInfo().username });
  extraRoots[0].pid = second.connected.pid;
  expect(second.connected.pid).not.toBe(delayedPid);
  expect((await settledSidecarProcesses()).sort()).toEqual([delayedPid, second.connected.pid].sort());
  expect(JSON.parse(await readFile(join(secondProfile, "station/sno-station-mem.json"), "utf8")).pid).toBe(second.connected.pid);
  expect(await discoveredPid()).toBe(delayedPid);
}, 180_000);

it("QCG-19 sidecar tick owns volume, daily and disabled missed-window decisions", async () => {
  const profile = join(root, "profile"), stateDir = join(profile, "sno-station-mem");
  const installedPath = join(profile, "station", `sno-station-mem-${scope.principal}.config.json`);
  const source = join(original, "config/rem/sno-e2e");
  env.SNO_STATION_MEM_MAINTENANCE_INTERVAL_MS = "1000";
  env.SNO_STATION_MEM_REM_VOLUME_THRESHOLD = "2";
  env.SNO_STATION_MEM_REM_EXPECTED_DB_PATH = dbPath;
  env.SNO_STATION_MEM_REM_CLOCK_OVERRIDE = "2026-09-10T12:00:00.000Z";
  env.SNO_STATION_MEM_REM_CONFIG_JSON = await readFile(join(source, "enable.json"), "utf8");
  env.TZ = "UTC";
  const installed = JSON.parse(await readFile(installedPath, "utf8"));
  installed.mode = "rem-enhanced"; installed.remOperations = ["rem-update"];
  installed.remEnhanced = { trigger: { tick: true } };
  await writeFile(installedPath, JSON.stringify(installed), { mode: 0o600 });
  await mkdir(stateDir, { recursive: true });
  await cp(join(source, "rem-grammar-corpus"), join(stateDir, "rem-grammar-corpus"), { recursive: true });
  await new Promise<void>((resolve, reject) => execFile("bash", [join(repo, "evals/sno-memory-bench/materialize-rem-config.sh"),
    "--source-dir", source, "--state-dir", profile, "--sno-profile-dir", profile,
    "--service-unit", join(root, "rem.service"), "--service-drop-in", join(root, "rem.service.d/config.conf"),
    "--node-binary", process.execPath, "--sidecar-entry", join(core, "dist/sidecar/main.js"),
    "--sidecar-uid", String(process.getuid?.() ?? 0)], { env, timeout: 30_000 }, error => error ? reject(error) : resolve()));
  const triggerPath = join(stateDir, "rem-trigger-state.json");
  const jobsPath = join(stateDir, "rem-wave-jobs.jsonl");
  const jsonLines = async (path: string) => (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const trigger = async () => JSON.parse(await readFile(triggerPath, "utf8")).scopes[scope.project];
  const eventually = async (check: () => Promise<boolean>, label: string, ms = 180_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await delay(250); }
    throw new Error(`QCG-19 deadline: ${label}`);
  };
  const waitDone = async (prior: Set<string>) => {
    await eventually(async () => {
      const rows = await jsonLines(jobsPath);
      const failed = rows.find(row => !prior.has(row.waveId) && row.state === "failed");
      if (failed) throw new Error(`automatic wave failed: ${JSON.stringify(failed)}`);
      return rows.some(row => !prior.has(row.waveId) && row.state === "done");
    }, "automatic wave completion");
  };
  try {
    const writer = await initialized();
    const capture = async (n: number) => {
      expect(await exchange(writer, "capture", [{ turnId: `tick-${n}`, rewindEpoch: 0, messages: [
        { role: "user", content: `My project deadline preference is ${n + 10} September 2026.`, at: Date.parse("2026-09-10T12:00:00Z") + n * 1000 },
      ] }, scope])).toMatchObject({ degraded: false, committed: true });
    };
    await capture(0);
    await eventually(async () => existsSync(triggerPath) && (await trigger()) !== undefined, "initial scope baseline");
    expect(await jsonLines(jobsPath)).toEqual([]);
    for (let n = 1; n <= 3; n++) await capture(n);
    await waitDone(new Set());
    const volumeJobs = await jsonLines(jobsPath);
    expect(volumeJobs.some(row => row.state === "done" && row.stats.measured.rows_considered >= 3)).toBe(true);
    expect((await jsonLines(join(stateDir, "audit.jsonl"))).some(row => row.details?.trigger === "volume" && row.details?.row === "dispatch" && row.details?.growth?.delta >= 2 && row.details?.growth?.threshold === 2)).toBe(true);
    await stopSidecar();
    env.SNO_STATION_MEM_REM_CLOCK_OVERRIDE = "2026-09-11T04:00:00.000Z";
    await initialized();
    await waitDone(new Set(volumeJobs.map(row => row.waveId)));
    expect((await jsonLines(join(stateDir, "audit.jsonl"))).some(row => row.details?.trigger === "daily" && row.details?.row === "dispatch")).toBe(true);
    await stopSidecar();
    const beforeDisabled = new Set((await jsonLines(jobsPath)).map(row => row.waveId));
    installed.remEnhanced.trigger.tick = process.env.ZEBRA_QCG19_PLANT === "tick-enabled";
    await writeFile(installedPath, JSON.stringify(installed), { mode: 0o600 });
    env.SNO_STATION_MEM_REM_CLOCK_OVERRIDE = "2026-09-12T04:00:00.000Z";
    await initialized();
    await eventually(async () => {
      const jobs = await jsonLines(jobsPath);
      expect(jobs.every(row => beforeDisabled.has(row.waveId)), "disabled tick dispatched a wave").toBe(true);
      return (await trigger()).missed_window !== null;
    }, "disabled tick records missed window", 15_000);
    expect((await trigger()).missed_window).toMatchObject({ trigger: "daily", recorded_at: env.SNO_STATION_MEM_REM_CLOCK_OVERRIDE });
    await delay(2500);
    expect((await jsonLines(jobsPath)).every(row => beforeDisabled.has(row.waveId))).toBe(true);
    const journal = await jsonLines(join(stateDir, "rem-chassis-journal.jsonl"));
    expect(journal.length).toBeGreaterThan(0);
  } finally {
    const evidence = process.env.ZEBRA_QCG19_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      for (const name of ["rem-trigger-state.json", "rem-wave-jobs.jsonl", "rem-chassis-journal.jsonl", "audit.jsonl", "sidecar-startup.log"]) {
        await cp(join(stateDir, name), join(evidence, name)).catch(() => undefined);
      }
      await writeFile(join(evidence, "provenance.json"), JSON.stringify({ callsign: "zebra", host: (await import("node:os")).hostname(), sidecarPid,
        profile, principal: scope.principal, clientCallsRemRun: false, intervalMs: 1000, volumeThreshold: 2, clock: env.SNO_STATION_MEM_REM_CLOCK_OVERRIDE,
        tickEnabledInInstalledConfig: installed.remEnhanced.trigger.tick, corpusMaterialized: true }, null, 2));
    }
  }
}, 600_000);
