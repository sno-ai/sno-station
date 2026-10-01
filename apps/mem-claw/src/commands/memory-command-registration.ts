import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { format } from "node:util";
import type { Command } from "commander";
import { ContractError, type JsonValue } from "@snoai/memory/client";
import { DEFAULT_LIST_LIMIT, DEFAULT_SCOPE, DEFAULT_TOP_K, MAX_LIST_LIMIT } from "@snoai/memory/internal/config/index";
import { confirmDestructiveAction, parseCategory, serializeEntry } from "@snoai/memory/internal/engine/bindings/memory-cli-shared";
import type { MemoryConnection } from "../install/memory-connection";
import cliMessages from "../i18n/en.json" with { type: "json" };
export interface CliContext { connection: MemoryConnection; stateDir: string }
const operator = { gatewayClientScopes: ["operator.admin"] };

type ImportRow = { text: string; category?: "episodic" | "profile"; importance?: number; metadata?: Record<string, JsonValue>; scope?: string };
/** One exported JSONL row; anything the store contract cannot take is skipped, never guessed. */
function parseImportRow(line: string): ImportRow | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const row = parsed as Record<string, unknown>;
  if (typeof row.text !== "string" || !row.text.trim()) return undefined;
  const category = row.category === "episodic" || row.category === "profile" ? row.category : undefined;
  if (row.category !== undefined && category === undefined) return undefined;
  const metadata = typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata as Record<string, JsonValue> : undefined;
  return { text: row.text, category, importance: typeof row.importance === "number" ? row.importance : undefined, metadata, scope: typeof row.scope === "string" ? row.scope : undefined };
}

export function sidecarRequired(): never { throw new Error("sidecar-required: this offline maintenance operation is not exposed by the memory HTTP contract"); }
export function registerCommands(program: Command, ctx: CliContext): Command {
  const memory = program.command("sno-mem").description("Memory management commands");
  memory.command("list").option("--scope <scope>", "Scope filter", DEFAULT_SCOPE).option("--category <category>", "Category filter")
    .option("--limit <limit>", "Limit", String(DEFAULT_LIST_LIMIT)).option("--offset <offset>", "Offset", "0")
    .action(async (options: Record<string, string>) => {
      const client = await ctx.connection.ready(), scope = await ctx.connection.scope(operator, options.scope);
      const result = await client.inspect({ op: "list", category: parseCategory(options.category), limit: Math.max(1, Math.min(MAX_LIST_LIMIT, Number(options.limit))), offset: Math.max(0, Number(options.offset)) }, scope);
      if (result.degraded) throw new ContractError(result.reason);
      if (result.result.op !== "list") throw new ContractError("engine-failed");
      if (!result.result.entries.length) console.log(format(cliMessages.noMemoriesInScope, scope.project));
      for (const entry of result.result.entries) console.log(`${entry.id} [${entry.category}:${entry.projectId}] ${entry.text}`);
    });
  memory.command("search <query>").option("--scope <scope>", "Scope filter").option("--limit <limit>", "Limit", String(DEFAULT_TOP_K))
    .action(async (query: string, options: Record<string, string>) => {
      const result = await (await ctx.connection.ready()).getRecall(query, await ctx.connection.scope(operator, options.scope ?? DEFAULT_SCOPE), { source: "manual", limit: Math.max(1, Math.min(20, Number(options.limit))) });
      if (result.degraded) throw new ContractError(result.reason);
      console.log(result.contextText || "No relevant memories found.");
    });
  memory.command("stats").option("--scope <scope>", "Scope filter").action(async (options: Record<string, string>) => {
    const result = await (await ctx.connection.ready()).inspect({ op: "stats", scope: options.scope }, await ctx.connection.scope(operator, options.scope ?? DEFAULT_SCOPE));
    if (result.degraded) throw new ContractError(result.reason);
    console.log(JSON.stringify(result.result, null, 2));
  });
  memory.command("delete").option("--id <id>", "Delete by memory id").option("--query <query>", "Delete by search query")
    .option("--scope <scope>", "Scope filter for query mode").option("--yes", "Bypass confirmation")
    .action(async (options: { id?: string; query?: string; scope?: string; yes?: boolean }) => {
      const client = await ctx.connection.ready(), scope = await ctx.connection.scope(operator, options.scope ?? DEFAULT_SCOPE);
      if (!options.id && !options.query) throw new ContractError("invalid-input");
      if (!options.yes && options.id) {
        const preview = await client.inspect({ op: "get", id: options.id }, scope);
        if (preview.degraded) throw new ContractError(preview.reason);
        if (preview.result.op !== "get") throw new ContractError("engine-failed");
        if (!preview.result.entry) { console.log("No memories found."); return; }
        console.log(`Will delete: ${preview.result.entry.id} ${preview.result.entry.text}`);
      }
      if (!options.yes && !await confirmDestructiveAction("Delete matching memories? [y/N] ")) { console.log("Deletion cancelled."); return; }
      const result = await client.mutate({ op: "forget", id: options.id, query: options.query, confirm: true }, scope);
      const deletedCount = result.result.details?.deletedCount;
      if (result.result.isError) { console.log(result.result.content.map(part => part.text).join("\n")); return; }
      console.log(typeof deletedCount === "number" ? format(cliMessages.deletedMemories, deletedCount) : cliMessages.noMatchingMemories);
    });
  memory.command("export").requiredOption("--scope <scope>", "Project whose memories to export").option("--output <file>", "Output file path")
    .action(async (options: Record<string, string>) => {
      const client = await ctx.connection.ready(), scope = await ctx.connection.scope(operator, options.scope ?? DEFAULT_SCOPE);
      const file = options.output ? createWriteStream(options.output) : undefined;
      try {
        for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
          const result = await client.inspect({ op: "list", limit: MAX_LIST_LIMIT, offset }, scope);
          if (result.degraded) throw new ContractError(result.reason);
          if (result.result.op !== "list") throw new ContractError("engine-failed");
          for (const entry of result.result.entries) (file ?? process.stdout).write(`${JSON.stringify(serializeEntry(entry))}\n`);
          if (result.result.entries.length < MAX_LIST_LIMIT) break;
        }
      } finally { if (file) { file.end(); await finished(file); } }
      if (options.output) console.log(format(cliMessages.exportedTo, options.output));
    });
  memory.command("import <file>").description("Store every JSONL row through the memory contract")
    .option("--scope <scope>", "Scope for rows that carry none").option("--force", "Accepted for older callers; the store already deduplicates")
    .action(async (file: string, options: { scope?: string; force?: boolean }) => {
      const client = await ctx.connection.ready();
      const counts = { processed: 0, imported: 0, skipped: 0, errors: 0 };
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })) {
        if (!line.trim()) continue;
        counts.processed += 1;
        const row = parseImportRow(line);
        if (!row) { counts.skipped += 1; continue; }
        try {
          const result = await client.mutate({ op: "store", content: row.text, category: row.category, importance: row.importance, metadata: row.metadata },
            await ctx.connection.scope(operator, row.scope ?? options.scope ?? DEFAULT_SCOPE));
          if (result.result.isError) counts.errors += 1; else counts.imported += 1;
        } catch { counts.errors += 1; }
      }
      console.log(format(cliMessages.importComplete, counts.processed, counts.imported, counts.skipped, counts.errors));
    });
  for (const command of ["atomic-cutover", "atomic-rebuild-index", "receipt <fact_id>", "provenance <fact_id>", "usage", "trace <session_uuid> <turn_id>", "epoch-report <epoch_id>", "purge-preview <fact_id>", "purge <fact_id>"]) {
    memory.command(command).description("Offline maintenance: sidecar-required").allowUnknownOption().action(sidecarRequired);
  }
  return memory;
}
