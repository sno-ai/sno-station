/** Real service registration and encrypted-store effects after repeated OpenClaw registration. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness";
import { createTestEmbedder } from "../helpers/test-db";
import { asClawResult } from "../helpers/tool-result";

let embedder: Embedder;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => { embedder = await createTestEmbedder(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("OpenClaw connection lifecycle", () => {
	it("keeps one host registration and usable retained tools after repeated registration", async () => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "runtime-single-connection" });
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		const counts = [harness.registeredTools.length, harness.registeredServices.length,
			harness.registeredOnHooks.length, harness.registeredCli.length];
		const remember = harness.getRegisteredTool("memory_store");
		const recall = harness.getRegisteredTool("memory_recall");
		if (!remember || !recall) throw new Error("retained memory tools were not registered");
		for (let index = 0; index < 4; index += 1) memClawPlugin.register(harness);
		expect([harness.registeredTools.length, harness.registeredServices.length,
			harness.registeredOnHooks.length, harness.registeredCli.length]).toEqual(counts);
		expect(harness.registeredServices).toHaveLength(1);
		expect(harness.registeredCommands).toHaveLength(0);
		await harness.startServices();
		const content = "Repeated gateway registration retains the searchable orchid deployment note.";
		const stored = asClawResult(await remember.execute("retained-store", { content }));
		expect(stored.isError).not.toBe(true);
		const id = stored.content[0]?.text ?? "";
		expect(fixture.store.getById(id)?.text).toBe(content);
		const recalled = asClawResult(await recall.execute("retained-recall", { query: "orchid deployment" }));
		expect(recalled.isError).not.toBe(true);
		expect(recalled.content[0]?.text).toContain(id);
		expect(recalled.content[0]?.text).toContain(content);
	});

	it("gives a distinct host registry usable tools and its own service lifecycle", async () => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const first = new OpenClawPluginApiHarness({}, { runtimeAgentId: "runtime-first" });
		const second = new OpenClawPluginApiHarness({}, { runtimeAgentId: "runtime-first" });
		Object.assign(second.config, { plugins: { slots: { memory: "sno-mem-claw" } } });
		for (const harness of [first, second]) {
			Object.assign(harness.config, { agents: { defaults: { workspace: fixture.profile } } });
			memClawPlugin.register(harness);
			cleanups.push(() => harness.stopServices());
			await harness.startServices();
		}
		expect(second.registeredServices).toHaveLength(1);
		expect(second.registeredCommands).toHaveLength(0);
		expect(second.registeredTools.map(tool => tool.name).sort()).toEqual([
			"memory_correct", "memory_get", "memory_recall", "memory_search", "memory_store",
		]);
		const remember = first.getRegisteredTool("memory_store");
		const get = second.getRegisteredTool("memory_get");
		if (!remember || !get) throw new Error("expected tools on both host registries");
		const content = "Separate gateway host registries share the persisted cedar runbook.";
		const stored = asClawResult(await remember.execute("first-store", { content }));
		expect(stored.isError).not.toBe(true);
		const id = stored.content[0]?.text ?? "";
		const read = asClawResult(await get.execute("second-get", { id }));
		expect(read.isError, JSON.stringify(read)).not.toBe(true);
		expect(read.content[0]?.text).toBe(`${id}\n${content}`);
		await first.stopServices();
		const next = second.getRegisteredTool("memory_store");
		if (!next) throw new Error("second host remember tool is missing");
		const remainingContent = "The second host keeps the surviving cypress deployment note.";
		const remaining = asClawResult(await next.execute("second-after-first-stop", { content: remainingContent }));
		expect(remaining.isError, JSON.stringify(remaining)).not.toBe(true);
		const remainingId = remaining.content[0]?.text ?? "";
		expect(fixture.store.getById(remainingId)?.text).toBe(remainingContent);
		expect(asClawResult(await get.execute("second-get-after-first-stop", { id: remainingId })).content[0]?.text)
			.toBe(`${remainingId}\n${remainingContent}`);
	});
});
