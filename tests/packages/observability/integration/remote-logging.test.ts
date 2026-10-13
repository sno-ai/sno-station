import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureLogger, createLogger, effectiveLogLevel, setLogLevel } from "@snoai/utils/logger";
import { createSnoObserve } from "../../../../packages/observability/src/index";
import { startMockServer } from "../fixtures/sno-ai-mock-server.mjs";
import { createTempSnoEnv, validPayloads } from "../fixtures/temp-env.mjs";

afterEach(() => vi.unstubAllEnvs());

it("receives logging changes over HTTP, keeps ordinary logs and persists across process restart", async () => {
 const server = await startMockServer();
 const temp = createTempSnoEnv();
 vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
 const settingsPath = join(temp.dir, "settings.json");
 const settings = { logging: { level: "debug", debugContent: true }, telemetry: { observe: { enabled: true }, memoryUsage: { enabled: true } }, user: { language: "zh-CN" } };
 writeFileSync(settingsPath, JSON.stringify(settings));
 configureLogger({ app: "remote-log-test", serviceVersion: "test", buildId: "test", catalog: { build_id: "test", sites: {} }, level: "debug", home: temp.dir });
 const log = createLogger("remote-log-test");
 const site = { event_name: "remote.logging.test", file: "remote-logging.test.ts", function: "test", site_id: "remote.logging.test" };
 const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
 try {
  expect(log.debug("before remote setting", {}, site)).toBe(true);
  server.enqueue("/api/v1/events", { status: 202, body: { receipt_id: "accepted", logging: { level: "info" } } });
  await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
  expect(await observe.flush()).toMatchObject({ shipped: 2, retryable: 0 });
  expect(effectiveLogLevel()).toBe("info");
  expect(log.debug("after remote setting", {}, site)).toBe(false);
  expect(log.info("ordinary records continue", {}, site)).toBe(true);
  expect(log.warn("warnings continue", {}, site)).toBe(true);
  expect(log.error("errors continue", {}, site)).toBe(true);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...settings, logging: { ...settings.logging, level: "info" } });
  const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs'; import { configureLogger, effectiveLogLevel } from ${JSON.stringify(new URL('../../../../packages/utils/dist/logger.js', import.meta.url).href)}; const settings=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); configureLogger({app:'restart-test',serviceVersion:'test',buildId:'test',catalog:{build_id:'test',sites:{}},level:settings.logging.level}); console.log(effectiveLogLevel());`, settingsPath], { env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8", timeout: 5000 });
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(restarted.stdout.trim()).toBe("info");
  server.enqueue("/api/v1/events", { status: 202, body: { logging: { level: "debug" } } });
  await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
  expect(await observe.flush()).toMatchObject({ shipped: 1, retryable: 0 });
  expect(log.debug("remote enabled again", {}, site)).toBe(true);
  expect(JSON.parse(readFileSync(settingsPath, "utf8")).logging.level).toBe("debug");
 } finally { await observe.shutdown(); await server.stop(); rmSync(temp.dir, { recursive: true, force: true }); }
});

it("persists the remote level when settings have no logging section", async () => {
 const server = await startMockServer();
 const temp = createTempSnoEnv();
 vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
 const settingsPath = join(temp.dir, "settings.json");
 const before = JSON.parse(readFileSync(settingsPath, "utf8"));
 const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
 try {
  server.enqueue("/api/v1/events", { status: 202, body: { logging: { level: "info" } } });
  await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
  expect(await observe.flush()).toMatchObject({ shipped: 2, retryable: 0 });
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...before, logging: { level: "info" } });
 } finally { await observe.shutdown(); await server.stop(); rmSync(temp.dir, { recursive: true, force: true }); setLogLevel("debug"); }
});

it("ignores unrelated response fields and never applies a level that would suppress warnings", async () => {
 const server = await startMockServer();
 const temp = createTempSnoEnv();
 vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
 const settingsPath = join(temp.dir, "settings.json");
 const before = readFileSync(settingsPath, "utf8");
 const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
 try {
  server.enqueue("/api/v1/events", { status: 202, body: { logging: { level: "error" }, telemetry: { observe: { enabled: false } } } });
  await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
  expect(await observe.flush()).toMatchObject({ shipped: 2, retryable: 0 });
  expect(effectiveLogLevel()).toBe("debug");
  expect(readFileSync(settingsPath, "utf8")).toBe(before);
 } finally { await observe.shutdown(); await server.stop(); rmSync(temp.dir, { recursive: true, force: true }); }
});

it("keeps delivery successful when the logging setting cannot be saved", async () => {
 const server = await startMockServer();
 const temp = createTempSnoEnv();
 vi.stubEnv("SNO_PROFILE_DIR", temp.dir);
 const settingsPath = join(temp.dir, "settings.json");
 const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, baseUrl: server.baseUrl, deferDelivery: true });
 try {
  await observe.emit({ event_type: "memory.write", lane: "memory", agent_id: "codex", payload: validPayloads["memory.write"] });
  server.enqueue("/api/v1/events", { status: 202, body: { logging: { level: "info" } } });
  rmSync(settingsPath);
  expect(await observe.flush()).toMatchObject({ shipped: 2, retryable: 0 });
  expect(effectiveLogLevel()).toBe("info");
  expect(readFileSync(join(temp.dir, "observe.log"), "utf8")).toContain("observe.logging.remote.save_failed");
 } finally { await observe.shutdown(); await server.stop(); rmSync(temp.dir, { recursive: true, force: true }); setLogLevel("debug"); }
});
