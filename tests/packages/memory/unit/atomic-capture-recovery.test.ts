import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAtomicGenericExtractionPass, createSignedAtomicGenericExtractionTransport, type AtomicGenericExtractionInput } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import { flushAuditWrites } from "../../../../packages/sno-station-mem/src/engine/operations/runtime-audit-log";

const roots: string[] = [];
afterEach(async () => {
	await flushAuditWrites();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(complete: AtomicGenericExtractionInput["transport"]["complete"]): AtomicGenericExtractionInput {
	const root = mkdtempSync(join(tmpdir(), "capture-recovery-"));
	roots.push(root);
	const runParameters = { maxInputTokens: 4096, outputTokenBudget: 4096, subchunkCount: 1 };
	// The store is an external boundary here; the extractor, parser and audit writer are real.
	const store = {
		dbPath: join(root, "memory.db"),
		beginAtomicExtractionChunk: () => ({ action: "run", entry: { runParameters } }),
		recordAtomicExtractionCalls: () => {},
		markAtomicExtractionPending: () => {},
	} as unknown as AtomicGenericExtractionInput["store"];
	return {
		store, ledgerKey: { conversationId: "session-recovery", chunkHash: "window-7", pipelineVersion: "atomic-v1" },
		turns: [{ role: "user", content: "Alex likes tea." }, { role: "assistant", content: "Sam lives in Rome." }],
		rawChunk: "Alex likes tea. Sam lives in Rome.", routingSnapshotId: "routing-test",
		runParameters, estimatedInputTokens: 30, nowMs: () => 1000, transport: { complete },
	};
}

it("recovers all source turns under a fixed token ceiling instead of doubling an unusable budget", async () => {
	const budgets: number[] = [];
	const request = input(async ({ prompt, maxTokens }) => {
		if (prompt.includes("\nfacts:\n")) return { text: "{}", truncated: false };
		budgets.push(maxTokens);
		const turns = JSON.parse(prompt.split("transcript:\n")[1]?.split("<take>\n")[1]?.split("\n</take>")[0] ?? "[]") as Array<{ content: string; role: string; turn_index: number }>;
		const neededTokens = turns.length * 3000;
		if (neededTokens > Math.min(maxTokens, 4096)) return { text: '{"claims_found":[', truncated: true, outputTokens: 4096 };
		return { truncated: false, text: JSON.stringify({
			claims_found: turns.map((turn) => turn.content),
			decisions: turns.filter((turn) => turn.role === "user").map((turn) => ({ turn_index: turn.turn_index, progress_only: false })),
			facts: turns.map((turn, id) => ({ id, fact: turn.content, subject: "Alex", subject_kind: "named_entity", temporal_phrase: null, ended_at_phrase: null, source_span: { turn_index: turn.turn_index, quote: turn.content } })),
		}) };
	});
	const result = await runAtomicGenericExtractionPass(request);
	console.info("local capture budget probe", { host: hostname(), budgets, result: result.status });
	expect(result.status).toBe("complete");
	if (result.status !== "complete") throw new Error("capture failed");
	expect(result.records.map((record) => [record.claimText, record.sourceSpan.turnIndex])).toEqual([["Alex likes tea.", 0], ["Sam lives in Rome.", 1]]);
	expect([...result.progressTurns]).toEqual([]);
	expect(budgets).toEqual([4096, 4096, 4096]);
});

it.each([
	["```json\n```", "unreadable-json"],
	['{"claims_found":[],"decisions":[]}', "capture-schema"],
	['{"claims_found":["Alex likes tea."],"decisions":[],"facts":[]}', "claims-without-facts"],
])("names the failed capture gate for %s", async (text, gate) => {
	let output = "";
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		output += String(chunk); return true;
	}) as typeof process.stderr.write);
	const result = await runAtomicGenericExtractionPass(input(async () => ({ text, truncated: false })));
	expect(result).toEqual({ status: "pending", reason: "parse-exhaustion" });
	expect(output).toContain(`"rejection_reason":"${gate}"`);
	expect(output).toContain("preview: ");
	expect(JSON.parse(output.trim().split("\n")[0] ?? "{}").body).toContain(text);
});

it.each([
	[false, "parse-exhaustion", 2],
	[true, "truncation-exhaustion", 3],
] as const)("writes one backfill audit entry for %s with scope, reason and attempts", async (truncated, reason, attempts) => {
	const request = input(async () => ({ text: "```json\n```", truncated }));
	await runAtomicGenericExtractionPass(request);
	await flushAuditWrites();
	const entries = readFileSync(join(roots[0] ?? "", "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ event: "error", errorCode: "atomic_capture_window_pending", scope: "session-recovery", resultStatus: "error", details: {
		reason, session_key: "session-recovery", chunk_hash: "window-7", pipeline_version: "atomic-v1", turn_count: 2, attempt_count: attempts,
	} });
});

it("forwards both budgets through the signed client into the HTTP body without a socket", async () => {
	const budgets: unknown[] = [];
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify({
			id: "did:web:www.sno.ai", verificationMethod: [{ id: "did:web:www.sno.ai#sno-mem-openclaw-release", type: "JsonWebKey2020", controller: "did:web:www.sno.ai", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" } }], assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"],
		}));
		const body = JSON.parse(String(init.body));
		budgets.push(body.max_tokens ?? body.max_completion_tokens);
		return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
	});
	const transport = createSignedAtomicGenericExtractionTransport({ apiKey: "test-key", baseURL: "https://llm.example.test/v1" });
	await transport.complete({ prompt: "test", maxTokens: 4096 });
	await transport.complete({ prompt: "test", maxTokens: 8192 });
	console.info("local signed transport probe", { host: hostname(), budgets });
	expect(budgets).toEqual([4096, 8192]);
});
