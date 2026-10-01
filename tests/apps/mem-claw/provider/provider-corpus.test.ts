import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	readCanonicalMemoryFile,
	searchCanonicalMemoryFiles,
} from "../../../../packages/memory/src/engine/provider/canonical-memory-corpus.ts";
import { listSnoStationMemProviderPublicArtifacts } from "../../../../apps/mem-claw/src/tools/provider-public-artifacts.ts";
import { resolveProviderAuthority } from "../../../../packages/memory/src/engine/provider/provider-authority.ts";
import type { ProviderIdentity } from "../../../../packages/memory/src/engine/provider/provider-types.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const userAlphaId = "019f3d5e-7a30-7cc0-8f4f-0b9c72e4a001";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

async function createWorkspace(): Promise<string> {
	const workspaceDir = await mkdtemp(join(tmpdir(), "mem-claw-corpus-"));
	await mkdir(join(workspaceDir, "memory", "project"), { recursive: true });
	return workspaceDir;
}

async function writeWorkspaceFile(workspaceDir: string, relPath: string, content: string): Promise<void> {
	const filePath = join(workspaceDir, relPath);
	await mkdir(join(filePath, ".."), { recursive: true });
	await writeFile(filePath, content);
}

async function createProviderManager(
	store: MemoryStore,
	identity: ProviderIdentity,
	workspaceDir: string,
) {
	const { SnoStationMemProviderSearchManager } = await import(
		"../../../../packages/memory/src/engine/provider/provider-search-manager.ts"
	);
	return new SnoStationMemProviderSearchManager({ store, identity, workspaceDir });
}

describe("canonical memory corpus", () => {
	const tempDirs: string[] = [];
	let store: MemoryStore | undefined;
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	});

	afterEach(async () => {
		store?.closeSync();
		cleanup?.();
		store = undefined;
		cleanup = undefined;
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("searches and reads only allowlisted canonical Markdown files", async () => {
		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		const outsideDir = await mkdtemp(join(tmpdir(), "mem-claw-corpus-outside-"));
		tempDirs.push(outsideDir);

		await writeWorkspaceFile(
			workspaceDir,
			"MEMORY.md",
			"Root launch memory.\nThe root file mentions the Alpine launch checklist.",
		);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/runbook.md",
			"Runbook title\nCanonical launch checklist second line\nDo not truncate this third line.",
		);
		await writeWorkspaceFile(workspaceDir, "USER.md", "Denied user context launch checklist.");
		await writeWorkspaceFile(workspaceDir, "sessions/a.md", "Denied session launch checklist.");
		await writeWorkspaceFile(workspaceDir, ".openclaw/session.md", "Denied dotdir launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/config/settings.md", "Denied config launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/mappings/agents.md", "Denied mapping launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/secrets/api.md", "Denied secret launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/secret.md", "Denied secret file launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/secrets.md", "Denied secrets file launch checklist.");
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/instructions.md",
			"Denied instructions file launch checklist.",
		);
		await writeWorkspaceFile(workspaceDir, "memory/trace/audit.md", "Denied trace launch checklist.");
		await writeWorkspaceFile(workspaceDir, "memory/telemetry/output.md", "Denied telemetry launch checklist.");
		await writeWorkspaceFile(workspaceDir, "notes.md", "Denied internal symlink launch checklist.");
		await symlink(join(workspaceDir, "notes.md"), join(workspaceDir, "memory", "internal-link.md"));
		await symlink(join(workspaceDir, "USER.md"), join(workspaceDir, "memory", "escaped-user.md"));
		await symlink(
			join(workspaceDir, "memory", "secrets", "api.md"),
			join(workspaceDir, "memory", "escaped-secret.md"),
		);
		await writeFile(join(outsideDir, "escaped.md"), "Escaped symlink launch checklist.");
		await symlink(join(outsideDir, "escaped.md"), join(workspaceDir, "memory", "escaped.md"));

		const results = await searchCanonicalMemoryFiles({
			workspaceDir,
			query: "launch checklist",
			maxResults: 10,
		});
		const paths = results.map((result) => result.path);
		const resultJson = JSON.stringify(results);

		expect(paths).toContain("MEMORY.md");
		expect(paths).toContain("memory/project/runbook.md");
		expect(paths).not.toContain("USER.md");
		expect(paths).not.toContain("sessions/a.md");
		expect(paths).not.toContain("memory/config/settings.md");
		expect(paths).not.toContain("memory/mappings/agents.md");
		expect(paths).not.toContain("memory/secrets/api.md");
		expect(paths).not.toContain("memory/secret.md");
		expect(paths).not.toContain("memory/secrets.md");
		expect(paths).not.toContain("memory/project/instructions.md");
		expect(paths).not.toContain("memory/trace/audit.md");
		expect(paths).not.toContain("memory/telemetry/output.md");
		expect(paths).not.toContain("memory/internal-link.md");
		expect(paths).not.toContain("memory/escaped-user.md");
		expect(paths).not.toContain("memory/escaped-secret.md");
		expect(paths).not.toContain("memory/escaped.md");
		expect(resultJson).not.toContain("Denied secret file launch checklist.");
		expect(resultJson).not.toContain("Denied secrets file launch checklist.");
		expect(resultJson).not.toContain("Denied instructions file launch checklist.");

		const read = await readCanonicalMemoryFile({
			workspaceDir,
			relPath: "memory/project/runbook.md",
			from: 2,
			lines: 1,
		});
		expect(read.path).toBe("memory/project/runbook.md");
		expect(read.text).toBe("Canonical launch checklist second line");
		expect(read.startLine).toBe(2);
		expect(read.endLine).toBe(2);

		const deniedPaths = [
			join(workspaceDir, "MEMORY.md"),
			"memory/../USER.md",
			"memory\\project\\runbook.md",
			"memory//project/runbook.md",
			"USER.md",
			"sessions/a.md",
			"memory/escaped.md",
			"memory/config/settings.md",
			"memory/mappings/agents.md",
			"memory/secrets/api.md",
			"memory/secret.md",
			"memory/secrets.md",
			"memory/project/instructions.md",
			"memory/trace/audit.md",
			"memory/telemetry/output.md",
			"memory/internal-link.md",
			"memory/escaped-user.md",
			"memory/escaped-secret.md",
		];
		for (const relPath of deniedPaths) {
			await expect(readCanonicalMemoryFile({ workspaceDir, relPath })).rejects.toThrow(
				/not authorized|not found|denied|unsafe/i,
			);
		}
	});

	it("searches non-ASCII canonical Markdown content", async () => {
		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/localized.md",
			"发布检查清单\n请在第一次正式发布前确认向量检索状态。",
		);

		const results = await searchCanonicalMemoryFiles({
			workspaceDir,
			query: "发布检查清单",
			maxResults: 5,
		});

		expect(results.map((result) => result.path)).toContain("memory/project/localized.md");
		expect(results[0]?.snippet).toContain("发布检查清单");
	});

	it("does not traverse a symlinked memory directory outside the workspace", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await mkdtemp(join(tmpdir(), "mem-claw-corpus-"));
		const outsideDir = await mkdtemp(join(tmpdir(), "mem-claw-corpus-outside-"));
		const stateDir = await mkdtemp(join(tmpdir(), "mem-claw-artifacts-"));
		tempDirs.push(workspaceDir, outsideDir, stateDir);
		await writeWorkspaceFile(workspaceDir, "MEMORY.md", "Safe root memory.");
		await writeWorkspaceFile(outsideDir, "external.md", "Outside symlink traversal token.");
		await symlink(outsideDir, join(workspaceDir, "memory"));
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-symlink",
			agentKey: "agent-symlink",
		});

		const results = await searchCanonicalMemoryFiles({
			workspaceDir,
			query: "Outside symlink traversal token",
			maxResults: 10,
		});
		const artifacts = await listSnoStationMemProviderPublicArtifacts({
			store,
			identity,
			workspaceDir,
			stateDir,
		});

		expect(results).toEqual([]);
		expect(artifacts.map((artifact) => artifact.relativePath)).not.toContain("memory/external.md");
		await expect(
			readCanonicalMemoryFile({ workspaceDir, relPath: "memory/external.md" }),
		).rejects.toThrow(/not authorized|not found/i);
	});

	it("searches canonical files through the provider manager and exact-reads returned paths", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/runbook.md",
			"Provider canonical runbook\nThe Corinth release checklist lives in this file.",
		);
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-corpus",
			agentKey: "agent-corpus",
		});
		const manager = await createProviderManager(store, identity, workspaceDir);

		const results = await manager.search("Corinth release checklist", { maxResults: 5 });
		const canonical = results.find((result) => result.path === "memory/project/runbook.md");

		expect(canonical).toBeDefined();
		expect(canonical?.source).toBe("memory");
		expect(canonical?.snippet).toContain("Corinth release checklist");

		const read = await manager.readFile({ relPath: "memory/project/runbook.md" });
		expect(read.path).toBe("memory/project/runbook.md");
		expect(read.text).toContain("The Corinth release checklist lives in this file.");
	});

	it("round-trips every provider search result path through exact get", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/roundtrip.md",
			"Roundtrip provider search token appears in the canonical file.",
		);
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-roundtrip",
			agentKey: "agent-roundtrip",
		});
		const row = await store.store({
			text: "Roundtrip provider search token appears in the row memory.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const manager = await createProviderManager(store, identity, workspaceDir);

		const results = await manager.search("Roundtrip provider search token", { maxResults: 10 });
		const paths = results.map((result) => result.path);

		expect(paths).toContain(`mem-claw/${row.id}.md`);
		expect(paths).toContain("memory/project/roundtrip.md");
		for (const result of results) {
			const read = await manager.readFile({ relPath: result.path, from: result.startLine, lines: 1 });
			expect(read.path).toBe(result.path);
			expect(read.text.length).toBeGreaterThan(0);
		}
	});

	it("lists only authorized public memory artifacts and deterministic generated row views", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await createWorkspace();
		const stateDir = await mkdtemp(join(tmpdir(), "mem-claw-artifacts-"));
		tempDirs.push(workspaceDir, stateDir);
		await writeWorkspaceFile(workspaceDir, "MEMORY.md", "Public root memory artifact.");
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/runbook.md",
			"Public canonical memory artifact.",
		);
		await writeWorkspaceFile(workspaceDir, "USER.md", "Denied user public artifact.");
		await writeWorkspaceFile(workspaceDir, "sessions/a.md", "Denied session public artifact.");
		await writeWorkspaceFile(workspaceDir, ".openclaw/session.md", "Denied OpenClaw artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/config/settings.md", "Denied config artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/mappings/agents.md", "Denied mapping artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/secrets/api.md", "Denied secret artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/secret.md", "Denied secret file artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/secrets.md", "Denied secrets file artifact.");
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/instructions.md",
			"Denied instructions file artifact.",
		);
		await writeWorkspaceFile(workspaceDir, "memory/trace/audit.md", "Denied audit artifact.");
		await writeWorkspaceFile(workspaceDir, "memory/telemetry/output.md", "Denied telemetry artifact.");
		await symlink(join(workspaceDir, "USER.md"), join(workspaceDir, "memory", "escaped-user.md"));
		await symlink(
			join(workspaceDir, "memory", "secrets", "api.md"),
			join(workspaceDir, "memory", "escaped-secret.md"),
		);
		const projectA = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const projectB = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-b",
			agentKey: "agent-b",
		});
		const rowA = await store.store({
			text: "Project A public row artifact text.",
			category: "episodic",
			projectId: projectA.projectId,
			metadata: JSON.stringify({ source: "artifact-test" }),
			trusted: true,
		});
		const rowB = await store.store({
			text: "Project B public row artifact text must not leak.",
			category: "episodic",
			projectId: projectB.projectId,
			metadata: "{}",
			trusted: true,
		});

		const first = await listSnoStationMemProviderPublicArtifacts({
			store,
			identity: projectA,
			workspaceDir,
			stateDir,
		});
		const second = await listSnoStationMemProviderPublicArtifacts({
			store,
			identity: projectA,
			workspaceDir,
			stateDir,
		});
		const paths = first.map((artifact) => artifact.relativePath);
		const artifactJson = JSON.stringify(first);

		expect(paths).toEqual([...paths].sort());
		expect(paths).toContain("MEMORY.md");
		expect(paths).toContain("memory/project/runbook.md");
		expect(paths).toContain(`mem-claw/${rowA.id}.md`);
		expect(paths).not.toContain(`mem-claw/${rowB.id}.md`);
		expect(paths).not.toContain("USER.md");
		expect(paths).not.toContain("sessions/a.md");
		expect(paths).not.toContain(".openclaw/session.md");
		expect(paths).not.toContain("memory/config/settings.md");
		expect(paths).not.toContain("memory/mappings/agents.md");
		expect(paths).not.toContain("memory/secrets/api.md");
		expect(paths).not.toContain("memory/secret.md");
		expect(paths).not.toContain("memory/secrets.md");
		expect(paths).not.toContain("memory/project/instructions.md");
		expect(paths).not.toContain("memory/escaped-user.md");
		expect(paths).not.toContain("memory/escaped-secret.md");
		expect(paths).not.toContain("memory/trace/audit.md");
		expect(paths).not.toContain("memory/telemetry/output.md");
		expect(artifactJson).not.toContain("Denied secret file artifact.");
		expect(artifactJson).not.toContain("Denied secrets file artifact.");
		expect(artifactJson).not.toContain("Denied instructions file artifact.");
		expect(first).toEqual(second);
		expect(first.every((artifact) => artifact.agentIds.includes(projectA.agentId))).toBe(true);
		expect(first.every((artifact) => artifact.contentType === "markdown")).toBe(true);

		const rowArtifact = first.find((artifact) => artifact.relativePath === `mem-claw/${rowA.id}.md`);
		if (!rowArtifact) {
			throw new Error("expected project A generated row artifact");
		}
		const firstBody = await readFile(rowArtifact.absolutePath, "utf8");
		const secondBody = await readFile(
			second.find((artifact) => artifact.relativePath === rowArtifact.relativePath)?.absolutePath ?? "",
			"utf8",
		);
		expect(firstBody).toBe(secondBody);
		expect(firstBody).toContain("Project A public row artifact text.");
		expect(firstBody).not.toContain("Project B public row artifact text must not leak.");

		await store.delete(rowA.id);
		const afterDelete = await listSnoStationMemProviderPublicArtifacts({
			store,
			identity: projectA,
			workspaceDir,
			stateDir,
		});
		const manager = await createProviderManager(store, projectA, workspaceDir);

		expect(afterDelete.map((artifact) => artifact.relativePath)).not.toContain(rowArtifact.relativePath);
		await expect(manager.readFile({ relPath: rowArtifact.relativePath })).rejects.toThrow(
			/not authorized|not found/i,
		);
	});

	it("rejects unsafe public artifact project ids before filesystem writes", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}
		const testStore = store;

		const stateDir = await mkdtemp(join(tmpdir(), "mem-claw-artifacts-"));
		tempDirs.push(stateDir);
		const identity = await resolveProviderAuthority(testStore, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});

		for (const projectId of ["../escape", join(tmpdir(), "mem-claw-project-escape")]) {
			await expect(
				listSnoStationMemProviderPublicArtifacts({
					store,
					identity: { ...identity, projectId },
					stateDir,
				}),
			).rejects.toThrow(/project id|escaped/i);
		}
	});

	it("keeps generated row artifacts present across concurrent public artifact listings", async () => {
			if (!store) {
				throw new Error("test store was not initialized");
			}
			const testStore = store;

			const stateDir = await mkdtemp(join(tmpdir(), "mem-claw-artifacts-"));
		tempDirs.push(stateDir);
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-concurrent-artifacts",
			agentKey: "agent-concurrent-artifacts",
		});
		const rowA = await testStore.store({
			text: "Concurrent artifact row A.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const rowB = await testStore.store({
			text: "Concurrent artifact row B.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});

		const listings = await Promise.all(
			Array.from({ length: 5 }, () =>
				listSnoStationMemProviderPublicArtifacts({
					store: testStore,
					identity,
					stateDir,
				}),
			),
		);

		for (const artifacts of listings) {
			const paths = artifacts.map((artifact) => artifact.relativePath);
			expect(paths).toContain(`mem-claw/${rowA.id}.md`);
			expect(paths).toContain(`mem-claw/${rowB.id}.md`);
			for (const row of [rowA, rowB]) {
				const artifact = artifacts.find(
					(candidate) => candidate.relativePath === `mem-claw/${row.id}.md`,
				);
				if (!artifact) throw new Error(`missing artifact for ${row.id}`);
				await expect(readFile(artifact.absolutePath, "utf8")).resolves.toContain(row.text);
			}
		}
	});

	it("TEST-16/EVID-16 denies copied canonical paths across projects without remapping", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceA = await createWorkspace();
		const workspaceB = await createWorkspace();
		tempDirs.push(workspaceA, workspaceB);
		const projectAText = "Project A canonical file text must never leak to project B.";
		const projectBText = "Project B same relative path should not be a remap target.";
		await writeWorkspaceFile(workspaceA, "memory/project/runbook.md", projectAText);
		await writeWorkspaceFile(workspaceB, "memory/project/runbook.md", projectBText);
		const projectA = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const projectB = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-b",
			agentKey: "agent-b",
		});
		const managerA = await createProviderManager(store, projectA, workspaceA);
		const managerB = await createProviderManager(store, projectB, workspaceB);

		const projectAResults = await managerA.search("canonical file text", { maxResults: 5 });
		const copiedPath = projectAResults.find((result) => result.path === "memory/project/runbook.md")
			?.path;
		if (!copiedPath) {
			throw new Error("expected project A search to produce canonical path");
		}

		let thrown: unknown;
		try {
			const leaked = await managerB.readFile({ relPath: copiedPath });
			thrown = new Error(`Unexpected canonical file leak: ${JSON.stringify(leaked)}`);
		} catch (error) {
			thrown = error;
		}

		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toMatch(/not authorized|not found|denied/i);
		expect(message).not.toContain(projectAText);
		expect(message).not.toContain(projectBText);
		expect(message).not.toContain(projectA.projectId);

		const projectBResults = await managerB.search("same relative path", { maxResults: 5 });
		expect(projectBResults.some((result) => result.path === copiedPath)).toBe(true);
		const projectBRead = await managerB.readFile({ relPath: copiedPath });
		expect(projectBRead.text).toContain(projectBText);
	});

	it("denies readFile on a valid canonical path not yet seen by search or sync", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		await writeWorkspaceFile(
			workspaceDir,
			"MEMORY.md",
			"Root memory for authorized gate test.",
		);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/unseen.md",
			"This file exists but was never returned by search or sync.",
		);
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-authz-gate",
			agentKey: "agent-authz-gate",
		});
		const manager = await createProviderManager(store, identity, workspaceDir);

		await expect(
			manager.readFile({ relPath: "memory/project/unseen.md" }),
		).rejects.toThrow(/not authorized|not found/i);

		await expect(
			manager.readFile({ relPath: "MEMORY.md" }),
		).rejects.toThrow(/not authorized|not found/i);

		await manager.sync({ reason: "test" });

		const readAfterSync = await manager.readFile({ relPath: "memory/project/unseen.md" });
		expect(readAfterSync.text).toContain(
			"This file exists but was never returned by search or sync.",
		);
		const readRoot = await manager.readFile({ relPath: "MEMORY.md" });
		expect(readRoot.text).toContain("Root memory for authorized gate test.");
	});

	it("authorizes canonical paths discovered by search without requiring sync", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const workspaceDir = await createWorkspace();
		tempDirs.push(workspaceDir);
		await writeWorkspaceFile(
			workspaceDir,
			"memory/project/searchable.md",
			"Searchable canonical file with unique token Xylophone.",
		);
		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-search-authz",
			agentKey: "agent-search-authz",
		});
		const manager = await createProviderManager(store, identity, workspaceDir);

		await expect(
			manager.readFile({ relPath: "memory/project/searchable.md" }),
		).rejects.toThrow(/not authorized|not found/i);

		const results = await manager.search("Xylophone", { maxResults: 5 });
		expect(results.some((result) => result.path === "memory/project/searchable.md")).toBe(true);

		const read = await manager.readFile({ relPath: "memory/project/searchable.md" });
		expect(read.text).toContain("Searchable canonical file with unique token Xylophone.");
	});
});
