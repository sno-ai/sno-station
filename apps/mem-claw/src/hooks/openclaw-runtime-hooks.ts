import type { RuntimeObserveController } from "./openclaw-observe-controller";
import type { PluginObservability } from "@snoai/memory/internal/engine/observability/adapter";
import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname } from "node:path";
import { detectProjectId, getSnoProfileDir } from "@snoai/observability";
import { SKILL_CATEGORIES, skillVersionFor } from "@snoai/memory/internal/config/skill-categories";
import { appendObserveLedgerRows } from "@snoai/memory/internal/engine/telemetry/observe-ledger";
import { resolveAgentId } from "@snoai/memory/internal/engine/bindings/memory-tool-access";
import { setLruEntry } from "@snoai/memory/internal/engine/shared/lru";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { ContractError, type Message, type ScopeCtx } from "@snoai/memory/client";
import type { PluginConfig } from "@snoai/memory/internal/config/plugin-config-schema";
import { readPluginSettings } from "../install/settings";
import { z } from "zod";
import { resolveWorkspace, type MemoryConnection, type HostMemoryContext } from "../install/memory-connection";
import { isPluginOwnedMessage, normalizeMessageTimestampMs } from "@snoai/memory/internal/engine/bindings/sno-station-mem-message-transcript";

const diagnosticLog = createDiagnosticLogger("mem-claw:openclaw-runtime-hooks");
/** Memory failures never leave a hook: the host turn continues without memory, and the reason is logged. */
async function contained<T>(hook: string, run: () => Promise<T>): Promise<T | undefined> {
  try { return await run(); }
  catch (error) {
    const reason = error instanceof ContractError ? error.reason : "engine-failed";
    diagnosticLog.warn("Memory service hook skipped", { hook, reason, error }, { event_name: "memory.openclaw_runtime_hooks.hook.skipped", file: "apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts", function: "contained", site_id: "hooks.openclaw-runtime-hooks.contained.memory-hook-skipped" });
    return undefined;
  }
}
const INPUT_TOKEN_KEYS = ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"] as const;
const OUTPUT_TOKEN_KEYS = ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"] as const;
const CACHE_READ_KEYS = ["cacheRead", "cache_read", "cache_read_tokens", "cache_read_input_tokens"] as const;
const CACHE_WRITE_KEYS = ["cacheWrite", "cache_write", "cache_write_tokens", "cache_creation_input_tokens"] as const;
/** The host reports token usage under several spellings; the first present numeric field wins per side. */
function hostUsage(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const usage = z.record(z.string(), z.unknown()).safeParse(value);
  if (!usage.success) return undefined;
  const pick = (keys: readonly string[]): number | undefined => {
    for (const key of keys) { const raw = usage.data[key]; if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw); }
    return undefined;
  };
  const input = pick(INPUT_TOKEN_KEYS), output = pick(OUTPUT_TOKEN_KEYS);
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0, cacheRead: pick(CACHE_READ_KEYS) ?? 0, cacheWrite: pick(CACHE_WRITE_KEYS) ?? 0 };
}
/** The host emits no call duration; `llm_input` marks the start per run and `llm_output` closes it. */
const hostCallStartedAt = new Map<string, number>();
const messageSchema = z.object({ role: z.enum(["system", "developer", "user", "assistant", "tool"]), content: z.json(), timestamp: z.union([z.number(), z.string()]).optional(), at: z.number().optional() });
function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    // A request this plugin sent to the host model is not a conversation turn; the contract carries no marker, so drop it here.
    if (isPluginOwnedMessage(item)) return [];
    const parsed = messageSchema.safeParse(item);
    if (!parsed.success) return [];
    const at = parsed.data.at ?? normalizeMessageTimestampMs(parsed.data.timestamp) ?? Date.now();
    return [{ role: parsed.data.role, content: parsed.data.content, at }];
  });
}
const customEvent = z.object({
  sessionKey: z.string(), action: z.enum(["new", "reset"]), timestamp: z.union([z.number(), z.date()]).optional(),
  context: z.object({ workspaceDir: z.string().optional(), previousSessionEntry: z.object({ sessionId: z.string().optional(), sessionFile: z.string().optional() }).optional() }).optional(),
});
const lessonOutput = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) });

async function recallLessons(api: OpenClawPluginApi, context: HostMemoryContext, prompt: string): Promise<string> {
  const command = "sno rem-reflect recall --agent openclaw --first-message";
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("sno", ["rem-reflect", "recall", "--agent", "openclaw", "--first-message"],
        { timeout: 8000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
          if (error) reject(new Error(error.killed ? "Lesson recall timed out after 8 seconds" : stderr.trim() || error.message));
          else resolve(stdout);
        });
      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify({ session_id: context.sessionId ?? context.sessionKey,
        cwd: resolveWorkspace(api.config, context), prompt }));
    });
    const text = stdout.trim();
    return text.startsWith("{") ? lessonOutput.parse(JSON.parse(text)).hookSpecificOutput.additionalContext : text;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    api.logger.warn(`Lesson recall failed: ${command}: ${reason}; continuing memory injection`);
    return "";
  }
}

export function registerRuntimeHooks(api: OpenClawPluginApi, config: PluginConfig | (() => PluginConfig), connection: MemoryConnection, observe: RuntimeObserveController, observability: PluginObservability): void {
  const startedSessions = new Set<string>();
  const lessonSessions = new Map<string, true>();
  const skipStationRun = (context: HostMemoryContext): boolean => {
    if (!context.sessionKey?.includes(":explicit:sno-oneshot-")) return false;
    api.logger.info(`Station one-shot run skipped: session key contains :explicit:sno-oneshot- (${context.sessionKey}); no memory injection, capture or lesson recall`);
    return true;
  };
  const injectionSession = (context: HostMemoryContext): string =>
    JSON.stringify([resolveWorkspace(api.config, context), context.sessionKey ?? context.sessionId]);
  const currentConfig = () => typeof config === "function" ? config() : config;
  api.on("llm_input", async (event) => { hostCallStartedAt.set(event.runId, Date.now()); });
  api.on("llm_output", async (event, context) => {
    const startedAt = hostCallStartedAt.get(event.runId);
    hostCallStartedAt.delete(event.runId);
    // Context identity wins; an event that only carries its own sessionId still binds to the session.
    const lookup = context.sessionId || context.sessionKey ? context : { ...context, ...(event.sessionId ? { sessionId: event.sessionId } : {}) };
    const sessionUuid = observe.lookupActiveObserveSession(lookup);
    if (!sessionUuid) return;
    const usage = hostUsage(event.usage);
    const model = [event.provider, event.model].filter(Boolean).join(":");
    await observability.trackBestEffort("host llm.call", async () => {
      // No usage or no model from the host is an error event, never a zero-token call.
      if (!usage || !model) {
        await observability.emitError("llm.call:usage_missing", `host llm_output run=${event.runId} model=${model || "-"}`, sessionUuid);
        return;
      }
      await observability.emit({ eventType: "llm.call", sessionUuid, payload: { model, prompt_tokens: usage.input, completion_tokens: usage.output, latency_ms: startedAt === undefined ? 0 : Math.max(0, Math.round(Date.now() - startedAt)), cache_read_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite, token_source: "host_agent_paid" } });
    });
  });
  api.on("gateway_start", async () => { await connection.ready(); });
  api.on("before_prompt_build", async (event, context) => {
    if (skipStationRun(context)) return undefined;
    let lessonContext = "";
    if (context.sessionKey && !context.sessionKey.includes(":subagent:")) {
      const firstLessonPrompt = !lessonSessions.has(context.sessionKey);
      setLruEntry(lessonSessions, context.sessionKey, true, 200);
      if (firstLessonPrompt) lessonContext = await recallLessons(api, context, event.prompt);
    }
    const memory = await contained("before_prompt_build", async () => {
      const { recall } = readPluginSettings();
      currentConfig();
      if (!recall.auto || context.sessionKey?.includes(":subagent:")) {
        await observe.startObserveSession(context, event.prompt);
        return undefined;
      }
      const session = injectionSession(context);
      const firstPrompt = !startedSessions.has(session);
      const timeoutMs = firstPrompt ? recall.sessionStart.timeoutMs : recall.prompt.timeoutMs;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        return await Promise.race([
          (async () => {
            await observe.startObserveSession(context, event.prompt);
            signal.throwIfAborted();
            const client = await connection.ready();
            signal.throwIfAborted();
            const originalScope = await connection.scope(context);
            signal.throwIfAborted();
            const scope = { ...originalScope, host: { ...originalScope.host, observeSessionUuid: observe.lookupActiveObserveSession(context) } };
            const recalled = await client.getRecall(event.prompt, scope, {
              source: "auto", injectionPhase: firstPrompt ? "first-prompt" : "prompt",
              ...(firstPrompt ? {} : { limit: recall.prompt.limit, minScore: recall.prompt.minScore,
                maxChars: recall.prompt.maxChars }),
            }, signal);
            signal.throwIfAborted();
            if (recalled.degraded) throw new ContractError(recalled.reason, recalled.error);
            if (recalled.unavailable) throw new ContractError("engine-failed", recalled.unavailable);
            startedSessions.add(session);
            return recalled.contextText ? { prependContext: recalled.contextText } : undefined;
          })(),
          delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
            throw new Error("Memory recall hook timed out");
          }),
        ]);
      } finally { controller.abort(); }
    });
    const prependContext = [memory?.prependContext, lessonContext].filter(Boolean).join("\n\n");
    return prependContext ? { prependContext } : undefined;
  });
  api.on("agent_end", async (event, context) => {
    if (skipStationRun(context)) return;
    // A failed run captures nothing, but its observe session still ends here.
    try {
      if (!event.success || context.sessionKey?.includes(":subagent:")) return;
      await contained("agent_end", async () => {
        const client = await connection.ready();
        const originalScope = await connection.scope(context);
        const scope = { ...originalScope, host: { ...originalScope.host, observeSessionUuid: observe.lookupActiveObserveSession(context) } };
        const captured = messages(event.messages);
        const turnId = createHash("sha256").update(JSON.stringify({ session: scope.session, messages: event.messages })).digest("hex");
        await client.capture({ turnId, rewindEpoch: 0, messages: captured }, scope);
      });
    } finally { await observe.finalizeObserveSession(context, event.durationMs); }
  });
  api.on("before_reset", async (event, context) => {
    if (skipStationRun(context)) return;
    startedSessions.delete(injectionSession(context));
    try {
      await contained("before_reset", async () => {
        const originalScope = await connection.scope(context);
        const scope = { ...originalScope, host: { ...originalScope.host, observeSessionUuid: observe.lookupActiveObserveSession(context) } };
        await (await connection.ready()).onSessionEnd(messages(event.messages), { ...scope,
          host: { ...scope.host, boundary: "reset" } });
      });
    } finally { await observe.finalizeObserveSession(context); }
  });
  api.on("after_compaction", async (_event, context) => {
    if (skipStationRun(context)) return;
    startedSessions.delete(injectionSession(context));
    await contained("after_compaction", async () => {
      const scope = await connection.scope(context);
      await (await connection.ready()).onSessionEnd([], { ...scope,
        host: { ...scope.host, boundary: "reset" } });
    });
  });
  api.on("session_end", async (event, context) => {
    if (skipStationRun(context)) return;
    const sessionId = context.sessionId ?? event.sessionId;
    startedSessions.delete(injectionSession({ ...context, sessionId }));
    try {
      await contained("session_end", async () => {
        const scope = await connection.scope({ ...context, sessionId });
        await (await connection.ready()).onSessionEnd([], { ...scope, host: { ...scope.host, boundary: "session-end" } });
      });
    } finally { await observe.finalizeObserveSession({ sessionId }, event.durationMs); }
  });
  api.on("after_tool_call", async (event, context) => {
    if (skipStationRun(context)) return;
		const skillPath = event.params.path;
		if (event.toolName === "read" && typeof skillPath === "string"
			&& /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(skillPath)) {
			await contained("skill.run", async () => {
				const skillDir = dirname(skillPath);
				const name = basename(skillDir);
				const agentId = resolveAgentId(context.agentId, context.sessionKey?.match(/^agent:([^:]+):/)?.[1]) ?? "main";
				const workspace = resolveAgentWorkspaceDir(api.config, agentId);
				appendObserveLedgerRows(getSnoProfileDir(), [{
					agent_id: "openclaw",
					ts_ms: Date.now(),
					event_type: "skill.run",
					project_id: detectProjectId(workspace),
					lane: "skill",
					payload: {
						harness: "openclaw",
						skill_name: name,
						skill_version: skillVersionFor(skillDir),
						category: SKILL_CATEGORIES[name] ?? "other",
						duration_ms: typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
							? Math.round(event.durationMs) : 0,
						outcome: event.error !== undefined ? "fail" : "ok",
					},
				}]);
			});
		}
    await contained("after_tool_call", async () => {
      if (currentConfig().sessionStrategy !== "memoryReflection") return;
      const originalScope = await connection.scope(context);
      const scope = { ...originalScope, host: { ...originalScope.host, observeSessionUuid: observe.lookupActiveObserveSession(context) } };
      await (await connection.ready()).recordUsage(`tool:${event.toolName}:${Date.now()}`, {
        event: "tool-error", memoryIds: [], toolName: event.toolName,
        error: event.error === undefined ? undefined : z.json().parse(event.error),
        result: event.result === undefined ? undefined : z.json().parse(event.result), at: Date.now(),
      }, scope);
    });
  });
  {
    const onCommand = async (raw: unknown): Promise<void> => {
      const event = customEvent.parse(raw);
      if (skipStationRun(event)) return;
      startedSessions.delete(injectionSession({ sessionKey: event.sessionKey,
        workspaceDir: event.context?.workspaceDir }));
      await contained(`command:${event.action}`, async () => {
        const context: HostMemoryContext = { sessionKey: event.sessionKey, workspaceDir: event.context?.workspaceDir, ...event.context?.previousSessionEntry };
        const scope: ScopeCtx = await connection.scope(context);
        await (await connection.ready()).onSessionEnd([], { ...scope, host: { ...scope.host, boundary: event.action, at: event.timestamp instanceof Date ? event.timestamp.getTime() : event.timestamp } });
      });
    };
    api.registerHook("command:new", onCommand, { name: "mem-claw.memory-reflection.command-new", description: "Generate reflection log before /new" });
    api.registerHook("command:reset", onCommand, { name: "mem-claw.memory-reflection.command-reset", description: "Generate reflection log before /reset" });
  }
}
