import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MemoryClient } from "@snoai/memory/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importRepository as importCodex, importUser } from "../../../apps/mem-codex/src/import.js";
import { importDirectory as codexImports, spoolDirectory as codexSpool } from "../../../apps/mem-codex/src/paths.js";
import { runWorker as runCodexWorker } from "../../../apps/mem-codex/src/worker.js";
import { importRepository as importClaude } from "../../../apps/mem-claude/src/import.js";
import { importDirectory as claudeImports, spoolDirectory as claudeSpool } from "../../../apps/mem-claude/src/paths.js";
import { runWorker as runClaudeWorker } from "../../../apps/mem-claude/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prior = { HOME: process.env.HOME, SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR,
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const roots: string[] = [];

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "import-capture-"));
	roots.push(path);
	return path;
}

afterEach(async () => {
	for (const [key, value] of Object.entries(prior)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe.each([
	{ app: "codex", imports: codexImports, spool: codexSpool, importNote: importCodex, worker: runCodexWorker },
	{ app: "claude", imports: claudeImports, spool: claudeSpool, importNote: importClaude, worker: runClaudeWorker },
])("$app capture results", ({ app, imports, spool, importNote, worker }) => {
	it("leaves notes unrecorded while capture is off and queues them after it is enabled", async () => {
		const profile = await root();
		const repository = await root();
		process.env.HOME = join(profile, "home");
		process.env.SNO_PROFILE_DIR = profile;
		process.env.CLAUDE_CONFIG_DIR = join(profile, "claude");
		await mkdir(join(repository, ".git"));
		const memory = app === "codex" ? join(repository, ".codex", "memories")
			: join(process.env.CLAUDE_CONFIG_DIR, "projects", repository.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
		await mkdir(memory, { recursive: true });
		const note = join(memory, "note.md");
		await writeFile(note, "# Note\nThe project color is blue.\n");
		writeSettingsFixture(profile, { capture: { ambient: false } });
		const cli = ["--import", "tsx", `apps/mem-${app}/src/cli.ts`, "import", "--repo", repository];
		const disabled = spawnSync(process.execPath, cli, { cwd: repoRoot, env: process.env, encoding: "utf8" });
		expect(disabled.status).toBe(0);
		expect(disabled.stderr).toContain("Automatic capture is off in settings.json");
		expect(disabled.stdout).toMatch(/^blocks fed: 0\nreceipt: [^\n]+\n$/);
		await expect(readdir(imports())).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(spool())).rejects.toMatchObject({ code: "ENOENT" });
		writeSettingsFixture(profile, { capture: { ambient: true } });
		const imported = await importNote(repository, () => undefined);
		expect(imported.blocksFed).toBe(1);
		expect(JSON.parse(await readFile(imported.receiptPath, "utf8")).files[note].blocksFed).toBe(1);
		const queued = await readdir(spool());
		expect(queued).toHaveLength(1);
		expect(JSON.parse(await readFile(join(spool(), queued[0] ?? ""), "utf8")).user)
			.toContain("The project color is blue.");
	});

	it("reports usage before settings and a setup message when settings are absent", async () => {
		const profile = await root();
		const repository = await root();
		process.env.HOME = join(profile, "home");
		process.env.SNO_PROFILE_DIR = profile;
		const base = ["--import", "tsx", `apps/mem-${app}/src/cli.ts`, "import"];
		const usage = spawnSync(process.execPath, base, { cwd: repoRoot, env: process.env, encoding: "utf8" });
		expect(usage.status).toBe(1);
		expect(usage.stderr).toContain("import requires");
		const missing = spawnSync(process.execPath, [...base, "--repo", repository],
			{ cwd: repoRoot, env: process.env, encoding: "utf8" });
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain(`settings unavailable: ${join(profile, "settings.json")}: file; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
		writeSettingsFixture(profile);
		const settingsPath = join(profile, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		settings.capture.ambient = "disabled";
		await writeFile(settingsPath, JSON.stringify(settings));
		const malformed = spawnSync(process.execPath, [...base, "--repo", repository],
			{ cwd: repoRoot, env: process.env, encoding: "utf8" });
		expect(malformed.status).toBe(1);
		expect(malformed.stderr).toContain(`settings unavailable: ${settingsPath}: capture.ambient; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md`);
	});

	it("finishes a partial imported turn and counts stored facts in the receipt", async () => {
		const profile = await root();
		process.env.HOME = join(profile, "home");
		process.env.SNO_PROFILE_DIR = profile;
		await mkdir(spool(), { recursive: true });
		await mkdir(imports(), { recursive: true });
		const receiptPath = join(imports(), "receipt.json");
		await writeFile(receiptPath, JSON.stringify({ files: { "/note.md": { committed: 0, failures: 0 } } }));
		await writeFile(join(spool(), "turn.json"), JSON.stringify({ sessionId: "import-test", turnId: "partial-turn",
			project: profile, childCwd: profile, user: "The project color is blue.", at: 1,
			attempts: 0, state: "pending", kind: "import", importReceipt: { path: receiptPath, file: "/note.md" } }));
		let clock = 1_000;
		const client = { principal: "tester", async init() { return { degraded: false }; },
			async capture() { return { degraded: false, committed: false, partial: true, turnId: "partial-turn" }; } } as unknown as MemoryClient;
		expect(await worker({ async connect() { return client; }, now: () => clock,
			async sleep(delay) { clock += delay; }, async runChild() { throw new Error("unexpected model call"); } }))
			.toBe("drained");
		expect(await readdir(spool())).toEqual([]);
		expect(JSON.parse(await readFile(receiptPath, "utf8")).files["/note.md"])
			.toEqual({ committed: 1, failures: 0 });
	});

	it("continues draining imports when a receipt file disappears", async () => {
		const profile = await root();
		process.env.HOME = join(profile, "home");
		process.env.SNO_PROFILE_DIR = profile;
		await mkdir(spool(), { recursive: true });
		await mkdir(imports(), { recursive: true });
		const missingReceipt = join(imports(), "missing.json");
		const nextReceipt = join(imports(), "next.json");
		await writeFile(missingReceipt, "{}");
		await rm(missingReceipt);
		await writeFile(nextReceipt, JSON.stringify({ files: { "/next.md": { committed: 0 } } }));
		for (const [name, receiptPath, file] of [["first", missingReceipt, "/missing.md"], ["next", nextReceipt, "/next.md"]]) {
			await writeFile(join(spool(), `${name}.json`), JSON.stringify({ sessionId: "import-test", turnId: name,
				project: profile, childCwd: profile, user: `The ${name} note is blue.`, at: 1,
				attempts: 0, state: "pending", kind: "import", importReceipt: { path: receiptPath, file } }));
		}
		let clock = 1_000;
		const client = { principal: "tester", async init() { return { degraded: false }; },
			async capture() { return { degraded: false, committed: true }; } } as unknown as MemoryClient;
		const logs: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation(message => { logs.push(String(message)); });
		try {
			expect(await worker({ async connect() { return client; }, now: () => clock,
				async sleep(delay) { clock += delay; }, async runChild() { throw new Error("unexpected model call"); } }))
				.toBe("drained");
		} finally {
			log.mockRestore();
		}
		expect(await readdir(spool())).toEqual([]);
		expect(JSON.parse(await readFile(nextReceipt, "utf8")).files["/next.md"])
			.toEqual({ committed: 1 });
		expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
			path: missingReceipt, field: "committed", error: expect.stringContaining("ENOENT"),
		}));
	});
});

it("does not record Codex notes during install with capture off, then imports them when enabled", async () => {
	const profile = await root();
	const codexHome = join(profile, "codex");
	process.env.HOME = join(profile, "home");
	process.env.SNO_PROFILE_DIR = profile;
	await mkdir(join(codexHome, "memories"), { recursive: true });
	await writeFile(join(codexHome, "memories", "memory_summary.md"), "# Note\nThe project color is blue.\n");
	writeSettingsFixture(profile, { capture: { ambient: false } });
	const installed = spawnSync(process.execPath,
		["--import", "tsx", "apps/mem-codex/src/cli.ts", "install", "--codex-home", codexHome],
		{ cwd: repoRoot, env: process.env, encoding: "utf8" });
	expect(installed.status).toBe(0);
	expect(installed.stderr).toContain("Automatic capture is off in settings.json");
	expect(installed.stdout).not.toContain("Automatic capture is off");
	await expect(readdir(codexImports())).rejects.toMatchObject({ code: "ENOENT" });
	await expect(readdir(codexSpool())).rejects.toMatchObject({ code: "ENOENT" });
	writeSettingsFixture(profile, { capture: { ambient: true } });
	const imported = await importUser(codexHome, () => undefined);
	expect(imported.blocksFed).toBe(1);
	expect(JSON.parse(await readFile(imported.receiptPath, "utf8")).files[join(codexHome, "memories", "memory_summary.md")].blocksFed).toBe(1);
	expect(await readdir(codexSpool())).toHaveLength(1);
});
