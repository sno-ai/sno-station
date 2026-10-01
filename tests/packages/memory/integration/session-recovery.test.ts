/** Pure-function session recovery utilities. No DB, no embeddings. */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	resolveReflectionSessionSearchDirs,
	stripResetSuffix,
} from "../../../../packages/memory/src/engine/operations/session-summary-storage.ts";

/**
 * Session recovery path utilities — integration tests.
 *
 * Validates stripResetSuffix and resolveReflectionSessionSearchDirs behaviour
 * as specified in:
 *   openspec/changes/mem-claw-catchup/specs/session-recovery/spec.md
 *     - "stripResetSuffix utility" (scenarios 1-2)
 *     - "Multi-directory session search" (scenarios 1-5)
 */

// ── stripResetSuffix ──────────────────────────────────────────────────

describe("stripResetSuffix", () => {
	it("removes .reset.* suffix from session file name", () => {
		const result = stripResetSuffix("session.jsonl.reset.1700000000");

		expect(result).toBe("session.jsonl");
	});

	it("returns the original name when no reset suffix is present", () => {
		const result = stripResetSuffix("session.jsonl");

		expect(result).toBe("session.jsonl");
	});
});

// ── resolveReflectionSessionSearchDirs ────────────────────────────────

describe("resolveReflectionSessionSearchDirs", () => {
	it("includes agent-specific workspace dirs from config", () => {
		const cfg = {
			agents: {
				defaults: { workspace: "/root/.openclaw/workspace" },
				list: [
					{ id: "main" },
					{ id: "theia", workspace: "/root/.openclaw/workspace/agents/theia" },
				],
			},
		};

		const dirs = resolveReflectionSessionSearchDirs({
			context: { sessionEntry: { sessionId: "s-1" } },
			cfg,
			workspaceDir: "/root/.openclaw/workspace",
			currentSessionFile: undefined,
			sourceAgentId: "theia",
		});

		expect(dirs).toContain(
			join("/root/.openclaw", "agents", "theia", "sessions"),
		);
	});

	it("includes workspace/sessions fallback", () => {
		const cfg = {
			agents: {
				defaults: { workspace: "/root/.openclaw/workspace" },
				list: [{ id: "main" }],
			},
		};

		const dirs = resolveReflectionSessionSearchDirs({
			context: {},
			cfg,
			workspaceDir: "/root/.openclaw/workspace",
			currentSessionFile: undefined,
			sourceAgentId: "main",
		});

		expect(dirs).toContain(
			join("/root/.openclaw/workspace", "sessions"),
		);
	});

	it("derives SNO_STATION_MEM_HOME from sessionFile path when workspaceDir is unrelated", () => {
		const dirs = resolveReflectionSessionSearchDirs({
			context: {
				previousSessionEntry: {
					sessionFile:
						"/root/.openclaw/agents/main/sessions/abc123.jsonl.reset.1730000000",
				},
			},
			cfg: {},
			workspaceDir: "/tmp/custom-workspace",
			currentSessionFile: undefined,
			sourceAgentId: "main",
		});

		expect(dirs).toContain(
			join("/root/.openclaw", "agents", "main", "sessions"),
		);
	});

	it("deduplicates paths", () => {
		const cfg = {
			agents: {
				defaults: { workspace: "/root/.openclaw/workspace" },
				list: [
					{ id: "main" },
					// Second entry with same workspace — should not produce duplicate dirs
					{ id: "main", workspace: "/root/.openclaw/workspace" },
				],
			},
		};

		const dirs = resolveReflectionSessionSearchDirs({
			context: {},
			cfg,
			workspaceDir: "/root/.openclaw/workspace",
			currentSessionFile: undefined,
			sourceAgentId: "main",
		});

		const unique = new Set(dirs);
		expect(dirs.length).toBe(unique.size);
	});

	it("includes 'main' agent as fallback even when sourceAgentId differs", () => {
		const dirs = resolveReflectionSessionSearchDirs({
			context: {},
			cfg: {
				agents: {
					defaults: { workspace: "/root/.openclaw/workspace" },
					list: [],
				},
			},
			workspaceDir: "/root/.openclaw/workspace",
			currentSessionFile: undefined,
			sourceAgentId: "theia",
		});

		// "main" is always added as a fallback agent ID
		expect(dirs).toContain(
			join("/root/.openclaw", "agents", "main", "sessions"),
		);
	});

	it("handles empty/missing config gracefully", () => {
		const dirs = resolveReflectionSessionSearchDirs({
			context: {},
			cfg: {},
			workspaceDir: "/tmp/workspace",
			currentSessionFile: undefined,
			sourceAgentId: undefined,
		});

		// Should not throw — returns at least the workspace/sessions fallback
		expect(Array.isArray(dirs)).toBe(true);
		expect(dirs).toContain(join("/tmp/workspace", "sessions"));
		// "main" is always added as fallback
		expect(dirs.some((d) => d.includes("main"))).toBe(true);
	});
});
