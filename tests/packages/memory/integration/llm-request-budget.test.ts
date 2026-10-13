import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";
import { SNO_STATION_MEM_RELEASE_ANCHOR_URL } from "../../../../packages/memory/src/model/llmix-registry";

const originalFetch = globalThis.fetch;
const didDocument = {
	"@context": ["https://www.w3.org/ns/did/v1"],
	id: "did:web:www.sno.ai",
	verificationMethod: [{
		id: "did:web:www.sno.ai#sno-mem-openclaw-release",
		type: "JsonWebKey2020", controller: "did:web:www.sno.ai",
		publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" },
	}],
	assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"],
};

async function serve(reply: (request: IncomingMessage, response: ServerResponse) => void) {
	const paths: string[] = [];
	const server = createServer((request, response) => {
		request.resume();
		paths.push(request.url ?? "");
		reply(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let address = server.address();
	while (address && typeof address !== "string" && address.port <= 10_080) {
		await close(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		address = server.address();
	}
	if (!address || typeof address === "string") throw new Error("expected a TCP address");
	return { server, paths, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function answer(response: ServerResponse, content: string): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ choices: [{ text: content, message: { content } }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}

function client(snoUrl: string, hostUrl: string) {
	return createLlmClient({
		preset: "mem_claw/sno_ai_extract", apiKey: "test-key", baseURL: snoUrl,
		routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
		agentPort: new RegisteredAgentPort({ baseUrl: `${hostUrl}/host/v1`, credential: "host-key", model: "host-model" }),
	});
}

describe("LLM request deadline and attempt budget", () => {
	beforeEach(() => {
		globalThis.fetch = ((input, init) => String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL
			? Promise.resolve(new Response(JSON.stringify(didDocument), { status: 200 }))
			: originalFetch(input, init)) as typeof fetch;
	});
	afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

	it.each(["empty", "error"] as const)("passes only the remaining deadline to the host after GPU %s", async failure => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		let elapsed = 0;
		const sno = await serve((_request, response) => {
			elapsed += failure === "empty" ? 250 : 750;
			clock.mockReturnValue(elapsed);
			if (failure === "empty") answer(response, "");
			else { response.writeHead(401); response.end(); }
		});
		const host = await serve((request, response) => answer(response, JSON.stringify({ deadline: request.headers["x-sno-deadline"] })));
		try {
			const llm = client(sno.url, host.url);
			expect(await llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 1_000 }))
				.toEqual({ deadline: "10250" });
			expect(host.paths).toEqual(["/host/v1/chat/completions"]);
		} finally { await close(sno.server); await close(host.server); }
	});

	it.each(["empty", "error"] as const)("does not ask the host after GPU %s exhausts the deadline", async failure => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const sno = await serve((_request, response) => {
			clock.mockReturnValue(1_000);
			if (failure === "empty") answer(response, "");
			else { response.writeHead(401); response.end(); }
		});
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const llm = client(sno.url, host.url);
			const result = llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 1_000 });
			if (failure === "empty") expect(await result).toBeNull();
			else await expect(result).rejects.toMatchObject({ name: "LlmClientTerminalError", category: "auth" });
			expect(host.paths).toEqual([]);
			expect(sno.paths).toEqual(["/extract/profile/v1/completions"]);
		} finally { await close(sno.server); await close(host.server); }
	});

	it.each(["E1", "E9", "REM1"] as const)("shares three GPU attempts between transport retries and empty replies for %s", async callId => {
		let sent = 0;
		const sno = await serve((_request, response) => {
			if (++sent % 3 !== 0) { response.writeHead(503); response.end(); }
			else answer(response, "");
		});
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const llm = client(sno.url, host.url);
			const request = { callId, prompt: "Return the judgment", hostPrompt: "Return the host judgment", maxTokens: 32, timeoutMs: 10_000 };
			const result = callId === "REM1" ? await llm.completeText(request) : await llm.completeJson(request);
			expect(result).toEqual(callId === "REM1" ? '{"from":"host"}' : { from: "host" });
			expect(sno.paths).toHaveLength(3);
			expect(host.paths).toEqual(["/host/v1/chat/completions"]);
			expect(llm.getLastUsage()).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
			const next = callId === "REM1" ? await llm.completeText(request) : await llm.completeJson(request);
			expect(next).toEqual(callId === "REM1" ? '{"from":"host"}' : { from: "host" });
			expect(sno.paths).toHaveLength(6);
			expect(host.paths).toEqual(["/host/v1/chat/completions", "/host/v1/chat/completions"]);
		} finally { await close(sno.server); await close(host.server); }
	});

	it("keeps the actual GPU timeout without dispatching a host request", async () => {
		const sno = await serve(() => {});
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const llm = client(sno.url, host.url);
			await expect(llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 500 }))
				.rejects.toMatchObject({ name: "LlmClientTerminalError", category: "timeout" });
			expect(sno.paths).toEqual(["/extract/profile/v1/completions"]);
			expect(host.paths).toEqual([]);
		} finally { await close(sno.server); await close(host.server); }
	});

	it("ends a slow host fallback within the same real request deadline", async () => {
		let snoTimer: ReturnType<typeof setTimeout> | undefined;
		let hostTimer: ReturnType<typeof setTimeout> | undefined;
		const sno = await serve((_request, response) => {
			snoTimer = setTimeout(() => answer(response, ""), 250);
		});
		const host = await serve((_request, response) => {
			hostTimer = setTimeout(() => answer(response, '{"from":"host"}'), 350);
		});
		try {
			const llm = client(sno.url, host.url);
			expect(await llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32,
				timeoutMs: 500, emptyReplyAttempts: 1 })).toBeNull();
			expect(sno.paths).toEqual(["/extract/profile/v1/completions"]);
			expect(host.paths).toEqual(["/host/v1/chat/completions"]);
		} finally {
			clearTimeout(snoTimer); clearTimeout(hostTimer);
			await close(sno.server); await close(host.server);
		}
	});

	it("stops transport retries at three GPU requests after an earlier empty reply", async () => {
		let sent = 0;
		const sno = await serve((_request, response) => {
			sent += 1;
			if (sent === 1) answer(response, "");
			else if (sent <= 3) { response.writeHead(503); response.end(); }
			else answer(response, '{"from":"sno"}');
		});
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const llm = client(sno.url, host.url);
			expect(await llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 10_000 }))
				.toEqual({ from: "host" });
			expect(sno.paths).toHaveLength(3);
			expect(host.paths).toEqual(["/host/v1/chat/completions"]);
			expect(llm.getLastUsage()).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
		} finally { await close(sno.server); await close(host.server); }
	});

	it("does not dispatch another GPU request after a transport failure uses the deadline", async () => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const sno = await serve((_request, response) => {
			clock.mockReturnValue(1_000);
			response.writeHead(503); response.end();
		});
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const llm = client(sno.url, host.url);
			expect(await llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 1_000 })).toBeNull();
			expect(sno.paths).toEqual(["/extract/profile/v1/completions"]);
			expect(host.paths).toEqual([]);
		} finally { await close(sno.server); await close(host.server); }
	});

	it("does not restart GPU attempts when the host returns malformed JSON", async () => {
		const sno = await serve((_request, response) => answer(response, ""));
		const host = await serve((_request, response) => answer(response, "not JSON"));
		try {
			const llm = client(sno.url, host.url);
			expect(await llm.completeJson({ callId: "E9", prompt: "Return profile keys", maxTokens: 32, timeoutMs: 10_000 })).toBeNull();
			expect(sno.paths).toHaveLength(3);
			expect(host.paths).toEqual(["/host/v1/chat/completions"]);
		} finally { await close(sno.server); await close(host.server); }
	});
});
