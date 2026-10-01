import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importRepository, splitMarkdown } from "../../../apps/mem-claude/src/import.js";
import { spoolDirectory } from "../../../apps/mem-claude/src/paths.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const roots: string[] = [];
const previousProfile = process.env.SNO_PROFILE_DIR;
const previousConfig = process.env.CLAUDE_CONFIG_DIR;
const previousHome = process.env.HOME;

async function root(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `${label}-`));
	roots.push(path);
	return path;
}

afterEach(async () => {
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
	if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousConfig;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Claude auto-memory import", () => {
	it("does not record notes when automatic capture is off", async () => {
		const profile = await root("mem-claude-disabled-profile");
		const repository = await root("mem-claude-disabled-repo");
		const config = await root("mem-claude-disabled-config");
		process.env.SNO_PROFILE_DIR = profile;
		process.env.HOME = join(profile, "home");
		process.env.CLAUDE_CONFIG_DIR = config;
		writeSettingsFixture(profile, { capture: { ambient: false },
			embedding: { cacheDir: join(userInfo().homedir, ".cache", "sno-station", "models") } });
		await mkdir(join(repository, ".git"));
		const output = spawnSync(process.execPath, ["--import", "tsx", "apps/mem-claude/src/cli.ts", "import", "--repo", repository], {
			cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", env: process.env,
		});
		expect(output.status).toBe(0);
		expect(output.stderr).toContain("Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.");
		expect(output.stdout).toMatch(/^blocks fed: 0\nreceipt: [^\n]+\n$/);
		const memory = join(config, "projects", repository.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
		await mkdir(memory, { recursive: true });
		const note = join(memory, "note.md");
		await writeFile(note, "# Note\nThe project color is blue.\n");
		const imported = await importRepository(repository, () => undefined);
		expect(imported.blocksFed).toBe(0);
		await expect(readFile(imported.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(spoolDirectory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("splits only at level-one and level-two headings, retaining unheaded notes", () => {
		expect(splitMarkdown("preamble\n# One\na\n## Two\nb\n### Three\nc\n")).toEqual([
			{ heading: "(preamble)", body: "preamble" },
			{ heading: "One", body: "a" },
			{ heading: "Two", body: "b\n### Three\nc" },
		]);
		expect(splitMarkdown("A note without any heading.\n")).toEqual([
			{ heading: "(preamble)", body: "A note without any heading." },
		]);
	});

	it("feeds only changed memory files, preserving repository scope and excluding instructions/transcripts", async () => {
		process.env.SNO_PROFILE_DIR = await root("mem-claude-import-profile");
		writeSettingsFixture(process.env.SNO_PROFILE_DIR);
		const repository = await root("mem-claude-import-repo");
		const config = await root("mem-claude-import-config");
		process.env.CLAUDE_CONFIG_DIR = config;
		const projectDir = join(config, "projects", repository.replace(/[^a-zA-Z0-9]/g, "-"));
		const memoryDir = join(projectDir, "memory");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(join(memoryDir, "MEMORY.md"), "# Index\nThe repository harbor is cobalt.\n");
		await writeFile(join(memoryDir, "topic-a.md"), "# Topic A\nThe repository telescope is amber.\n");
		await writeFile(join(memoryDir, "topic-b.md"), "The repository compass is silver.\n");
		await writeFile(join(repository, "CLAUDE.md"), "Never import the instruction marker.\n");
		await writeFile(join(projectDir, "transcript.jsonl"), '{"text":"Never import the transcript marker."}\n');
		const first = await importRepository(repository, () => {});
		expect(first.blocksFed).toBe(3);
		expect((await importRepository(repository, () => {})).blocksFed).toBe(0);
		const receiptBefore = JSON.parse(await readFile(first.receiptPath, "utf8"));
		const changed = "# Topic A\nThe repository telescope is now teal.\n";
		await writeFile(join(memoryDir, "topic-a.md"), changed);
		expect((await importRepository(repository, () => {})).blocksFed).toBe(1);
		const spool = await Promise.all((await readdir(spoolDirectory())).map(async name =>
			JSON.parse(await readFile(join(spoolDirectory(), name), "utf8"))));
		expect(spool).toHaveLength(4);
		expect(spool.every(record => record.project === repository && record.kind === "import")).toBe(true);
		expect(spool.every(record => record.user.startsWith("Imported Claude Code memory note from "))).toBe(true);
		expect(spool.some(record => /instruction marker|transcript marker/.test(record.user))).toBe(false);
		const receiptAfter = JSON.parse(await readFile(first.receiptPath, "utf8"));
		expect(receiptAfter.files[join(memoryDir, "MEMORY.md")]).toEqual(receiptBefore.files[join(memoryDir, "MEMORY.md")]);
		expect(receiptAfter.files[join(memoryDir, "topic-b.md")]).toEqual(receiptBefore.files[join(memoryDir, "topic-b.md")]);
		expect(receiptAfter.files[join(memoryDir, "topic-a.md")].hash)
			.toBe(createHash("sha256").update(changed).digest("hex"));
		expect(Object.keys(receiptAfter.files)).toHaveLength(3);
	});

	it("starts the worker again when unchanged notes remain in the spool", async () => {
		const profile = await root("mem-claude-retry-profile");
		const repository = await root("mem-claude-retry-repo");
		const config = await root("mem-claude-retry-config");
		process.env.SNO_PROFILE_DIR = profile;
		process.env.CLAUDE_CONFIG_DIR = config;
		writeSettingsFixture(profile);
		const memory = join(config, "projects", repository.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "note.md"), "# Note\nThe project color is blue.\n");
		expect((await importRepository(repository, () => undefined)).blocksFed).toBe(1);
		const startWorker = vi.fn();
		expect((await importRepository(repository, startWorker)).blocksFed).toBe(0);
		expect(startWorker).toHaveBeenCalledTimes(1);
	});

	it("records zero files without creating a spool when the memory directory is absent", async () => {
		process.env.SNO_PROFILE_DIR = await root("mem-claude-absent-profile");
		writeSettingsFixture(process.env.SNO_PROFILE_DIR);
		process.env.CLAUDE_CONFIG_DIR = await root("mem-claude-absent-config");
		const repository = await root("mem-claude-absent-repo");
		const startWorker = vi.fn();
		const result = await importRepository(repository, startWorker);
		expect(result.blocksFed).toBe(0);
		expect(startWorker).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(result.receiptPath, "utf8"))).toEqual({
			root: repository, project: repository, files: {},
		});
		await expect(readdir(spoolDirectory())).rejects.toMatchObject({ code: "ENOENT" });
	});
});
