import { describe, expect, it } from "vitest";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/index.ts";
import { retrieveForAutoRecall } from "../../../../packages/memory/src/engine/retrieval/rem-consumer-retrieval.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

type ProductExports = Record<string, unknown>;

async function loadBoundary<T>(modulePath: string, name: string): Promise<T> {
	const product = (await import(modulePath)) as ProductExports;
	const candidate = product[name];
	expect(candidate, `missing production foundation boundary ${name}`).toBeTypeOf("function");
	return candidate as T;
}

describe("REM facet retrieval foundations", () => {
	it("uses the declared facet index in the actual production recall statement", async () => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			const build = await loadBoundary<(input: { facet: "current" }) => { sql: string; parameters: unknown[] }>(
				"../../../../packages/memory/src/engine/retrieval/retriever-search-modes.ts",
				"buildRemFacetRecallStatement",
			);
			const statement = build({ facet: "current" });
			const plan = fixture.runtime.raw
				.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
				.all(...statement.parameters) as Array<{ detail: string }>;
			expect(plan.map(({ detail }) => detail).join(" ")).toMatch(/facet.*index|index.*facet/i);
		} finally { fixture.cleanup(); }
	});

	it("exports one shared facet resolver for recall and eval answer assembly", async () => {
		const core = (await import("../../../../packages/memory/src/engine/rem/index.ts")) as ProductExports;
		expect(core["resolveRecallFacetPolicy"]).toBeUndefined();
		expect(core["resolveEvalFacetPolicy"]).toBeUndefined();
	});

	it("keeps history out of automatic context injection", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const retriever = {
			retrieve: async (input: Record<string, unknown>) => {
				calls.push(input);
				return [];
			},
		} as unknown as Parameters<typeof retrieveForAutoRecall>[0];

		await retrieveForAutoRecall(retriever, {
			query: "current preference",
			limit: 3,
			scopeFilter: ["global"],
			nowMs: 1,
		});

		expect(calls).toEqual([
			expect.objectContaining({
				source: "auto-recall",
				facetPolicy: "current-only",
			}),
		]);
	});
});
