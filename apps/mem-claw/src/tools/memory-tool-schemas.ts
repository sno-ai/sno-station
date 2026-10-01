import type { Locale } from "./memory-tool-dependencies";
export type { ToolResult } from "@snoai/memory/internal/engine/bindings/memory-tool-schemas";
import type { MemoryConnection } from "../install/memory-connection";
export interface ToolContext {
  connection: MemoryConnection;
  stateDir: string;
  workspaceDir?: string;
  agentId?: string;
  language?: Locale;
}
