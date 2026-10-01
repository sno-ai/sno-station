import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { registerAllMemoryTools } from "../../../../apps/mem-claw/src/tools/memory-tool-registration.ts";
import { resolveProviderAuthority } from "../../../../packages/memory/src/engine/provider/provider-authority.ts";
import { providerRowPath } from "../../../../packages/memory/src/engine/provider/provider-row-renderer.ts";
import type { ProviderIdentity } from "../../../../packages/memory/src/engine/provider/provider-types.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const userAlphaId = "019f3d5e-7a30-7cc0-8f4f-0b9c72e4a001";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

async function createProviderManager(store: MemoryStore, identity: ProviderIdentity) {
	const { SnoStationMemProviderSearchManager } = await import(
		"../../../../packages/memory/src/engine/provider/provider-search-manager.ts"
	);
	return new SnoStationMemProviderSearchManager({ store, identity });
}


function harnessAsMemoryToolApi(
	harness: OpenClawPluginApiHarness,
): Parameters<typeof registerAllMemoryTools>[0] {
	return harness as unknown as Parameters<typeof registerAllMemoryTools>[0];
}

describe("provider memory manager", () => {
	let store: MemoryStore | undefined;
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	});

	afterEach(() => {
		store?.closeSync();
		cleanup?.();
		store = undefined;
		cleanup = undefined;
	});

	it("keeps canonical recall tools separate from native provider aliases", () => {
		const harness = new OpenClawPluginApiHarness();

		if (!store) {
			throw new Error("test store was not initialized");
		}

		registerAllMemoryTools(harnessAsMemoryToolApi(harness), { connection: {} as never, stateDir: "/tmp/mem-claw-provider-manager-test" });

		expect(harness.getRegisteredTool("memory_recall")).toBeDefined();
		expect(harness.getRegisteredTool("memory_search")).toBeUndefined();
		expect(harness.getRegisteredTool("memory_get")).toBeUndefined();
	});

	it("searches provider row memories and reads generated mem-claw row paths", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const stored = await store.store({
			text: "Provider row search remembers the Tahoe launch checklist.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: JSON.stringify({ source: "provider-manager-test" }),
			trusted: true,
		});
		const manager = await createProviderManager(store, identity);

		const results = await manager.search("Tahoe launch checklist", {
			maxResults: 3,
			minScore: 0,
		});

		expect(results[0]?.path).toBe(`mem-claw/${stored.id}.md`);
		expect(results[0]?.source).toBe("memory");
		expect(results[0]?.snippet).toContain("Tahoe launch checklist");

		const firstResult = results[0];
		if (!firstResult) {
			throw new Error("expected provider search to return one result");
		}
		const read = await manager.readFile({ relPath: firstResult.path });
		expect(read.path).toBe(`mem-claw/${stored.id}.md`);
		expect(read.text).toContain("Provider row search remembers the Tahoe launch checklist.");
		expect(read.text).toContain("## Metadata");
		// `memory_layer` is derived on read, and `stringifyInsightMetadata` drops it before
		// the row is written, so it is never in a rendered row. `memory_category` is stored.
		expect(read.text).toContain("memory_category");
	});

	it("serves refused rows in provider search and read", async () => {
		if (!store) throw new Error("test store was not initialized");

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const clean = await store.store({
			text: "Provider refusal filter keeps this Tahoe checklist.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const refused = await store.store({
			text: "Provider refusal filter rejects this Tahoe checklist.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			dispositionReason: "subject_not_user",
		});
		const manager = await createProviderManager(store, identity);

		const results = await manager.search("Provider refusal filter Tahoe checklist", {
			maxResults: 5,
			minScore: 0,
		});

		expect(results.map((result) => result.path)).toContain(`mem-claw/${clean.id}.md`);
		expect(results.map((result) => result.path)).toContain(`mem-claw/${refused.id}.md`);
		await expect(
			manager.readFile({ relPath: `mem-claw/${refused.id}.md` }),
		).resolves.toBeDefined();
		await store.applyMetadataDeltas([
			{
				memoryId: clean.id,
				deltaFn: () => ({ invalidated_at: Date.now() }),
			},
		]);
		await expect(manager.readFile({ relPath: `mem-claw/${clean.id}.md` })).rejects.toThrow(
			/not authorized|not found/i,
		);
	});

	it("does not return row search results across project identities", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

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
		const projectAText = "Project A row search text must not appear in project B.";
		await store.store({
			text: projectAText,
			category: "episodic",
			projectId: projectA.projectId,
			metadata: JSON.stringify({ secret: "project-a-search-only" }),
			trusted: true,
		});
		const projectBManager = await createProviderManager(store, projectB);

		const results = await projectBManager.search("Project A row search text", {
			maxResults: 5,
			minScore: 0,
		});

		expect(results).toEqual([]);
		expect(JSON.stringify(results)).not.toContain(projectAText);
		expect(JSON.stringify(results)).not.toContain(projectA.projectId);
	});

	it("honors max results, minimum score, and memory source filtering for row search", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		await store.store({
			text: "Provider option search remembers the blue notebook.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		await store.store({
			text: "Provider option search remembers the red notebook.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const manager = await createProviderManager(store, identity);

		const oneResult = await manager.search("Provider option search notebook", {
			maxResults: 1,
			minScore: 0,
		});
		const blockedBySource = await manager.search("Provider option search notebook", {
			sources: ["sessions"],
		});
		const blockedByScore = await manager.search("Provider option search notebook", {
			minScore: 2,
		});

		expect(oneResult).toHaveLength(1);
		expect(blockedBySource).toEqual([]);
		expect(blockedByScore).toEqual([]);
	});

	it("supports bounded reads for generated row memory files", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const stored = await store.store({
			text: "First row line.\nSecond row line.\nThird row line.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const manager = await createProviderManager(store, identity);

		const read = await manager.readFile({
			relPath: `mem-claw/${stored.id}.md`,
			from: 2,
			lines: 2,
		});

		expect(read.path).toBe(`mem-claw/${stored.id}.md`);
		expect(read.text.split("\n").length).toBeLessThanOrEqual(2);
		const full = await manager.readFile({ relPath: `mem-claw/${stored.id}.md` });
		expect(read.text).toBe(full.text.split("\n").slice(1, 3).join("\n"));
		expect(read.from).toBe(2);
		expect(read.lines).toBe(2);
		expect(read.truncated).toBe(true);
	});

	it("falls back to keyword row search when the vector table is unavailable", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const stored = await store.store({
			text: "Keyword fallback should still find the Puebla deployment runbook.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		store.sqlite.exec("DROP TABLE nodix_memory_chunk_vectors");
		const manager = await createProviderManager(store, identity);
		const debug: unknown[] = [];

		const results = await manager.search("Puebla deployment runbook", {
			maxResults: 3,
			minScore: 0,
			onDebug: (entry) => debug.push(entry),
		});
		const status = manager.status();

		expect(results[0]?.path).toBe(`mem-claw/${stored.id}.md`);
		expect(results[0]?.textScore).toBeGreaterThan(0);
		expect(status.vector?.storeAvailable).toBe(false);
		expect(status.vector?.semanticAvailable).toBe(false);
		expect(status.vector?.available).toBe(false);
		expect(debug).toContainEqual(
			expect.objectContaining({
				backend: "qmd",
				effectiveMode: "sno-station-mem-row-keyword",
				fallback: "semantic-unavailable",
			}),
		);
	});

	it("uses keyword search while embedding availability is cached as failed", async () => {
		if (!store) throw new Error("test store was not initialized");

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const stored = await store.store({
			text: "Cached embedding failure still finds the Quito deployment checklist.",
			category: "episodic",
			projectId: identity.projectId,
			metadata: "{}",
			trusted: true,
		});
		const manager = await createProviderManager(store, identity);
		const originalEmbed = store.embedder.embed;
		const checkedAtMs = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(checkedAtMs);
		let attempts = 0;
		store.embedder.embed = async () => {
			attempts++;
			throw new Error("planted embedding outage");
		};

		try {
			await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: false });
			const first = await manager.search("Quito deployment checklist", { minScore: 0 });
			const second = await manager.search("Quito deployment checklist", { minScore: 0 });

			expect(attempts).toBe(1);
			expect(first[0]?.path).toBe(`mem-claw/${stored.id}.md`);
			expect(second[0]?.path).toBe(`mem-claw/${stored.id}.md`);
			expect(first[0]?.textScore).toBeGreaterThan(0);

			store.embedder.embed = originalEmbed;
			clock.mockReturnValue(checkedAtMs + 30_001);
			const recovered = await manager.search("Quito deployment checklist", { minScore: 0 });
			expect(recovered[0]?.vectorScore).toBeGreaterThan(0);
			expect(manager.getCachedEmbeddingAvailability()).toMatchObject({ ok: true });
		} finally {
			store.embedder.embed = originalEmbed;
			clock.mockRestore();
		}
	});

	it("reports degraded vector status when the vector table is unavailable", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		store.sqlite.exec("DROP TABLE nodix_memory_chunk_vectors");
		const manager = await createProviderManager(store, identity);

		const status = manager.status();

		expect(status.vector?.storeAvailable).toBe(false);
		expect(status.vector?.semanticAvailable).toBe(false);
		expect(status.vector?.available).toBe(false);
	});

	it("rejects malformed generated row paths", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-a",
			agentKey: "agent-a",
		});
		const manager = await createProviderManager(store, identity);

		expect(() => providerRowPath("../secret")).toThrow(/UUID/);
		expect(() => providerRowPath(`${identity.projectId}/../secret`)).toThrow(/UUID/);
		await expect(manager.readFile({ relPath: "mem-claw/../secret.md" })).rejects.toThrow(
			/not authorized|not found/i,
		);
		await expect(
			manager.readFile({ relPath: `mem-claw/${identity.projectId}/../secret.md` }),
		).rejects.toThrow(/not authorized|not found/i);
	});

	it("reports status, syncs without capture writes, and closes without stale identity reuse", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

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
		const stored = await store.store({
			text: "Project A close lifecycle row.",
			category: "episodic",
			projectId: projectA.projectId,
			metadata: "{}",
			trusted: true,
		});
		const managerA = await createProviderManager(store, projectA);
		const before = await store.stats(projectA.projectId);
		const progress: unknown[] = [];

		const status = managerA.status();
		await managerA.sync({ reason: "test", force: true, progress: (entry) => progress.push(entry) });
		await managerA.close();
		const after = await store.stats(projectA.projectId);
		const managerB = await createProviderManager(store, projectB);

		expect(status.provider).toBe("sno-mem-claw");
		expect(status.files).toBe(1);
		expect(status.vector?.dims).toBe(1024);
		expect(progress).toContainEqual(expect.objectContaining({ completed: 1, total: 1 }));
		expect(after.total).toBe(before.total);
		await expect(managerA.search("Project A close lifecycle row")).rejects.toThrow(/closed/i);
		await expect(managerB.readFile({ relPath: `mem-claw/${stored.id}.md` })).rejects.toThrow(
			/not authorized|not found/i,
		);
	});

	it("TEST-16/EVID-16 denies copied mem-claw row paths across projects without leaking content", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

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
		const sensitiveText = "Project A row text must never leak to project B.";
		const sensitiveMetadata = "alpha-only-provider-metadata";
		const projectARow = await store.store({
			text: sensitiveText,
			category: "episodic",
			projectId: projectA.projectId,
			metadata: JSON.stringify({ secret: sensitiveMetadata }),
			trusted: true,
		});
		const projectBManager = await createProviderManager(store, projectB);

		let thrown: unknown;
		try {
			const leaked = await projectBManager.readFile({ relPath: `mem-claw/${projectARow.id}.md` });
			thrown = new Error(`Unexpected provider row leak: ${JSON.stringify(leaked)}`);
		} catch (error) {
			thrown = error;
		}

		const message = thrown instanceof Error ? thrown.message : String(thrown);
		expect(message).toMatch(/not authorized|not found/i);
		expect(message).not.toContain(sensitiveText);
		expect(message).not.toContain(sensitiveMetadata);
		expect(message).not.toContain(projectA.projectId);
	});

	it("reports embedding availability through probe lifecycle and reflects it in status", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-probe",
			agentKey: "agent-probe",
		});
		const manager = await createProviderManager(store, identity);

		expect(manager.getCachedEmbeddingAvailability()).toBeNull();
		const statusBefore = manager.status();
		expect(statusBefore.vector?.semanticAvailable).toBe(false);
		expect(statusBefore.vector?.available).toBe(false);

		const probe = await manager.probeEmbeddingAvailability();
		expect(probe.ok).toBe(true);
		expect(probe.checked).toBe(true);

		const cached = manager.getCachedEmbeddingAvailability();
		expect(cached).not.toBeNull();
		expect(cached?.ok).toBe(true);

		const statusAfter = manager.status();
		expect(statusAfter.vector?.semanticAvailable).toBe(true);
		expect(statusAfter.vector?.available).toBe(true);
		expect(statusAfter.vector).not.toHaveProperty("loadError");
	});

	it("populates vector loadError in status when the embedding probe fails", async () => {
		if (!store) {
			throw new Error("test store was not initialized");
		}

		const identity = await resolveProviderAuthority(store, {
			trustedUserId: userAlphaId,
			externalSystem: "openclaw",
			projectKey: "project-broken-embed",
			agentKey: "agent-broken-embed",
		});
		const manager = await createProviderManager(store, identity);
		const realEmbedder = store.embedder;
		const brokenEmbedder = Object.create(realEmbedder);
		brokenEmbedder.embed = () =>
			Promise.reject(new Error("ONNX runtime failed to load model"));
		Object.defineProperty(store, "embedder", {
			value: brokenEmbedder,
			configurable: true,
		});

		try {
			const probe = await manager.probeEmbeddingAvailability();
			expect(probe.ok).toBe(false);
			expect(probe.error).toContain("ONNX runtime failed to load model");
			expect(probe.checked).toBe(true);

			const cached = manager.getCachedEmbeddingAvailability();
			expect(cached?.ok).toBe(false);

			const status = manager.status();
			expect(status.vector?.semanticAvailable).toBe(false);
			expect(status.vector?.available).toBe(false);
			expect(status.vector?.loadError).toContain("ONNX runtime failed to load model");
		} finally {
			Object.defineProperty(store, "embedder", {
				value: realEmbedder,
				configurable: true,
			});
		}
	});
});
