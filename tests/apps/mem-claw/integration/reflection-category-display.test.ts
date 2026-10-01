/** Reflection storage remains internal; explicit host recall/get returns canonical service text. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { detectCategory } from "../../../../packages/memory/src/engine/extraction/capture-policy-detector";
import { buildInsightMetadata, stringifyInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { CJK_I18N_FIXTURE_MATRIX, CJK_LOCALES } from "../../../fixtures/cjk-fixtures";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness";
import { createTestEmbedder } from "../helpers/test-db";
import { asClawResult } from "../helpers/tool-result";

let embedder: Embedder;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => { embedder = await createTestEmbedder(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("reflection category storage and service display", () => {
	it("reads an internal reflection lesson through host recall/get while keeping canonical categories", async () => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const text = "When debugging the orchid gateway, read deployment logs before running tests.";
		const timestamp = Date.now();
		const lesson = await fixture.store.store({ text, category: "lesson", projectId: "global", timestamp,
			offlineFamily: true, metadata: stringifyInsightMetadata(buildInsightMetadata(
				{ text, category: "lesson", timestamp }, { asserted_at: timestamp, source: "manual",
					anti_pattern_signature: "reflection:orchid-debugging", type: "memory-reflection" },
			)) });
		const harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "reflection-category-display" });
		Object.assign(harness.config, { plugins: { slots: { memory: "sno-mem-claw" } } });
		memClawPlugin.register(harness);
		cleanups.push(() => harness.stopServices());
		const recall = harness.getRegisteredTool("memory_recall");
		const get = harness.getRegisteredTool("memory_get");
		const remember = harness.getRegisteredTool("memory_store");
		if (!recall || !get || !remember) throw new Error("expected registered host tools");
		const read = asClawResult(await get.execute("get-lesson", { id: lesson.id }));
		expect(read.isError).not.toBe(true);
		expect(read.content[0]?.text).toBe(`${lesson.id}\n${text}`);
		const recalled = asClawResult(await recall.execute("recall-lesson", { query: "orchid gateway deployment logs" }));
		expect(recalled.isError).not.toBe(true);
		expect(recalled.content[0]?.text).toContain(`${lesson.id}\t`);
		expect(recalled.content[0]?.text).toContain(text);
		const episodic = asClawResult(await remember.execute("remember-episodic", { content: "The orchid gateway release is on Friday." }));
		expect(episodic.isError).not.toBe(true);
		expect(fixture.store.getById(episodic.content[0]?.text ?? "")?.category).toBe("episodic");
		expect((await fixture.store.list({ category: "lesson" })).map(row => row.id)).toEqual([lesson.id]);
		expect((await fixture.store.stats()).categoryBreakdown).toMatchObject({ lesson: 1, episodic: 1 });
	});

	it.each(CJK_LOCALES)("keeps offline lesson content in its original language (%s)", async locale => {
		const fixture = await createMemUpdateFixture(embedder);
		cleanups.push(fixture.close);
		const text = CJK_I18N_FIXTURE_MATRIX.explicitRemember[locale];
		const lesson = await fixture.store.store({ text, category: "lesson", projectId: "global",
			offlineFamily: true, metadata: JSON.stringify({ anti_pattern_signature: `reflection:${locale}` }) });
		expect(fixture.store.getById(lesson.id)).toMatchObject({ text, category: "lesson" });
		expect((await fixture.store.stats()).categoryBreakdown.lesson).toBe(1);
	});

	it("never classifies captured text as the removed reflection category", () => {
		for (const text of ["I prefer Vim", "TypeScript is a superset of JavaScript", "We decided to use Node.js",
			"My email is test@example.com", "I notice I over-explain when simpler answers suffice"]) {
			expect(detectCategory(text)).not.toBe("reflection");
		}
	});
});
