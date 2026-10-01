import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importRepository, importUser, splitMarkdown } from "../../../apps/mem-codex/src/import.js";
import { importDirectory, spoolDirectory } from "../../../apps/mem-codex/src/paths.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const roots: string[] = [];
const previousProfile = process.env.SNO_PROFILE_DIR;
const previousCodexHome = process.env.CODEX_HOME;
const previousHome = process.env.HOME;

async function root(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `${label}-`));
	roots.push(path);
	return path;
}

afterEach(async () => {
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
	if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = previousCodexHome;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Codex memory import", () => {
	it("does not record notes when automatic capture is off", async () => {
		const profile = await root("mem-codex-disabled-profile");
		const repository = await root("mem-codex-disabled-repo");
		process.env.SNO_PROFILE_DIR = profile;
		process.env.HOME = join(profile, "home");
		writeSettingsFixture(profile, { capture: { ambient: false },
			embedding: { cacheDir: join(userInfo().homedir, ".cache", "sno-station", "models") } });
		await mkdir(join(repository, ".git"));
		const output = spawnSync(process.execPath, ["--import", "tsx", "apps/mem-codex/src/cli.ts", "import", "--repo", repository], {
			cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", env: process.env,
		});
		expect(output.status).toBe(0);
		expect(output.stderr).toContain("Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.");
		expect(output.stdout).toMatch(/^blocks fed: 0\nreceipt: [^\n]+\n$/);
		await mkdir(join(repository, ".codex", "memories"), { recursive: true });
		await writeFile(join(repository, ".codex", "memories", "note.md"), "# Note\nThe project color is blue.\n");
		const imported = await importRepository(repository, () => undefined);
		expect(imported.blocksFed).toBe(0);
		await expect(readFile(imported.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readdir(spoolDirectory())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("splits only at level-one and level-two headings", () => {
		expect(splitMarkdown("preamble\n# One\na\n## Two\nb\n### Three\nc\n")).toEqual([
			{ heading: "(preamble)", body: "preamble" },
			{ heading: "One", body: "a" },
			{ heading: "Two", body: "b\n### Three\nc" },
		]);
	});

	it("feeds only changed repository files and excludes rollout summaries", async () => {
		const profile = await root("mem-codex-import-profile");
		const repository = await root("mem-codex-import-repo");
		process.env.SNO_PROFILE_DIR = profile;
		await mkdir(join(repository, ".git"));
		writeSettingsFixture(profile);
		await mkdir(join(repository, ".codex/memories/rollout_summaries"), { recursive: true });
		await writeFile(join(repository, ".codex/memories/MEMORY.md"), "# Main\nalpha\n## More\nbeta\n");
		await writeFile(join(repository, ".codex/memories/topic.md"), "# Topic\ngamma\n");
		await writeFile(join(repository, ".codex/memories/rollout_summaries/hidden.md"), "# Hidden\nnever import\n");

		expect((await importRepository(repository, () => undefined)).blocksFed).toBe(3);
		expect((await importRepository(repository, () => undefined)).blocksFed).toBe(0);
		await writeFile(join(repository, ".codex/memories/topic.md"), "# Topic\nchanged gamma\n");
		expect((await importRepository(repository, () => undefined)).blocksFed).toBe(1);
		const spool = await Promise.all((await readdir(spoolDirectory())).map(async name => JSON.parse(await readFile(join(spoolDirectory(), name), "utf8"))));
		expect(spool).toHaveLength(4);
		expect(spool.every(record => record.project === repository && record.kind === "import")).toBe(true);
		expect(spool.some(record => record.user.includes("never import"))).toBe(false);
		expect((await readdir(importDirectory())).length).toBe(1);
	});

	it("starts the worker again when unchanged notes remain in the spool", async () => {
		const profile = await root("mem-codex-retry-profile");
		const repository = await root("mem-codex-retry-repo");
		process.env.SNO_PROFILE_DIR = profile;
		writeSettingsFixture(profile);
		await mkdir(join(repository, ".codex/memories"), { recursive: true });
		await writeFile(join(repository, ".codex/memories/note.md"), "# Note\nThe project color is blue.\n");
		expect((await importRepository(repository, () => undefined)).blocksFed).toBe(1);
		const startWorker = vi.fn();
		expect((await importRepository(repository, startWorker)).blocksFed).toBe(0);
		expect(startWorker).toHaveBeenCalledTimes(1);
	});

	it("does not start the worker when no notes or spool records exist", async () => {
		const profile = await root("mem-codex-empty-profile");
		const repository = await root("mem-codex-empty-repo");
		process.env.SNO_PROFILE_DIR = profile;
		writeSettingsFixture(profile);
		const startWorker = vi.fn();
		expect((await importRepository(repository, startWorker)).blocksFed).toBe(0);
		expect(startWorker).not.toHaveBeenCalled();
	});

	it("imports user notes into global scope and extension note paths", async () => {
		const profile = await root("mem-codex-user-profile");
		const codexHome = await root("mem-codex-user-home");
		process.env.SNO_PROFILE_DIR = profile;
		process.env.CODEX_HOME = codexHome;
		writeSettingsFixture(profile);
		await mkdir(join(codexHome, "memories/extensions/example/notes"), { recursive: true });
		await writeFile(join(codexHome, "memories/memory_summary.md"), "# User\nuser fact\n");
		await writeFile(join(codexHome, "memories/extensions/example/notes/note.md"), "# Ext\nextension fact\n");
		const result = await importUser(codexHome, () => undefined);
		expect(result.blocksFed).toBe(2);
		const spool = await Promise.all((await readdir(spoolDirectory())).map(async name => JSON.parse(await readFile(join(spoolDirectory(), name), "utf8"))));
		expect(spool.every(record => record.project === "global" && record.childCwd === codexHome)).toBe(true);
	});
});
