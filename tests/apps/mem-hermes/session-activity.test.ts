import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hermes-activity-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(prompt: string, fail = false): { status: number | null; stderr: string; rows: unknown[] } {
	writeFileSync(join(root, "sno"), `#!/usr/bin/env python3\nimport json, os, sys\n${fail ? 'sys.stderr.write("ledger unavailable"); sys.exit(1)' : 'with open(os.environ["ACTIVITY_OUTPUT"], "a") as output: output.write(json.dumps(sys.argv[1:]) + "\\n")'}\n`, { mode: 0o755 });
	const result = spawnSync("python3", ["-c", `
import importlib.util, json, sys, types
from dataclasses import dataclass
from unittest.mock import patch
# Only the external Hermes interfaces are substituted; the plugin and CLI process are real.
agent = types.ModuleType("agent")
memory = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    def on_turn_start(self, *args, **kwargs): pass
memory.MemoryProvider = MemoryProvider
@dataclass
class RecallStatus:
    provider_label: str
    count: int
memory.RecallStatus = RecallStatus
sys.modules["agent"] = agent
sys.modules["agent.memory_provider"] = memory
hermes = types.ModuleType("hermes_constants")
from pathlib import Path
hermes.get_hermes_home = lambda: Path(sys.argv[2])
sys.modules["hermes_constants"] = hermes
spec = importlib.util.spec_from_file_location("hermes_activity", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
provider = module.SnoMemoryProvider()
provider._session_id = "session-a"
provider._primary = True
provider._cwd = sys.argv[2]
class OfflineClient:
    def post(self, *args, **kwargs): raise OSError("memory offline")
provider._client = OfflineClient()
with patch("time.time", return_value=1800000000):
    provider.on_turn_start(1, sys.argv[3])
with patch("time.time", return_value=1800000060):
    provider.sync_turn(sys.argv[3], "Done")
print("turn completed")
`, resolve("apps/mem-hermes/sno-mem-hermes/__init__.py"), root, prompt], {
		env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ACTIVITY_OUTPUT: join(root, "rows.jsonl") }, encoding: "utf8", timeout: 10_000,
	});
	let rows: unknown[] = [];
	try { rows = readFileSync(join(root, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { /* No append is the regression. */ }
	return { status: result.status, stderr: result.stderr, rows };
}
it.each([
	["Fix the failing command", "0", "1"],
	["typed by the mail transport, not by the owner", "60000", "0"],
	["2026-10-10T01:00:00Z [task] tick=1", "60000", "0"],
])("records Hermes activity for %s", (prompt, team, human) => {
	const result = run(prompt);
	expect(result.status).toBe(0);
	expect(result.rows).toEqual([[
		"observe", "append", "session.activity", "--agent=hermes", "--harness=hermes",
		"--window_start_ms=1800000000000", "--window_end_ms=1800000060000", "--active_ms=60000",
		`--team_driven_ms=${team}`, "--runs_over_12h=0", "--longest_run_ms=60000", `--human_messages=${human}`,
	]]);
});
it("logs a failed append and continues the turn", () => {
	const result = run("Fix the command", true);
	expect(result.status).toBe(0);
	expect(result.rows).toEqual([]);
	expect(result.stderr).toContain("session-activity");
	expect(result.stderr).toContain("ledger unavailable");
	expect(result.stderr).toContain("no session.activity row");
});
