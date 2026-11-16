/** Loaded-file evidence must travel through the ordinary hooks and the real sidecar. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionStart as claudeStart } from "../../../apps/mem-claude/src/hooks.js";
import { sessionStart as codexStart } from "../../../apps/mem-codex/src/hooks.js";
import { sessionStart as cursorStart, userPromptSubmit as cursorPrompt } from "../../../apps/mem-cursor/src/hooks.js";
import { connect } from "../../../packages/memory/src/contract/client";
import { startRemSidecar } from "../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

let root: string;
let project: string;
let cwd: string;
let home: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>>;
let sequence = 0;
const saved = { ...process.env };

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

beforeAll(async () => {
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	root = mkdtempSync(join(homedir(), ".cache", "memory-loaded-files-"));
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = join(root, "profile");
	writeSettingsFixture(process.env.SNO_PROFILE_DIR, { mode: "local-first", rerank: { mode: "none" }, capture: { ambient: false },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey }, recall: { sessionStart: { timeoutMs: 15_000 } } });
	sidecar = await startRemSidecar();
	for (const skinId of ["claude-code", "codex", "cursor"]) {
		const client = await connect({ skinId });
		if (client.degraded) throw new Error(client.reason);
		await client.init({ principal: "caller", project: root, session: `init-${skinId}` }, { skinId });
	}
}, 120_000);

beforeEach(() => {
	const fixture = join(root, `case-${++sequence}`);
	project = join(fixture, "repository");
	cwd = join(project, "src", "feature");
	home = join(fixture, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	process.env.HOME = home;
	process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
	process.env.CODEX_HOME = join(home, "codex");
	process.env.CURSOR_INVOKED_AS = "cursor-agent";
	database.sqlite.prepare("DELETE FROM nodix_place_loaded_files").run();
});

afterAll(async () => {
	await sidecar?.stop();
	database?.cleanup();
	rmSync(root, { recursive: true, force: true });
	for (const key of ["SNO_PROFILE_DIR", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_INVOKED_AS"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function files(skin: string): Array<{ path: string; sha256: string; bytes: number }> {
	const rows = database.sqlite.prepare("SELECT files FROM nodix_place_loaded_files WHERE skin_id = ?").all(skin) as Array<{ files: string }>;
	expect(rows).toHaveLength(1);
	const sent: Array<{ path: string; sha256: string; bytes: number }> = JSON.parse(rows[0]?.files ?? "[]");
	// Real ancestor instructions outside this fixture vary by machine.
	return sent.filter(file => file.path.startsWith(`${root}/`));
}

const hookInput = () => ({ session_id: `loaded-${sequence}`, cwd, source: "startup", transcript_path: join(home, "session.jsonl") });
const cursorInput = () => ({ conversation_id: `cursor-loaded-${sequence}`, session_id: `cursor-loaded-${sequence}`, generation_id: "first",
	model: "default", cursor_version: "2026.10.01-e373342", workspace_roots: [project], transcript_path: null });

describe("loaded instruction files sent by coding hooks", () => {
	it("Claude sends ancestor, local, imported and unconditional rules, excluding path-matched rules", async () => {
		write(join(home, "claude", "CLAUDE.md"), "home\n");
		write(join(dirname(project), "CLAUDE.md"), "ancestor\n");
		write(join(project, "CLAUDE.md"), "@./imported.md\n");
		write(join(project, "imported.md"), "imported\n");
		write(join(cwd, "CLAUDE.local.md"), "local\n");
		write(join(cwd, ".claude", "CLAUDE.md"), "child\n");
		write(join(project, ".claude", "rules", "plain.md"), "plain\n");
		write(join(project, ".claude", "rules", "nested", "all.md"), "nested\n");
		write(join(home, "claude", "rules", "all.md"), "user-rule\n");
		write(join(project, ".claude", "rules", "conditional.md"), "---\npaths: src/**\n---\nDo not load yet.\n");
		await claudeStart(hookInput());
		const sent = files("claude-code");
		expect(sent.map(file => relative(dirname(project), file.path)).sort()).toEqual([
			"CLAUDE.md", "home/claude/CLAUDE.md", "home/claude/rules/all.md", "repository/.claude/rules/nested/all.md",
			"repository/.claude/rules/plain.md", "repository/CLAUDE.md", "repository/imported.md",
			"repository/src/feature/.claude/CLAUDE.md", "repository/src/feature/CLAUDE.local.md",
		]);
		expect(sent.find(file => file.path === join(project, "imported.md"))).toEqual({ path: join(project, "imported.md"), bytes: 9,
			sha256: "db4ad2be31430992bcc7d620722087520d152617c22424e66cb46b25b85a5723" });
	});

	it("Claude sends only the first 200 lines of automatic memory", async () => {
		const memory = join(home, "claude", "projects", cwd.replaceAll("/", "-"), "memory", "MEMORY.md");
		write(memory, "line\n".repeat(201));
		await claudeStart(hookInput());
		expect(files("claude-code")).toEqual([{ path: memory, bytes: 1000,
			sha256: "a9624812017c6dd737a0aae88b51e267a80410a42c1f911d480046074230b55d" }]);
	});

	it("Claude cuts automatic memory at 25 KiB even before 200 lines", async () => {
		const memory = join(home, "claude", "projects", cwd.replaceAll("/", "-"), "memory", "MEMORY.md");
		write(memory, "z".repeat(25601));
		await claudeStart(hookInput());
		expect(files("claude-code")).toEqual([{ path: memory, bytes: 25600,
			sha256: "8a57995a46383bb70299a7b04c8dbcb34f32668f637a19bd3e0bcef3d49dff2b" }]);
	});

	it.each([
		{ filename: "different-file-name.md", content: "---\nname: Plain English\n---\nUse short sentences.\n" },
		{ filename: "Plain English.md", content: "Use short sentences.\n" },
	])("Claude sends the user output style matched by $filename", async ({ filename, content }) => {
		write(join(home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Plain English" }));
		const style = join(home, ".claude", "output-styles", filename);
		write(style, content);
		await claudeStart(hookInput());
		expect(files("claude-code").map(file => [file.path, file.bytes])).toEqual([[style, Buffer.byteLength(content)]]);
	});

	it("Claude uses the project local output style setting and the closest matching file", async () => {
		write(join(home, ".claude", "settings.json"), JSON.stringify({ outputStyle: "User style" }));
		write(join(project, ".claude", "settings.json"), JSON.stringify({ outputStyle: "Project style" }));
		write(join(project, ".claude", "settings.local.json"), JSON.stringify({ outputStyle: "Local style" }));
		write(join(home, ".claude", "output-styles", "user.md"), "---\nname: User style\n---\nUser wording.\n");
		write(join(project, ".claude", "output-styles", "project.md"), "---\nname: Project style\n---\nProject wording.\n");
		write(join(home, ".claude", "output-styles", "local.md"), "---\nname: Local style\n---\nDistant wording.\n");
		write(join(project, ".claude", "output-styles", "local.md"), "---\nname: Local style\n---\nRoot wording.\n");
		const style = join(cwd, ".claude", "output-styles", "local.md");
		write(style, "---\nname: Local style\n---\nClosest wording.\n");
		await claudeStart(hookInput());
		expect(files("claude-code").map(file => file.path)).toEqual([style]);
	});

	it.each([
		{ setting: "built-in", json: JSON.stringify({ outputStyle: "Explanatory" }) },
		{ setting: "absent", json: JSON.stringify({}) },
		{ setting: "unreadable JSON", json: "{" },
	])("Claude adds no output style file when the setting is $setting", async ({ json }) => {
		write(join(home, ".claude", "settings.json"), json);
		write(join(home, ".claude", "output-styles", "unused.md"), "---\nname: Unused style\n---\nDo not load this style.\n");
		await claudeStart(hookInput());
		expect(files("claude-code")).toEqual([]);
	});

	it("Codex sends its home and repository-to-cwd chain and chooses each override", async () => {
		write(join(home, "codex", "AGENTS.md"), "ignored home\n");
		write(join(home, "codex", "AGENTS.override.md"), "home\n");
		write(join(dirname(project), "AGENTS.md"), "outside repository\n");
		write(join(project, "AGENTS.md"), "root\n");
		write(join(project, "src", "AGENTS.md"), "ignored directory\n");
		write(join(project, "src", "AGENTS.override.md"), "local\n");
		write(join(cwd, "AGENTS.md"), "child\n");
		await codexStart(hookInput());
		expect(files("codex").map(file => [relative(dirname(project), file.path), file.bytes])).toEqual([
			["home/codex/AGENTS.override.md", 5], ["repository/AGENTS.md", 5], ["repository/src/AGENTS.override.md", 6], ["repository/src/feature/AGENTS.md", 6],
		]);
	});

	it("Codex shares a 32 KiB prefix budget across home and repository files", async () => {
		write(join(home, "codex", "AGENTS.md"), "h".repeat(1024));
		write(join(project, "AGENTS.md"), "r".repeat(1024));
		write(join(project, "src", "AGENTS.md"), "s".repeat(40000));
		write(join(cwd, "AGENTS.md"), "not loaded after budget\n");
		await codexStart(hookInput());
		expect(files("codex")).toEqual([
			{ path: join(home, "codex", "AGENTS.md"), bytes: 1024, sha256: "d6de1fb917cd8440e759fc58a5eb0661becae24db357543ea3617e5368d4f812" },
			{ path: join(project, "AGENTS.md"), bytes: 1024, sha256: "01ff2984f7c59de5064eec041cae3f67db369ae6e21d8463ac699fefbeae3b27" },
			{ path: join(project, "src", "AGENTS.md"), bytes: 30720, sha256: "e35419309abea1b68f5815e69d1779a35a5d7fbb416a680819294af1768a3f67" },
		]);
	});

	it("Cursor sends both root AGENTS.md and CLAUDE.md when both files exist", async () => {
		write(join(project, "AGENTS.md"), "root agent instructions\n");
		write(join(project, "CLAUDE.md"), "root Claude instructions\n");
		await cursorStart(cursorInput());
		expect(files("cursor").map(file => relative(project, file.path))).toEqual(["AGENTS.md", "CLAUDE.md"]);
	});

	it("Cursor sends only root AGENTS.md when CLAUDE.md is absent", async () => {
		write(join(project, "AGENTS.md"), "root agent instructions\n");
		await cursorStart(cursorInput());
		expect(files("cursor").map(file => relative(project, file.path))).toEqual(["AGENTS.md"]);
	});

	it("Cursor sends root AGENTS and only alwaysApply rules at start and an owed first prompt", async () => {
		write(join(project, "AGENTS.md"), "root\n");
		write(join(project, ".cursor", "rules", "always.mdc"), "---\nalwaysApply: true\n---\nApply this rule.\n");
		write(join(project, ".cursor", "rules", "nested", "always.mdc"), "---\nalwaysApply: true # for every session\n---\nNested rule.\n");
		write(join(project, ".cursor", "rules", "conditional.mdc"), "---\nalwaysApply: false\n---\nOnly on request.\n");
		write(join(project, ".cursor", "rules", "manual.mdc"), "No front matter.\n");
		write(join(cwd, "AGENTS.md"), "child\n");
		await cursorStart(cursorInput());
		const expected = ["repository/.cursor/rules/always.mdc", "repository/.cursor/rules/nested/always.mdc", "repository/AGENTS.md"];
		expect(files("cursor").map(file => relative(dirname(project), file.path))).toEqual(expected);
		database.sqlite.prepare("DELETE FROM nodix_place_loaded_files").run();
		await cursorPrompt({ ...cursorInput(), conversation_id: "cursor-owed-first", session_id: "cursor-owed-first", prompt: "Hi" });
		expect(files("cursor").map(file => relative(dirname(project), file.path))).toEqual(expected);
	});
});
