import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveReflectionSessionSearchDirs } from "../../../../packages/memory/src/engine/operations/session-reflection-discovery";

const originalOpenClawHome = process.env.SNO_STATION_MEM_HOME;

afterEach(() => {
	if (originalOpenClawHome === undefined) {
		delete process.env.SNO_STATION_MEM_HOME;
		return;
	}
	process.env.SNO_STATION_MEM_HOME = originalOpenClawHome;
});

describe("reflection session discovery", () => {
	it("resolves session directories in stable ordered fallback order with duplicate collapse", () => {
		process.env.SNO_STATION_MEM_HOME = "/env/openclaw";

		const currentSessionFile =
			"/current/openclaw/agents/source-agent/sessions/current.json";
		const previousSessionFile =
			"/previous/openclaw/agents/previous-agent/sessions/prev.json";
		const dirs = resolveReflectionSessionSearchDirs({
			workspaceDir: "/workspace/openclaw/workspace/project-a",
			currentSessionFile,
			sourceAgentId: "source-agent",
			context: {
				agentId: "context-agent",
				previousSessionEntry: {
					sessionFile: previousSessionFile,
					sessionsDir: "/explicit/previous/sessions",
					sessionDir: "/explicit/previous/session-dir",
					agentId: "previous-agent",
				},
				sessionEntry: {
					sessionFile: previousSessionFile,
					sessionsDir: "/explicit/previous/sessions",
					agentId: "unsafe/current",
				},
			},
			cfg: {
				agents: {
					defaults: {
						workspace: "/default/openclaw/workspace/default-project",
					},
					list: [
						{
							id: "configured-agent",
							workspace: "/configured/openclaw/workspace/configured-project",
						},
						{ id: "configured-agent" },
						{ id: "bad\\agent" },
					],
				},
			},
		});

		const explicitDirs = [
			dirname(currentSessionFile),
			dirname(previousSessionFile),
			"/explicit/previous/sessions",
			"/explicit/previous/session-dir",
			join("/workspace/openclaw/workspace/project-a", "sessions"),
		];
		const homes = [
			"/env/openclaw",
			"/current/openclaw",
			"/previous/openclaw",
			"/default/openclaw",
			"/configured/openclaw",
		];
		const agentIds = [
			"source-agent",
			"context-agent",
			"previous-agent",
			"configured-agent",
			"main",
		];
		const derivedDirs = homes.flatMap((home) =>
			agentIds.map((agentId) => join(home, "agents", agentId, "sessions")),
		);
		const expectedDirs = [...explicitDirs, ...derivedDirs].filter(
			(dir, index, all) => all.indexOf(dir) === index,
		);

		expect(dirs).toEqual(expectedDirs);
		expect(new Set(dirs).size).toBe(dirs.length);
		expect(dirs.some((dir) => dir.includes("unsafe"))).toBe(false);
		expect(dirs.some((dir) => dir.includes("bad\\agent"))).toBe(false);
	});

	it("rejects dot-segment agent ids before deriving agent session directories", () => {
		process.env.SNO_STATION_MEM_HOME = "/safe/openclaw";

		const dirs = resolveReflectionSessionSearchDirs({
			workspaceDir: "/workspace/project",
			sourceAgentId: "..",
			context: {
				agentId: ".",
				sessionEntry: { agentId: "valid-agent" },
			},
			cfg: {
				agents: {
					list: [{ id: ".." }, { id: "." }, { id: "configured-agent" }],
				},
			},
		});

		expect(dirs).toContain(
			join("/safe/openclaw", "agents", "valid-agent", "sessions"),
		);
		expect(dirs).toContain(
			join("/safe/openclaw", "agents", "configured-agent", "sessions"),
		);
		expect(dirs).toContain(
			join("/safe/openclaw", "agents", "main", "sessions"),
		);
		expect(dirs).not.toContain(join("/safe/openclaw", "sessions"));
		expect(dirs).not.toContain(join("/safe/openclaw", "agents", "sessions"));
	});

	it("falls back to workspace sessions and main agent when optional context is empty", () => {
		delete process.env.SNO_STATION_MEM_HOME;

		const dirs = resolveReflectionSessionSearchDirs({
			workspaceDir: "/solo/openclaw/workspace/project-b",
			context: {},
			cfg: {},
		});

		expect(dirs).toEqual([
			join("/solo/openclaw/workspace/project-b", "sessions"),
			join("/solo/openclaw", "agents", "main", "sessions"),
		]);
	});
});
