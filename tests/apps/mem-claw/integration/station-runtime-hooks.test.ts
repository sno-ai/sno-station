import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryClient } from "@snoai/memory/client";
import { registerRuntimeHooks } from "../../../../apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts";
import type { MemoryConnection } from "../../../../apps/mem-claw/src/install/memory-connection.ts";
import type { RuntimeObserveController } from "../../../../apps/mem-claw/src/hooks/openclaw-observe-controller.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

describe("Station OpenClaw memory hooks", () => {
  let root: string;
  let server: Server;
  let harness: OpenClawPluginApiHarness;
  let memoryText: string;
  const context = { sessionKey: "agent:main:ordinary", sessionId: "ordinary-id", workspaceDir: "/tmp/project" };

  function journal(name: string): unknown[] {
    const path = join(root, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  }

  function commandOutput(stdout: string, exit = 0, delay = 0): void {
    writeFileSync(join(root, "answer.json"), JSON.stringify({ stdout, exit, delay }));
  }

  async function prompt(sessionKey = "agent:main:ordinary", text = "first question", workspaceDir = "/tmp/project"): Promise<unknown> {
    const hook = harness.getOnHookHandler("before_prompt_build");
    if (!hook) throw new Error("before_prompt_build missing");
    return hook({ prompt: text, messages: [] }, { ...context, sessionKey, workspaceDir });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "mem-claw-station-"));
    vi.stubEnv("SNO_PROFILE_DIR", root);
    vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
    writeSettingsFixture(root, { recall: { auto: true, sessionStart: { timeoutMs: 1000 }, prompt: { timeoutMs: 1000 } } });
    mkdirSync(join(root, "station"));
    commandOutput("Use literal results in tests.\n");
    writeFileSync(join(root, "sno"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(path.join(root, 'recall.jsonl'), JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
const answer = JSON.parse(fs.readFileSync(path.join(root, 'answer.json'), 'utf8'));
setTimeout(() => {
  process.stdout.write(answer.stdout);
  if (answer.exit) process.stderr.write('recall unavailable');
  process.exit(answer.exit);
}, answer.delay);
`, { mode: 0o755 });
    memoryText = "Existing memory.";
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      appendFileSync(join(root, "memory.jsonl"), JSON.stringify({ path: req.url, body }) + "\n");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/get-recall") res.end(JSON.stringify({ degraded: false, recallId: "recall-1", contextText: memoryText }));
      else if (req.url === "/v1/capture") res.end(JSON.stringify({ degraded: false, turnId: "turn-1", committed: true }));
      else if (req.url === "/v1/record-usage") res.end(JSON.stringify({ degraded: false, accepted: true }));
      else res.end(JSON.stringify({ degraded: false, completed: true }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP address missing");
    const discovery = { pid: process.pid, port: address.port, token: "a".repeat(64) };
    writeFileSync(join(root, "station", "sidecar.json"), JSON.stringify(discovery));
    const client = new MemoryClient("mem-claw", join(root, "memory.sqlite"), discovery);
    const connection: MemoryConnection = {
      ready: async () => client,
      scope: async (ctx = {}) => ({ principal: client.principal, project: ctx.workspaceDir ?? "/tmp/project", session: ctx.sessionKey ?? "ordinary-id", host: {} }),
      close: async () => undefined,
    };
    harness = new OpenClawPluginApiHarness();
    const observe: RuntimeObserveController = {
      observedApi: harness,
      observeSessionUuid: () => undefined,
      runInObserveSession: (_id, operation) => operation(),
      lookupActiveObserveSession: () => undefined,
      startObserveSession: async () => undefined,
      finalizeObserveSession: async () => undefined,
    };
    registerRuntimeHooks(harness, { sessionStrategy: "memoryReflection" } as never, connection, observe, {} as never);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["before_prompt_build", "agent_end", "before_reset", "after_compaction", "session_end", "after_tool_call", "command:new", "command:reset"])("skips Station one-shot memory work in %s", async name => {
    const ctx = { ...context, sessionKey: "agent:main:explicit:sno-oneshot-review", sessionId: "sno-oneshot-review" };
    const event = { prompt: "review", success: true, messages: [{ role: "user", content: "review", at: 1 }], sessionId: "sno-oneshot-review", messageCount: 1, toolName: "exec", params: {}, result: "ok", sessionKey: ctx.sessionKey, action: name === "command:new" ? "new" : "reset" };
    // The SDK registry erases event types; supply the recorded hook shapes above.
    const hook = name.startsWith("command:") ? harness.getHookHandler(name) : harness.registeredOnHooks.find(entry => entry.hookName === name)?.handler;
    if (!hook) throw new Error(`Missing hook: ${name}`);
    const result = await (hook as (event: unknown, ctx: unknown) => unknown)(event, ctx);
    expect(result).toBeUndefined();
    expect(journal("memory.jsonl")).toEqual([]);
    expect(journal("recall.jsonl")).toEqual([]);
    expect(harness.logMessages.info.join("\n")).toContain("Station one-shot run skipped");
    expect(harness.logMessages.info.join("\n")).toContain(":explicit:sno-oneshot-");
  });

  it.each([
    "Use literal results in tests.\n",
    '{"hookSpecificOutput":{"additionalContext":"Use literal results in tests."}}\n',
  ])("appends lesson output once per key: %s", async stdout => {
    commandOutput(stdout);
    expect(await prompt()).toEqual({ prependContext: "Existing memory.\n\nUse literal results in tests." });
    expect(await prompt("agent:main:ordinary", "second question", "/tmp/another-project")).toEqual({ prependContext: "Existing memory." });
    expect(journal("recall.jsonl")).toEqual([{
      args: ["rem-reflect", "recall", "--agent", "openclaw", "--first-message"],
      input: { session_id: "ordinary-id", cwd: "/tmp/project", prompt: "first question" },
    }]);
    expect(await prompt("agent:main:another")).toEqual({ prependContext: "Existing memory.\n\nUse literal results in tests." });
    expect(journal("recall.jsonl").length).toBe(2);
  });

  it("injects lessons when ordinary memory is empty or disabled", async () => {
    memoryText = "";
    expect(await prompt()).toEqual({ prependContext: "Use literal results in tests." });
    writeSettingsFixture(root, { recall: { auto: false } });
    expect(await prompt("agent:main:disabled")).toEqual({ prependContext: "Use literal results in tests." });
    expect(await prompt("agent:main:disabled")).toBeUndefined();
    expect(journal("memory.jsonl").length).toBe(1);
  });

  it("uses the session key when the hook has no session id", async () => {
    const hook = harness.getOnHookHandler("before_prompt_build");
    if (!hook) throw new Error("before_prompt_build missing");
    expect(await hook({ prompt: "key-only question", messages: [] }, { sessionKey: "agent:main:key-only", workspaceDir: "/tmp/key-only" })).toEqual({ prependContext: "Existing memory.\n\nUse literal results in tests." });
    expect(journal("recall.jsonl")).toEqual([{
      args: ["rem-reflect", "recall", "--agent", "openclaw", "--first-message"],
      input: { session_id: "agent:main:key-only", cwd: "/tmp/key-only", prompt: "key-only question" },
    }]);
  });

  it("does not treat an ordinary key with a one-shot session id as a Station run", async () => {
    const hook = harness.getOnHookHandler("agent_end");
    if (!hook) throw new Error("agent_end missing");
    expect(await prompt("agent:main:sno-oneshot-user")).toEqual({ prependContext: "Existing memory.\n\nUse literal results in tests." });
    await hook({ success: true, messages: [{ role: "user", content: "ordinary message", at: 1 }] }, { ...context, sessionId: "sno-oneshot-user" });
    const writes = journal("memory.jsonl").filter(row => typeof row === "object" && row !== null && "path" in row && row.path === "/v1/capture");
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ body: { turn: { messages: [{ role: "user", content: "ordinary message", at: 1 }] } } });
  });

  it.each(["exit", "missing", "timeout", "invalid-json"])("continues normal memory injection after recall %s", async failure => {
    if (failure === "missing") rmSync(join(root, "sno"));
    else if (failure === "timeout") commandOutput("late lesson", 0, 20_000);
    else if (failure === "invalid-json") commandOutput('{"hookSpecificOutput":{"additionalContext":42}}');
    else commandOutput("", 1);
    if (failure === "missing") vi.stubEnv("PATH", root);
    const started = Date.now();
    expect(await prompt()).toEqual({ prependContext: "Existing memory." });
    if (failure === "timeout") expect(Date.now() - started < 10_000).toBe(true);
    expect(await prompt()).toEqual({ prependContext: "Existing memory." });
    expect(harness.logMessages.warn.length).toBe(1);
    expect(harness.logMessages.warn[0]).toContain("sno rem-reflect recall --agent openclaw --first-message");
    expect(harness.logMessages.warn[0]).toContain("failed");
    if (failure === "exit") expect(harness.logMessages.warn[0]).toContain("recall unavailable");
    if (failure === "missing") expect(harness.logMessages.warn[0]).toContain("ENOENT");
    if (failure === "timeout") expect(harness.logMessages.warn[0]).toContain("timed out");
    expect(journal("memory.jsonl").length).toBe(2);
  });

  it("remembers only the last 200 seen keys", async () => {
    writeSettingsFixture(root, { recall: { auto: false } });
    for (let index = 0; index < 200; index++) await prompt(`agent:main:bounded-${index}`);
    expect(await prompt("agent:main:bounded-0")).toBeUndefined();
    await prompt("agent:main:bounded-200");
    expect(await prompt("agent:main:bounded-0")).toBeUndefined();
    expect(await prompt("agent:main:bounded-1")).toEqual({ prependContext: "Use literal results in tests." });
    expect(journal("recall.jsonl").length).toBe(202);
  });
});
