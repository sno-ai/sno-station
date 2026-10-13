import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { countTokens } from "@snoai/chunking";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { createBProfileKeyingTransport } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import {
	createAtomicGenericExtractionTransport,
	runAtomicGenericExtractionPass,
	type AtomicGenericExtractionInput,
} from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { flushAuditWrites } from "../../../../packages/memory/src/engine/operations/runtime-audit-log";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";

const routing = {
	mode: "rem-enhanced" as const,
	language: "en",
	modelCalls: JSON.parse(readFileSync(new URL("../../../../packages/memory/settings.default.json", import.meta.url), "utf8")).modelCalls,
};

const didDocument = {
	id: "did:web:www.sno.ai",
	verificationMethod: [{
		id: "did:web:www.sno.ai#sno-mem-openclaw-release",
		publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" },
	}],
};

afterEach(async () => {
	await flushAuditWrites();
	vi.unstubAllGlobals();
});

it("keeps the signed profile preset intact and sends the route's adapter model and trained prompt", async () => {
	const requests: Array<{ url: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify(didDocument));
		requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify({
			choices: [{ text: '{"profile_candidates":[]}', finish_reason: "stop" }],
			usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
		}));
	});
	const client = createLlmClient({ preset: "mem_claw/sno_ai_extract", apiKey: "test-key", routing });
	expect(await client.getResolvedConfig()).toMatchObject({ model: "qwen3.8-27b-extract" });
	expect(await createLlmClient({ preset: "mem_claw/sno_extract_profile", apiKey: "test-key", routing }).getResolvedConfig())
		.toMatchObject({ model: "qwen3.8-27b-extract" });
	const result = await createBProfileKeyingTransport(client).keyTurn({
		turnIndex: 0, turn: { role: "user", content: "I prefer tea.\n\nI live in Rome." },
	});
	expect(result).toEqual([]);
	expect(requests).toEqual([{
		url: "https://rt3-llm.sno.ai/extract/profile/v1/completions",
		body: { model: "b-profile", prompt: "user: I prefer tea.\nI live in Rome.", max_tokens: 4096 },
	}]);
});

it("sends the E1 chat route, base model and caller's output budget", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify(didDocument));
		requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify({
			choices: [{ message: { content: '{"claims_found":[],"decisions":[],"facts":[]}' } }],
			usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
		}));
	});
	const transport = createAtomicGenericExtractionTransport(createLlmClient({
		preset: "mem_claw/sno_extract_chat", apiKey: "test-key", routing,
	}));
	expect(await transport.complete({ callId: "E1", prompt: "Capture this conversation.", maxTokens: 16384 })).toEqual({
		text: '{"claims_found":[],"decisions":[],"facts":[]}', truncated: false, outputTokens: 16,
	});
	expect(requests[0]?.url).toBe("https://rt3-llm.sno.ai/extract/v1/chat/completions");
	expect(requests[0]?.body.model).toBe("qwen3.8-27b-extract");
	expect(requests[0]?.body.max_tokens).toBe(16384);
	expect(requests[0]?.body.messages).toEqual([
		{ role: "system", content: "You are a memory extraction assistant. Always respond with valid JSON only." },
		{ role: "user", content: "Capture this conversation." },
	]);
});

it.each([
	["underestimated single turn", false, false],
	["known single-turn overflow", true, false],
	["underestimated two-turn window", false, true],
] as const)("splits bounded requests and preserves both facts: %s", async (_name, estimatedOverflow, twoTurns) => {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	try {
		const first = `${"茶".repeat(3000)} Alex likes tea.`;
		const second = `${"狗".repeat(3000)} Alex has a dog.`;
		const transcript = `${first}\n\n${second}`;
		const request: AtomicGenericExtractionInput = {
			store,
			ledgerKey: { conversationId: "gpu-input-budget", chunkHash: "chinese-turn", pipelineVersion: "atomic-v1" },
			turns: twoTurns
				? [{ role: "user", content: first }, { role: "user", content: second }]
				: [{ role: "user", content: transcript }],
			rawChunk: transcript, routingSnapshotId: "test",
			runParameters: { maxInputTokens: 4096, outputTokenBudget: 16384, subchunkCount: 1 },
			estimatedInputTokens: estimatedOverflow ? 6000 : Math.ceil(transcript.length / 4),
			nowMs: () => 1000,
			transport: { async complete({ prompt, callId, maxTokens }) {
				const turns = JSON.parse(prompt.split("transcript:\n")[1]?.split("<take>\n")[1]?.split("\n</take>")[0] ?? "[]") as Array<{ content: string }>;
				const preceding = JSON.parse(prompt.split("preceding_context: ")[1]?.split("<take>\n")[1]?.split("\n</take>")[0] ?? "[]");
				const following = JSON.parse(prompt.split("following_context: ")[1]?.split("<take>\n")[1]?.split("\n</take>")[0] ?? "[]");
				expect(countTokens(JSON.stringify({ turns, preceding, following }))).toBeLessThanOrEqual(4096);
				expect(maxTokens).toBe(16384);
				if (callId === "E2") return { text: "{}", truncated: false };
				expect(callId).toBe("E1");
				const content = turns[0]?.content ?? "";
				const fact = content.includes("Alex likes tea.") ? "Alex likes tea." : "Alex has a dog.";
				return { truncated: false, text: JSON.stringify({
					claims_found: [fact], decisions: [{ turn_index: 0, progress_only: false }],
					facts: [{ id: 0, fact, subject: "Alex", subject_kind: "named_entity", temporal_phrase: null,
						ended_at_phrase: null, source_span: { turn_index: 0, quote: fact } }],
				}) };
			} },
		};
		const result = await runAtomicGenericExtractionPass(request);
		expect(result.status).toBe("complete");
		if (result.status !== "complete") throw new Error("Capture did not finish");
		expect(result.records.map(({ claimText, sourceSpan }) => [claimText, sourceSpan.turnIndex])).toEqual([
			["Alex likes tea.", 0], ["Alex has a dog.", twoTurns ? 1 : 0],
		]);
	} finally {
		await store.close();
		fixture.cleanup();
	}
});

it("records an unsplittable oversized turn as input-overflow without dispatching it", async () => {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder: await createTestEmbedder() });
	try {
		const result = await runAtomicGenericExtractionPass({
			store, ledgerKey: { conversationId: "oversized-no-break", chunkHash: "turn", pipelineVersion: "atomic-v1" },
			turns: [{ role: "user", content: "茶".repeat(6000) }],
			rawChunk: "茶".repeat(6000), routingSnapshotId: "test",
			runParameters: { maxInputTokens: 4096, outputTokenBudget: 16384, subchunkCount: 1 },
			estimatedInputTokens: 1500, nowMs: () => 1000,
			transport: { async complete() { throw new Error("Oversized request was dispatched"); } },
		});
		expect(result).toEqual({ status: "pending", reason: "input-overflow" });
		expect(fixture.runtime.db.prepare("SELECT state, reprocess_reason FROM nodix_atomic_extraction_ledger WHERE conversation_id = 'oversized-no-break'").get())
			.toEqual({ state: "pending_reprocess", reprocess_reason: "input-overflow" });
	} finally {
		await store.close();
		fixture.cleanup();
	}
});

it("asks the profile adapter once for a turn it answers with an empty completion", async () => {
	// The adapter ends at once on a turn off its trained shape; measured 2026-10-13 on a real
	// machine, 102 of 104 profile requests came back empty and each turn was asked six times.
	const requests: unknown[] = [];
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify(didDocument));
		requests.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify({
			choices: [{ text: "", finish_reason: "stop" }],
			usage: { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41 },
		}));
	});
	const client = createLlmClient({ preset: "mem_claw/sno_extract_profile", apiKey: "test-key", routing });
	const result = await createBProfileKeyingTransport(client).keyTurn({
		turnIndex: 0, turn: { role: "user", content: "```ts\nconst x = await run();\n```\nfix the failing build" },
	});
	expect(result).toEqual([]);
	expect(requests).toHaveLength(1);
});
