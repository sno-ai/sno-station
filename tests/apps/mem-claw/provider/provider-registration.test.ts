/** Real OpenClaw registration and canonical provider tools over the real HTTP memory service. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness";
import { createTestDb, createTestEmbedder } from "../helpers/test-db";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { asClawResult } from "../helpers/tool-result";

let embedder: Embedder;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => { embedder = await createTestEmbedder(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("provider registration", () => {
	it("rejects native search when the real service reports model preparation unavailable", async () => {
		const database = createTestDb();
		cleanups.push(async () => { database.cleanup(); });
		let requests = 0;
		const mirror = createServer((_request, response) => { requests++; response.writeHead(503).end("model mirror unavailable"); });
		await new Promise<void>(resolve => mirror.listen(0, "127.0.0.1", resolve));
		cleanups.push(async () => { mirror.closeAllConnections(); await new Promise<void>(resolve => mirror.close(() => resolve())); });
		const address = mirror.address();
		if (!address || typeof address === "string") throw new Error("missing model mirror port");
		const profile = process.env.SNO_PROFILE_DIR;
		if (!profile) throw new Error("missing isolated profile");
		writeSettingsFixture(profile, { mode: "local-first", rerank: { mode: "none" }, rem: { tick: false },
			store: { path: database.dbPath, encryptionKey: database.encryptionKey },
			embedding: { cacheDir: join(profile, "cold-model-cache"), mirror: `http://127.0.0.1:${address.port}` } });
		const sidecar = await startRemSidecar();
		cleanups.push(sidecar.stop);
		const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "provider-unavailable" });
		Object.assign(harness.config, { plugins: { slots: { memory: "sno-mem-claw" } },
			agents: { list: [{ id: "provider-unavailable", workspace: profile }] } });
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		const runtime = harness.registeredMemoryCapabilities[0]?.runtime;
		if (!runtime) throw new Error("missing provider runtime");
		const native = await runtime.getMemorySearchManager({ cfg: harness.config, agentId: "provider-unavailable" });
		if (!native.manager) throw new Error("missing native search manager");
		await expect(native.manager.search("Find the unavailable model memory", { sources: ["memory"] }))
			.rejects.toThrow(/model-preparing|model preparation failed/);
		await vi.waitFor(() => expect(requests).toBeGreaterThan(0), { timeout: 5000 });
	});
	it("registers query-only recall and id-only get once and reads canonical content", async () => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "provider-registration" });
		Object.assign(harness.config, { plugins: { slots: { memory: "sno-mem-claw" } },
			agents: { list: [{ id: "provider-registration", workspace: fixture.profile }] } });
		memClawPlugin.register(harness);
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		expect(harness.registeredMemoryCapabilities).toHaveLength(1);
		expect(harness.registeredTools.map(tool => tool.name)).toEqual([
			"memory_recall", "memory_store", "memory_correct", "memory_search", "memory_get",
		]);
		const recall = harness.getRegisteredTool("memory_recall");
		const search = harness.getRegisteredTool("memory_search");
		const get = harness.getRegisteredTool("memory_get");
		const remember = harness.getRegisteredTool("memory_store");
		if (!recall || !search || !get || !remember) throw new Error("missing provider tools");
		expect(search.parameters).toMatchObject({ properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false });
		expect(Object.keys(search.parameters.properties)).toEqual(["query"]);
		expect(get.parameters).toMatchObject({ properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false });
		expect(Object.keys(get.parameters.properties)).toEqual(["id"]);
		const prompt = harness.registeredMemoryCapabilities[0]?.promptBuilder?.({ availableTools: new Set(["memory_search", "memory_get"]) })?.join("\n") ?? "";
		expect(prompt).toContain("memory_get with an id");
		expect(prompt).toContain("memory_correct");
		expect(prompt).toContain("no model delete action");
		const content = "The Yukon release checklist requires the cedar rollback procedure.";
		const stored = asClawResult(await remember.execute("provider-remember", { content }));
		expect(stored.isError).not.toBe(true);
		const id = stored.content[0]?.text ?? "";
		expect(fixture.store.getById(id)?.text).toBe(content);
		const canonical = asClawResult(await recall.execute("provider-recall", { query: "Yukon release checklist" }));
		const alias = asClawResult(await search.execute("provider-search", { query: "Yukon release checklist" }));
		expect(alias.isError).not.toBe(true);
		expect(alias.content).toEqual(canonical.content);
		expect(alias.content[0]?.text).toContain(`${id}\t`);
		const full = asClawResult(await get.execute("provider-get", { id }));
		expect(full.isError).not.toBe(true);
		expect(full.content[0]?.text).toBe(`${id}\n${content}`);
		for (const input of [{ path: "MEMORY.md" }, { id, from: 1 }]) {
			const invalid = asClawResult(await get.execute("provider-get-old-input", input));
			expect(invalid.isError).toBe(true);
			expect(invalid.content[0]?.text).toBe("invalid-input");
		}
	});

	it("keeps configured workspaces separate in native provider file reads", async () => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const workspaceA = join(fixture.profile, "workspace-a");
		const workspaceB = join(fixture.profile, "workspace-b");
		for (const workspace of [workspaceA, workspaceB]) mkdirSync(workspace);
		writeFileSync(join(workspaceA, "MEMORY.md"), "Alpha workspace deployment marker.");
		writeFileSync(join(workspaceB, "MEMORY.md"), "Beta workspace deployment marker.");
		const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "agent-a" });
		Object.assign(harness.config, { plugins: { slots: { memory: "sno-mem-claw" } },
			agents: { list: [{ id: "agent-a", workspace: workspaceA }, { id: "agent-b", workspace: workspaceB }] } });
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		const runtime = harness.registeredMemoryCapabilities[0]?.runtime;
		if (!runtime) throw new Error("missing provider runtime");
		const a = await runtime.getMemorySearchManager({ cfg: harness.config, agentId: "agent-a" });
		const b = await runtime.getMemorySearchManager({ cfg: harness.config, agentId: "agent-b" });
		if (!a.manager || !b.manager) throw new Error("missing native provider managers");
		expect(a.manager.status().workspaceDir).toBe(workspaceA);
		expect(b.manager.status().workspaceDir).toBe(workspaceB);
		expect((await a.manager.search("Alpha workspace deployment", { sources: ["memory"] })).map(hit => hit.path)).toContain("MEMORY.md");
		expect((await b.manager.search("Beta workspace deployment", { sources: ["memory"] })).map(hit => hit.path)).toContain("MEMORY.md");
		expect((await a.manager.readFile({ relPath: "MEMORY.md" })).text).toContain("Alpha workspace");
		expect((await b.manager.readFile({ relPath: "MEMORY.md" })).text).toContain("Beta workspace");
		const artifacts = await harness.registeredMemoryCapabilities[0]?.publicArtifacts?.listArtifacts({ cfg: harness.config });
		expect(artifacts?.filter(artifact => artifact.relativePath === "MEMORY.md").map(artifact => artifact.workspaceDir).sort()).toEqual([workspaceA, workspaceB]);
	});

	it("omits provider tools when another memory slot is selected", () => {
		const harness = new OpenClawPluginApiHarness({});
		Object.assign(harness.config, { plugins: { slots: { memory: "memory-core" } } });
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		expect(harness.registeredMemoryCapabilities).toHaveLength(0);
		expect(harness.getRegisteredTool("memory_search")).toBeUndefined();
		expect(harness.getRegisteredTool("memory_get")).toBeUndefined();
	});
});
