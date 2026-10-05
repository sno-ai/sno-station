/** The installed Codex CLI emits child identities; the real plugin suppresses their memory hooks. */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCodex } from "../../../../apps/mem-codex/src/install";
import { createTestEmbedder } from "../../mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { globalPrefixWith, realSno } from "../../support/real-sno.mjs";
import { verifyInstalledChildHooks } from "./verify-installed-child-hooks.mjs";

const repo = resolve(import.meta.dirname, "../../../..");
const ownedProcesses = new Set<ChildProcess>();
let ownedFixture: Awaited<ReturnType<typeof createMemUpdateFixture>> | undefined;

afterEach(async () => {
	await Promise.all([...ownedProcesses].map(async child => {
		const pid = child.pid;
		if (!pid || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve, reject) => {
			child.once("exit", () => resolve());
			try { process.kill(-pid, "SIGTERM"); }
			catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ESRCH") resolve();
				else reject(error);
			}
		});
	}));
	ownedProcesses.clear();
	await ownedFixture?.close();
	ownedFixture = undefined;
});

async function codex(args: string[], env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
		const child = spawn("codex", args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		ownedProcesses.add(child);
		let output = "", error = "";
		child.stdout.on("data", part => { output += part; });
		child.stderr.on("data", part => { error += part; });
		child.on("error", cause => { ownedProcesses.delete(child); reject(cause); });
		child.on("exit", code => { ownedProcesses.delete(child); resolve({ code, output, error }); });
	});
}

describe("installed Codex child hook boundary", () => {
	it("receives a real agent_id and skips child auto recall and ambient capture", { timeout: 300_000 }, async () => {
		const fixture = await createMemUpdateFixture(await createTestEmbedder(), {
			capture: { ambient: true },
			recall: { sessionStart: { timeoutMs: 60_000 }, prompt: { minChars: 1, minScore: 0, timeoutMs: 60_000 } },
		});
		ownedFixture = fixture;
		const home = join(fixture.profile, "codex-home"), workspace = join(fixture.profile, "workspace");
		const capture = join(fixture.profile, "installed-hooks.jsonl"), wrapper = join(home, "sno");
		mkdirSync(home); mkdirSync(workspace);
		writeFileSync(join(home, "config.toml"), [
			'model = "gpt-6-sol"', 'model_reasoning_effort = "low"', 'model_provider = "ccproxy"',
			'sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
			'[features]', 'multi_agent = true', 'hooks = true', '[model_providers.ccproxy]',
			'name = "ccproxy"', 'base_url = "http://localhost:8070/codex/v1"',
			'wire_api = "responses"', 'requires_openai_auth = false', '',
		].join("\n"));
		copyFileSync(join(repo, "tests/apps/mem-codex/fixtures/capture-installed-hook.mjs"), wrapper);
		chmodSync(wrapper, 0o700);
		// The hook program is a recording tee that runs the real `sno` with the same arguments.
		await installCodex({ codexHome: home, programPath: wrapper, writeOutput() {} });
		const env = { ...process.env, CODEX_HOME: home, SNO_MEM_UPDATE_CAPTURE_FILE: capture,
			SNO_BINARY: realSno(),
			npm_config_prefix: globalPrefixWith({ "@snoai/mem-codex": join(repo, "apps/mem-codex") }) };
		{
			const live = await codex(["exec", "--json", "--ephemeral", "--disable", "hooks",
				"--skip-git-repo-check", "-C", workspace, "Reply exactly LIVE_SEED_OK."], env);
			expect(live.code, live.error || live.output).toBe(0);
			expect(live.output).toContain("LIVE_SEED_OK");
			expect(live.output).not.toMatch(/401|authentication failed/i);
			await fixture.store.store({ text: "The installed child probe must use current memory correctly.", category: "episodic", projectId: "global" });
			const run = await codex(["exec", "--json", "--skip-git-repo-check", "-C", workspace,
				"This is an installed hook observation test. Use spawn_agent exactly once to create a child. Give it this task: Run the shell command printf installed-child-probe, then answer CHILD_COMPLETE. Do not spawn another agent. Wait for CHILD_COMPLETE. Then use send_input once to send that same child: Run printf installed-child-followup, then answer CHILD_FOLLOWUP. Wait for the follow-up result and reply CHILD_FOLLOWUP. You must create the child and send the follow-up; do not perform its tasks yourself. Do not write, edit, or delete files and do not use explicit memory actions."], env);
			expect(run.code, run.error || run.output).toBe(0);
			const hooks = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
			writeFileSync("/tmp/mem-update-codex-child-payload.json", JSON.stringify({ output: run.output, hooks, runExitCode: run.code }, null, 2));
			const spoolDirectory = join(fixture.profile, "sno-mem-codex", "spool");
			const spools = (existsSync(spoolDirectory) ? readdirSync(spoolDirectory) : [])
				.filter(name => name.endsWith(".json"))
				.map(name => JSON.parse(readFileSync(join(fixture.profile, "sno-mem-codex", "spool", name), "utf8")));
			const evidence = { output: run.output, hooks, spools, runExitCode: run.code, executable: "codex",
				liveConfiguration: { model: "gpt-6-sol", endpoint: "http://localhost:8070/codex/v1", home }, liveResponseAccepted: true };
			writeFileSync(process.env.SNO_MEM_UPDATE_CHILD_EVIDENCE ?? "/tmp/mem-update-codex-child-proof.json", JSON.stringify(evidence, null, 2));
			verifyInstalledChildHooks(evidence);
		}
	});
});
