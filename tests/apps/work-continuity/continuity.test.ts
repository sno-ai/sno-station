import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClaude } from "../../../apps/mem-claude/src/install";
import { installCodex } from "../../../apps/mem-codex/src/install";
import { composeContinuityContext, continuityBriefPath } from "../../../packages/memory/config/work-continuity";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repo = resolve(import.meta.dirname, "../../..");
const skills = resolve(repo, "../sno-station-skills-core/skills");
const lessonCommand = join(skills, "R-recursive-self-improvement/rem-reflect/skill/scripts/rem-reflect.ts");
const checkpoint = join(skills, "S-communication-and-handoff/handoff/skill/scripts/handoff-checkpoint");
let root: string;
let profile: string;
let store: string;
let workspace: string;
let program: string;

function git(directory: string, args: string[]): void {
	execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-continuity-"));
	profile = join(root, "profile"); store = join(root, "experience"); workspace = join(root, "workspace");
	mkdirSync(workspace);
	git(workspace, ["init", "--quiet"]);
	git(workspace, ["remote", "add", "origin", "https://github.com/example/continuity.git"]);
	git(workspace, ["-c", "user.name=Continuity fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
	mkdirSync(join(store, "wiki"), { recursive: true });
	mkdirSync(join(store, "ledger"));
	writeFileSync(join(store, "config.json"), JSON.stringify({
		claude_home: join(root, ".claude"), codex_home: join(root, ".codex"),
		hermes_home: join(root, ".hermes"), openclaw_home: join(root, ".openclaw"),
		claude_root: join(root, "claude-sessions"), codex_root: join(root, "codex-sessions"),
		project_names: {}, time_zone: "UTC",
	}));
	writeFileSync(join(store, "wiki/lessons.jsonl"), "");
	writeFileSync(join(store, "ledger/usage.jsonl"), "");
	git(store, ["init", "--quiet"]);
	git(store, ["config", "user.name", "Continuity fixture"]);
	git(store, ["config", "user.email", "fixture@example.com"]);
	git(store, ["add", "config.json", "wiki/lessons.jsonl"]);
	git(store, ["commit", "--quiet", "-m", "fixture"]);
	writeSettingsFixture(profile, { mode: "local-first", recall: { auto: false }, capture: { ambient: false },
		memoryPackage: { path: join(root, "unavailable-memory") } });
	program = join(root, "sno");
	// Source routing, not a substitute for either product command. The ordinary command arguments and stdin remain intact.
	writeFileSync(program, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
const [command,...args]=process.argv.slice(2);
const route=command==='rem-reflect'?[process.execPath,['--experimental-strip-types',${JSON.stringify(lessonCommand)},...args]]:
 command==='handoff-checkpoint'?['bash',[${JSON.stringify(checkpoint)},...args]]:null;
if(!route){console.error('unavailable external command: '+command);process.exit(2);}
const result=spawnSync(route[0],route[1],{stdio:'inherit'});process.exit(result.status===null?1:result.status);
`, { mode: 0o700 });
	vi.stubEnv("HOME", root); vi.stubEnv("SNO_PROFILE_DIR", profile);
	vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
	vi.stubEnv("REM_REFLECT_STORE", store); vi.stubEnv("SNO_EXECUTABLE", program);
	vi.stubEnv("SNO_CAPTURE_SCRIPTED", "1");
});

afterEach(() => {
	vi.unstubAllEnvs(); vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function hook(app: "mem-claude" | "mem-codex", event: string, session = "session-one", extra: Record<string, unknown> = {}) {
	const result = spawnSync(process.execPath, ["--import", "tsx", join(repo, "apps", app, "src/cli.ts"), event], {
		input: JSON.stringify({ session_id: session, cwd: workspace, prompt_id: "prompt-one", turn_id: "turn-one", prompt: "Continue.", ...extra }),
		encoding: "utf8", env: process.env, timeout: 15_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return { ...result, context: result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string : "" };
}

function saveBrief(session: string, body: string): string {
	const file = continuityBriefPath(session);
	mkdirSync(dirname(file), { recursive: true });
	const saved = spawnSync(program, ["handoff-checkpoint", "--repo", workspace, file], { encoding: "utf8", env: process.env });
	expect(saved.status, saved.stderr).toBe(0);
	writeFileSync(file, `${readFileSync(file, "utf8")}\n${body}`);
	return file;
}

describe("task and approved-lesson host delivery", () => {
	it.each(["mem-claude", "mem-codex"] as const)("%s writes the first session's brief template itself, so the agent runs no command", app => {
		const started = hook(app, "session-start", "first-session", { source: "startup" });
		const file = continuityBriefPath("first-session");
		expect(started.context).toContain(file);
		expect(started.context).not.toContain("handoff-checkpoint");
		const record = readFileSync(file, "utf8");
		expect(record).toContain("## Next");
		expect(record).toContain(`runtime: ${app === "mem-claude" ? "claude-code" : "codex"}\nsession-id: first-session`);
	});

	it.each(["mem-claude", "mem-codex"] as const)("%s keeps the full brief when memory settings are unavailable", app => {
		const body = `## Next\nRead invoices.json and write total.txt.\n## Known failure\nRead missing-prices.json failed with ENOENT.\n${"retained task details\n".repeat(600)}END_OF_COMPLETE_BRIEF`;
		const file = saveBrief("session-one", body);
		rmSync(join(profile, "settings.json"));
		const result = hook(app, "user-prompt-submit");
		expect(result.context).toContain(body);
		expect(result.context).toContain(file);
		expect(result.stderr).toContain("settings unavailable");
	});

	it.each(["mem-claude", "mem-codex"] as const)("%s delivers actual local approval after first prompt and again after compaction", app => {
		const lesson = { lesson_id: "L-continuity", status: "candidate", listed: true, applies_to: "general",
			situation: { task_type: "invoice processing", trigger: "write totals", tools: [] },
			advice: "Include the invoice count beside every reported total." };
		writeFileSync(join(store, "wiki/lessons.jsonl"), `${JSON.stringify(lesson)}\n`);
		git(store, ["add", "wiki/lessons.jsonl"]); git(store, ["commit", "--quiet", "-m", "candidate"]);
		expect(hook(app, "user-prompt-submit").context).not.toContain(lesson.advice);
		const accepted = spawnSync(program, ["rem-reflect", "accept", lesson.lesson_id, "--all-projects"], {
			cwd: workspace, env: process.env, encoding: "utf8", timeout: 10_000,
		});
		expect(accepted.status, accepted.stderr).toBe(0);
		const next = hook(app, "user-prompt-submit").context;
		expect(next).toContain(lesson.advice);
		expect(next.split(lesson.advice)).toHaveLength(2);
		expect(hook(app, "user-prompt-submit").context).not.toContain(lesson.advice);
		if (app === "mem-codex") expect(hook(app, "post-compact").stdout).toBe("");
		const restored = hook(app, "session-start", "session-one", { source: "compact" });
		expect(restored.context).toContain(lesson.advice);
		expect(hook(app, "user-prompt-submit").context).not.toContain(lesson.advice);
	});

	it("refreshes the existing brief before compaction without changing the task body", () => {
		const path = saveBrief("session-one", "## Next\nRead invoices.json; write the independently computed total.\n## Known failure\nmissing-prices.json: ENOENT\n");
		const before = readFileSync(path, "utf8");
		expect(hook("mem-claude", "pre-compact").stdout).toBe("");
		const after = readFileSync(path, "utf8");
		expect(after).toContain("checkpoint: 2");
		expect(after.slice(after.indexOf("<!-- machine-record:end -->"))).toBe(before.slice(before.indexOf("<!-- machine-record:end -->")));
	});

	it("keeps memory context when the lesson operation fails and never invents a missing task", async () => {
		vi.stubEnv("SNO_EXECUTABLE", join(root, "unavailable-sno"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const output = await composeContinuityContext("claude", "UserPromptSubmit", { session_id: "session-one", cwd: workspace },
			async () => JSON.stringify({ hookSpecificOutput: { additionalContext: "The currency is EUR." } }));
		expect(JSON.parse(output).hookSpecificOutput.additionalContext).toBe("The currency is EUR.");
		expect(log.mock.calls.flat().join("\n")).toContain("rem-reflect recall");
	});

	it("installs the supported compact entries through the ordinary installers", async () => {
		const claudeHome = join(root, "claude-home"), codexHome = join(root, "codex-home");
		await installClaude({ configDir: claudeHome, programPath: program, writeOutput: () => {} });
		await installCodex({ codexHome, programPath: program, writeOutput: () => {} });
		const claude = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
		const codex = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
		expect(claude.hooks.PreCompact[0].hooks[0].command).toContain("memory hook pre-compact --harness claude");
		expect(claude.hooks.PostCompact).toBeUndefined();
		expect(codex.hooks.PreCompact[0].hooks[0].command).toContain("memory hook pre-compact --harness codex");
		expect(codex.hooks.PostCompact[0].hooks[0].command).toContain("memory hook post-compact --harness codex");
	});
});
