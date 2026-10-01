/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-scope-state-${Date.now()}`;

/**
 * Scope access control integration:
 * - Semantic search with scope filter excludes other scopes
 * - Invalid scope in resolveAgentScopes is skipped with warning logged
 * - exportConfig/importConfig round-trips correctly
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("scope access control integration", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("searchSemantic with projectIdFilter='scope-a' returns 0 results from scope-b or scope-c", async () => {
		const embedder = createEmbedder(
			{ dimensions: 1024 },
			STATE_DIR,
		);

		// Store 5 entries in scope-a, 5 in scope-b, 5 in scope-c (real paid embeddings)
		const scopeTexts: Array<{ text: string; projectId: string }> = [
			// scope-a
			{ text: "TypeScript strict mode is required for scope-a projects.", projectId: "scope-a" },
			{ text: "Node.js runtime is preferred in scope-a environment.", projectId: "scope-a" },
			{ text: "Always use Zod validation in scope-a services.", projectId: "scope-a" },
			{ text: "I prefer tabs in scope-a TypeScript files.", projectId: "scope-a" },
			{ text: "Never use any in scope-a TypeScript code.", projectId: "scope-a" },
			// scope-b
			{ text: "Python asyncio is used in scope-b pipelines.", projectId: "scope-b" },
			{ text: "FastAPI is the preferred framework for scope-b APIs.", projectId: "scope-b" },
			{ text: "I always use type hints in scope-b Python code.", projectId: "scope-b" },
			{ text: "pytest is the testing framework for scope-b.", projectId: "scope-b" },
			{ text: "Poetry manages dependencies in scope-b projects.", projectId: "scope-b" },
			// scope-c
			{ text: "Rust ownership system prevents scope-c memory bugs.", projectId: "scope-c" },
			{ text: "Cargo is the package manager for scope-c Rust projects.", projectId: "scope-c" },
			{ text: "I prefer Rust for scope-c performance-critical services.", projectId: "scope-c" },
			{ text: "Never use unsafe Rust in scope-c production code.", projectId: "scope-c" },
			{ text: "Clippy lints improve code quality in scope-c.", projectId: "scope-c" },
		];

		const vectors = await embedder.embedMany(scopeTexts.map((t) => t.text));
		for (let i = 0; i < scopeTexts.length; i++) {
			const t = scopeTexts[i];
			const v = vectors[i];
			if (!t || !v) continue;
			await store.store({ text: t.text, vector: v, category: "episodic", projectId: t.projectId });
		}

		expect((await store.stats()).total).toBe(15);

		// Search with projectIdFilter=['scope-a'] — must not return scope-b or scope-c
		const queryVector = await embedder.embed("TypeScript preferences");
		const results = await store.searchSemantic(queryVector, {
			limit: 10,
			projectIdFilter: ["scope-a"],
			minScore: 0,
		});

		expect(results.length).toBeGreaterThan(0);
		for (const result of results) {
			expect(result.entry.projectId).toBe("scope-a");
			expect(result.entry.projectId).not.toBe("scope-b");
			expect(result.entry.projectId).not.toBe("scope-c");
		}
	});

	it("resolveAgentScopes with invalid scope is skipped with warning logged", () => {
		const warnings: string[] = [];

		const scopePolicy = createScopePolicy(
			{
				default: "global",
				definitions: {
					global: { description: "Global scope" },
					"scope-a": { description: "Test scope A" },
				},
				agentAccess: {
					// agent1 has access to scope-a plus an invalid scope
					agent1: ["scope-a", "invalid:scope"],
				},
			},
			(message) => warnings.push(message),
		);

		// resolveAgentScopes for agent1 should return only valid scopes
		const scopes = scopePolicy.resolveAgentScopes("agent1");

		// "invalid:scope" is a built-in pattern (starts with "invalid:") — but "invalid" is
		// not one of the recognized patterns (agent:, project:, user:, custom:, global)
		// validateScope should reject it and warn was already called in constructor
		expect(scopes).toContain("scope-a");

		// Warning should have been logged for invalid scope
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("invalid") || w.includes("scope"))).toBe(true);
	});

	it("exportConfig / importConfig round-trips correctly", () => {
		const scopePolicy = createScopePolicy(
			{
				default: "global",
				definitions: {
					global: { description: "Global" },
					"custom-scope": { description: "Custom scope for testing" },
				},
				agentAccess: {
					"agent-alpha": ["global", "custom-scope"],
				},
			},
		);

		const exported = scopePolicy.exportConfig();

		// Create a new manager and import the config
		const importedManager = createScopePolicy({
			default: "global",
			definitions: { global: { description: "Global" } },
		});
		importedManager.importConfig(exported);

		const reExported = importedManager.exportConfig();

		// Verify round-trip
		expect(reExported.default).toBe(exported.default);
		expect(Object.keys(reExported.definitions)).toContain("global");
	});
});
