import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { withMemoryOperation } from "../../../../packages/memory/src/engine/operation-cancellation";
import type { ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import type { LlmRoutingConfig } from "../../../../packages/memory/src/model/llm-mode-routing";

const routing: LlmRoutingConfig = {
	mode: "rem-enhanced", language: "en",
	modelCalls: JSON.parse(readFileSync(new URL("../../../../packages/memory/settings.default.json", import.meta.url), "utf8")).modelCalls,
};
const didDocument = {
	id: "did:web:www.sno.ai",
	verificationMethod: [{ id: "did:web:www.sno.ai#sno-mem-openclaw-release",
		publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" } }],
};

function provider(waitMs: number): void {
	vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify(didDocument));
		await delay(waitMs, undefined, { signal: init.signal ?? undefined });
		const raw = "prompt" in JSON.parse(String(init.body));
		return new Response(JSON.stringify({ choices: [raw
			? { text: '{"records":[]}' } : { message: { content: '{"records":[]}' } }],
			usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	}));
}

function client(timeoutMs = 25, route = routing) {
	return createLlmClient({ preset: "mem_claw/sno_ai_extract", apiKey: "test-key", timeoutMs, routing: route });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["E4", "E5", "E6", "E9"] as const)("uses the capture deadline for GPU extraction %s instead of the config default", async callId => {
	provider(60);
	const llm = client();
	await withMemoryOperation("capture", undefined, async () => {
		if (callId === "E6") expect(await llm.completeJson({ callId, prompt: "Extract records." })).toEqual({ records: [] });
		else expect(await llm.completeText({ callId, prompt: "Extract records.", maxTokens: 128 })).toBe('{"records":[]}');
	}, performance.now() + 1000);
	provider(80);
	await withMemoryOperation("capture", undefined, async () => {
		const request = { callId, prompt: "Extract records before the capture expires.", maxTokens: 128 };
		await expect(callId === "E6" ? llm.completeJson(request) : llm.completeText(request))
			.rejects.toMatchObject({ category: "timeout" });
	}, performance.now() + 40);
});

it("shares the absolute capture deadline across sequential GPU extraction calls", async () => {
	provider(140);
	const llm = client(2000);
	const started = performance.now();
	await withMemoryOperation("capture", undefined, async () => {
		expect(await llm.completeText({ callId: "E4", prompt: "First records.", maxTokens: 128 })).toBe('{"records":[]}');
		await expect(llm.completeText({ callId: "E5", prompt: "Next records.", maxTokens: 128 }))
			.rejects.toMatchObject({ category: "timeout" });
	}, started + 240);
	expect(performance.now() - started).toBeLessThan(600);
});

it("does not dispatch GPU extraction when the capture deadline is already exhausted", async () => {
	provider(1);
	const llm = client();
	await withMemoryOperation("capture", undefined, async () => {
		await expect(llm.completeText({ callId: "E4", prompt: "Late records.", maxTokens: 128 }))
			.rejects.toMatchObject({ category: "timeout" });
	}, performance.now() - 1);
	expect(vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.body)).toHaveLength(0);
});

it("keeps an explicit shorter GPU request deadline", async () => {
	provider(80);
	const llm = client(2000);
	await withMemoryOperation("capture", undefined, async () => {
		await expect(llm.completeText({ callId: "E4", prompt: "Short records.", maxTokens: 128, timeoutMs: 25 }))
			.rejects.toMatchObject({ category: "timeout" });
	}, performance.now() + 1000);
});

it.each(["E10", "REM3"] satisfies ModelCallId[])("keeps the existing GPU budget for excluded call %s", async callId => {
	provider(80);
	const llm = client();
	await withMemoryOperation("capture", undefined, async () => {
		await expect(llm.completeText({ callId, prompt: "Other operation.", maxTokens: 128 }))
			.rejects.toMatchObject({ category: "timeout" });
	}, performance.now() + 1000);
});

it("keeps the host extraction budget", async () => {
	let hostTimeout: number | undefined;
	const llm = createLlmClient({ preset: "mem_claw/sno_ai_extract", timeoutMs: 25,
		routing: { ...routing, mode: "agent-native" }, agentPort: {
			async complete(request) { hostTimeout = request.timeoutMs; return { kind: "ok", text: '{"records":[]}' }; },
		} });
	await withMemoryOperation("capture", undefined, async () => {
		expect(await llm.completeText({ callId: "E4", prompt: "Host records." })).toBe('{"records":[]}');
	}, performance.now() + 1000);
	expect(hostTimeout).toBe(25);
});

it.each([undefined, 600_000])("uses the standalone GPU fallback only when no request deadline was supplied (%s)", async timeoutMs => {
	provider(1);
	const timeout = vi.spyOn(AbortSignal, "timeout");
	expect(await client().completeText({ callId: "E4", prompt: "Standalone records.", maxTokens: 128, timeoutMs })).toBe('{"records":[]}');
	const expected = timeoutMs ?? 300_000;
	expect(timeout.mock.calls.some(([ms]) => ms > expected - 1000 && ms <= expected)).toBe(true);
	expect(timeout.mock.calls.some(([ms]) => ms > 299_000 && ms <= 300_000)).toBe(timeoutMs === undefined);
});


it("preserves a host fallback answer when completion logging crosses the capture deadline", async () => {
	vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
		if (!init?.body) return new Response(JSON.stringify(didDocument));
		return new Response("GPU unavailable", { status: 503 });
	});
	const deadline = performance.now() + 10_000;
	const llm = createLlmClient({ preset: "mem_claw/sno_ai_extract", apiKey: "test-key", routing,
		agentPort: {
			async complete() {
				vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
				return { kind: "ok", text: '{"records":[]}' };
			},
		} });
	await withMemoryOperation("capture", undefined, async () => {
		expect(await llm.completeText({ callId: "E4", prompt: "Recover these records.", maxTokens: 128 }))
			.toBe('{"records":[]}');
	}, deadline);
});
