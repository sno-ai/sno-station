import { PluginObservability } from "@snoai/memory/internal/engine/observability/adapter";
import { readNamedPackageVersion } from "@snoai/memory/internal/engine/observability/version-metadata";
import { dirname } from "node:path";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { createRuntimeObservabilityController } from "../hooks/openclaw-observe-controller";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { pluginConfigSchema } from "@snoai/memory/internal/config/plugin-config-schema";
import { readPluginSettings } from "./settings";
import { getStateDir } from "@snoai/memory/internal/contract/profile";
import { registerCommands } from "../commands/memory-command-registration";
import { getSnoStationMemStateDir } from "@snoai/memory/internal/engine/operations/runtime-audit-log";
import { createMemoryConnection, type MemoryConnection } from "./memory-connection";
import { registerAllMemoryTools } from "../tools/memory-tool-registration";
import { registerSnoStationMemProviderCapability } from "../tools/provider-registration";
import { registerRuntimeHooks } from "../hooks/openclaw-runtime-hooks";
import { APP_NAME, SKIN_ID } from "../constants";

const connections = new WeakMap<OpenClawPluginApi, MemoryConnection>();
export function registerRuntime(api: OpenClawPluginApi): void {
  if (connections.has(api)) return;
  const stateDir = getSnoStationMemStateDir();
  // The plugin runs inside the gateway process, so the host's own manifest sits above its entry file.
  const agentVersion = process.argv[1] ? readNamedPackageVersion(dirname(process.argv[1]), "openclaw") : undefined;
  let active: { config: ReturnType<typeof pluginConfigSchema.parse>; observability: PluginObservability } | undefined;
  const runtime = () => {
    if (active) return active;
    const settings = readPluginSettings();
    const config = pluginConfigSchema.parse({
      language: settings.user.language, observe: settings.telemetry.observe,
      sessionStrategy: settings.capture.sessionStrategy, sessionMemory: settings.capture.sessionMemory,
      captureAssistant: settings.capture.assistant, ambientLearning: settings.capture.ambient,
      autoRecall: settings.recall.auto, autoRecallTimeoutMs: settings.recall.prompt.timeoutMs,
      autoRecallMinLength: settings.recall.prompt.minChars,
      retrieval: { recallTopK: settings.recall.prompt.limit, minScore: settings.recall.prompt.minScore },
    });
    active = { config, observability: new PluginObservability(
      config, stateDir, api.logger, agentVersion ? { agentVersion } : {}, settings.telemetry.redactionRules,
    ) };
    return active;
  };
  const registrationConfig = pluginConfigSchema.parse({ observe: { enabled: false } });
  const unavailableObservability = new PluginObservability(registrationConfig, stateDir, api.logger);
  const observability = new Proxy(unavailableObservability, {
    get(target, key) {
      const source = active?.observability ?? target;
      const value = Reflect.get(source, key, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
  const connection = createMemoryConnection(api);
  const ready = connection.ready;
  connection.ready = async () => { runtime(); return ready(); };
  connections.set(api, connection);
  const observe = createRuntimeObservabilityController({ api, config: registrationConfig, stateDir, observability });
  const toolContext = { connection, stateDir, get language() { return active?.config.language; } };
  registerAllMemoryTools(observe.observedApi, toolContext);
  api.registerCli(({ program }) => {
    const hostState = resolveStateDir();
    const profileDir = path.join(path.dirname(hostState), path.basename(hostState).replace(/^\.openclaw(?=-|$)/, ".sno"));
    registerCommands(program, { connection: createMemoryConnection(api, "mem-claw-cli"), stateDir })
      .hook("preAction", () => { process.env.SNO_PROFILE_DIR = getStateDir(profileDir); });
  }, { commands: ["sno-mem"] });
  registerRuntimeHooks(api, () => runtime().config, connection, observe, observability);
  if (api.config.plugins?.slots?.memory === APP_NAME) registerSnoStationMemProviderCapability({ api: observe.observedApi, connection });
  api.registerService({
    id: SKIN_ID,
    async start(): Promise<void> { await connection.ready(); },
    async stop(): Promise<void> { await connection.close(); await active?.observability.shutdown(); connections.delete(api); },
  });
}
