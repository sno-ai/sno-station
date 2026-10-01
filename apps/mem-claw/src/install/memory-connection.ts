import { connect, ContractError, type MemoryClient, type ScopeCtx } from "@snoai/memory/client";
import { readDiscovery } from "@snoai/memory/internal/contract/discovery";
import { MEMORY_RECONNECT_INTERVAL_MS } from "@snoai/memory/internal/contract/routes";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveAgentId } from "@snoai/memory/internal/engine/bindings/memory-tool-access";
import {
	HOST_COMMAND_SESSION_ID,
	HOST_REGISTRATION_SESSION_ID,
	SKIN_ID,
} from "../constants";
import { startModelCallback, type ModelCallback } from "./model-callback";
import { readPluginSettings } from "./settings";
export type HostMemoryContext = {
  agentId?: string; sessionKey?: string; sessionId?: string;
  workspaceDir?: string; sessionTimezone?: string; sessionFile?: string;
  gatewayClientScopes?: string[];
};

export interface MemoryConnection {
  ready(): Promise<MemoryClient>;
  scope(context?: HostMemoryContext, project?: string): Promise<ScopeCtx>;
  close(): Promise<void>;
}

// The host's workspace wins; otherwise OpenClaw's own rule for the agent, then the working directory.
export function resolveWorkspace(config: OpenClawConfig, context: HostMemoryContext = {}): string {
  const agentId = resolveAgentId(context.agentId, context.sessionKey?.match(/^agent:([^:]+):/)?.[1]);
  return context.workspaceDir ?? (agentId ? resolveAgentWorkspaceDir(config, agentId) : process.cwd());
}

export function createMemoryConnection(api: OpenClawPluginApi, skinId: string = SKIN_ID): MemoryConnection {
  let callback: ModelCallback | undefined;
  let opening: Promise<MemoryClient> | undefined;
  let client: MemoryClient | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const dropCallback = async (): Promise<void> => { const closing = callback; callback = undefined; await closing?.close(); };
  const open = async (): Promise<MemoryClient> => {
    const connected = await connect({ skinId });
    if (connected.degraded) throw new Error(connected.error ?? connected.reason);
    callback = await startModelCallback(api);
    if (closed) { await dropCallback(); throw new ContractError("sidecar-unreachable"); }
    try {
      await connected.init({ principal: connected.principal, project: "global", session: HOST_REGISTRATION_SESSION_ID }, {
        skinId, model: callback.registration,
      });
    } catch (error) { await dropCallback(); throw error; }
    return connected;
  };
  const ready = async (): Promise<MemoryClient> => {
    readPluginSettings();
    if (closed) throw new ContractError("sidecar-unreachable");
    if (!opening) {
      opening = (async () => {
        // Discovery, callback cleanup and registration belong to the same attempt.
        if (client) {
          const current = await readDiscovery().catch(() => undefined);
          if (current && current.pid === client.pid && current.port === client.port) return client;
          client = undefined;
          await dropCallback();
        }
        const opened = await open();
        client = opened;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        return opened;
      })().catch((error: unknown) => {
        api.logger.error(`Memory service registration failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!closed && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void ready().catch(() => undefined);
          }, MEMORY_RECONNECT_INTERVAL_MS);
          retryTimer.unref();
        }
        throw error;
      }).finally(() => { opening = undefined; });
    }
    return opening;
  };
  return {
    ready,
    async scope(context: HostMemoryContext = {}, project?: string): Promise<ScopeCtx> {
      const client = await ready();
      const agentId = resolveAgentId(context.agentId, context.sessionKey?.match(/^agent:([^:]+):/)?.[1]);
      const workspace = resolveWorkspace(api.config, context);
      return {
        principal: client.principal,
        project: project ?? workspace,
        session: context.sessionKey ?? context.sessionId ?? HOST_COMMAND_SESSION_ID,
        host: { agentId, workspace, sessionKey: context.sessionKey, sessionId: context.sessionId,
          sessionTimezone: context.sessionTimezone, sessionFile: context.sessionFile,
          systemCaller: context.gatewayClientScopes?.includes("operator.admin") ?? false },
      };
    },
    async close(): Promise<void> {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (opening) await opening.catch(() => undefined);
      await dropCallback();
    },
  };
}
