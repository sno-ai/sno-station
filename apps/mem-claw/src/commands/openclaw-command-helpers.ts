import { open, stat } from "node:fs/promises";

import { LAST_JSON_LINE_CHUNK_BYTES } from "@snoai/memory/internal/config/index";
import { parseAgentIdFromSessionKey } from "@snoai/memory/internal/engine/security/scopes";
import { ConfigError } from "@snoai/memory/internal/engine/shared/errors";

type PluginCommandContext = {
	args?: string;
	sessionKey?: string;
	senderId?: string;
	gatewayClientScopes?: string[];
};

/** Formats breakdown for caller output without mutating source data. */
export function formatBreakdown(title: string, values: Record<string, number>): string[] {
	const entries = Object.entries(values);
	// Treat the empty collection as a first-class outcome instead of widening behavior.
	if (entries.length === 0) {
		return [`${title}: none`];
	}
	return [title, ...entries.map(([key, count]) => `- ${key}: ${count}`)];
}

/** Parses clear args into the normalized shape used by plugin command registration. */
export function parseClearArgs(args: string | undefined): {
	all: boolean;
	yes: boolean;
	scope?: string;
	warnings: string[];
} {
	// Guard args?.trim here so the remaining tool execution path works with normalized inputs.
	if (!args?.trim()) {
		return { all: false, yes: false, warnings: [] };
	}
	const tokens = args.trim().split(/\s+/);
	let all = false;
	let yes = false;
	// Compute the normalized scope once so later tool execution checks use one value.
	let scope: string | undefined;
	const warnings: string[] = [];
	// Iterate deterministically so command registration output order remains stable.
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		// Guard token here so the remaining tool execution path works with normalized inputs.
		if (token === "--yes") {
			yes = true;
			continue;
		}
		if (token === "--all") {
			all = true;
			continue;
		}
		// Keep identity and boundary checks ahead of any privileged operation.
		if (token === "--scope") {
			const value = tokens[i + 1];
			// Keep this tool execution predicate close to the branch that owns the match semantics.
			if (!value || value.startsWith("--")) {
				// Surface this invalid command registration state as an explicit typed failure.
				throw new ConfigError("--scope requires a value");
			}
			// This tool execution step establishes state that later reads and cleanup paths depend on.
			scope = value;
			i += 1;
			continue;
		}
		// Keep this tool execution predicate close to the branch that owns the match semantics.
		if (token?.startsWith("--")) {
			warnings.push(`Unknown flag: ${token}`);
		}
	}
	// Return the normalized command registration payload expected by callers.
	return { all, yes, ...(scope ? { scope } : {}), warnings };
}

/** Implements empty tool response as the local plugin command registration operation. */
export function emptyToolResponse(): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {},
	};
}

/** Parses json record into the normalized shape used by plugin command registration. */
function parseJsonRecord(line: string): Record<string, unknown> | null {
	// Guard this branch early so the remaining tool execution path works with normalized inputs.
	if (!line) return null;
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Reads last json line and applies plugin command registration fallback behavior for missing
 * data.
 */
export async function readLastJsonLine(
	filePath: string,
): Promise<Record<string, unknown> | undefined> {
	let fh: Awaited<ReturnType<typeof open>> | undefined;
	try {
		// Await the command registration dependency before deriving downstream state.
		const fileStat = await stat(filePath).catch(() => undefined);
		if (!fileStat || fileStat.size <= 0) return undefined;

		fh = await open(filePath, "r");
		let position = fileStat.size;
		let remainder = "";
		while (position > 0) {
			const chunkSize = Math.min(LAST_JSON_LINE_CHUNK_BYTES, position);
			position -= chunkSize;

			const buffer = Buffer.alloc(chunkSize);
			const { bytesRead } = await fh.read(buffer, 0, chunkSize, position);
			if (bytesRead <= 0) break;

			const chunk = `${buffer.toString("utf-8", 0, bytesRead)}${remainder}`;
			const lines = chunk.split("\n");
			remainder = lines.shift() ?? "";

			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const parsed = parseJsonRecord(lines[index]?.trim() ?? "");
				if (parsed) return parsed;
			}
		}

		return parseJsonRecord(remainder.trim()) ?? undefined;
	} catch {
		return undefined;
	} finally {
		// Await the command registration dependency before deriving downstream state.
		await fh?.close().catch(() => {});
	}
}

export function commandAgentId(ctx: PluginCommandContext): string | undefined {
	return parseAgentIdFromSessionKey(ctx.sessionKey);
}

export function isSystemCommandCaller(ctx: PluginCommandContext): boolean {
	return ctx.gatewayClientScopes?.includes("operator.admin") === true;
}

