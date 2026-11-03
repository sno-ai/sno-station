import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeAgentEvent } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClaude } from "../../../apps/mem-claude/src/install.ts";
import { installCursor } from "../../../apps/mem-cursor/src/install.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "agent-statusline-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("agent state view composed command", () => {
	for (const harness of ["claude", "cursor"] as const) {
		it(`${harness} excludes its own status-line session_id from real computed waits`, async () => {
			const profile = join(home, "profile");
			const script = join(home, "user.mjs");
			await writeFile(script, "import {readFileSync} from 'node:fs'; process.stdout.write(Buffer.concat([Buffer.from('\\x1b[31muser  '),readFileSync(0),Buffer.from('  \\x1b[0m\\r\\n')]));");
			const settingsPath = join(home, harness === "claude" ? "settings.json" : "cli-config.json");
			await writeFile(settingsPath, JSON.stringify({ statusLine: { type: "command", command: `'${process.execPath}' '${script}'` } }));
			const previous = process.env.SNO_PROFILE_DIR;
			process.env.SNO_PROFILE_DIR = profile;
			try {
				for (const session of ["current", "other"]) {
					await observeAgentEvent(harness, "permission-request", harness === "cursor" ? { conversation_id: session } : { session_id: session });
				}
			} finally {
				if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
				else process.env.SNO_PROFILE_DIR = previous;
			}
			if (harness === "claude") await installClaude({ configDir: home, programPath: "/opt/sno/bin/sno", writeOutput: () => {} });
			else await installCursor({ cursorHome: home, programPath: "/opt/sno/bin/sno", writeOutput: () => {} });
			const settings = JSON.parse(await readFile(settingsPath, "utf8"));
			const input = JSON.stringify({ session_id: "current" });
			const env = { ...process.env, SNO_PROFILE_DIR: profile, SNO_REACH_ROOT: join(home, "reach") };
			delete env.NO_COLOR;
			const result = spawnSync("sh", ["-c", settings.statusLine.command], { input, encoding: "utf8", env, timeout: 10_000 });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain(`\x1b[31muser  ${input}  \x1b[0m | \x1b[1;33m❄ `);
			expect(result.stdout).toContain("1 need you");
			expect(result.stdout).not.toContain("2 need you");
			if (harness === "claude") {
				const plain = spawnSync("sh", ["-c", settings.statusLine.command], { input, encoding: "utf8", env: { ...env, NO_COLOR: "1" }, timeout: 10_000 });
				expect(plain.status, plain.stderr).toBe(0);
				expect(plain.stdout).toContain(`\x1b[31muser  ${input}  \x1b[0m | ❄ 1 need you`);
			}
		});

		it(`${harness} preserves raw input, output colors and spaces when Sno cannot render`, async () => {
			const script = join(home, "user.mjs");
			await writeFile(script, "import {readFileSync} from 'node:fs'; process.stdout.write(Buffer.concat([Buffer.from('\\x1b[31muser  '),readFileSync(0),Buffer.from('  \\x1b[0m\\r\\n')]));");
			const settingsPath = join(home, harness === "claude" ? "settings.json" : "cli-config.json");
			await writeFile(settingsPath, JSON.stringify({ statusLine: { type: "command", command: `'${process.execPath}' '${script}'` } }));
			if (harness === "claude") await installClaude({ configDir: home, programPath: "/opt/sno/bin/sno", writeOutput: () => {} });
			else await installCursor({ cursorHome: home, programPath: "/opt/sno/bin/sno", writeOutput: () => {} });
			const settings = JSON.parse(await readFile(settingsPath, "utf8"));
			const input = "invalid JSON input  \n";
			const result = spawnSync("sh", ["-c", settings.statusLine.command], { input, env: { ...process.env, SNO_PROFILE_DIR: home }, timeout: 10_000 });
			expect(result.status, result.stderr.toString()).toBe(0);
			expect(result.stdout).toEqual(Buffer.from(`\x1b[31muser  ${input}  \x1b[0m\r\n`));
			expect(result.stderr.toString()).toContain("agent-state-status-line");
		});
	}
});
