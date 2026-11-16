import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { MODEL_CALL_WORKLOAD, type ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { callSnoProfileCompletion } from "../../../../packages/memory/src/model/llm-provider-transport";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";
import { SNO_STATION_MEM_RELEASE_ANCHOR_URL } from "../../../../packages/memory/src/model/llmix-registry";
import { sanitizeLogAttributes } from "../../../../packages/utils/src/log-encoder";

const originalFetch = globalThis.fetch;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const didDocument = {
	"@context": ["https://www.w3.org/ns/did/v1"],
	id: "did:web:www.sno.ai",
	verificationMethod: [{
		id: "did:web:www.sno.ai#sno-mem-openclaw-release",
		type: "JsonWebKey2020",
		controller: "did:web:www.sno.ai",
		publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o" },
	}],
	assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"],
};

async function serve(onRequest: (headers: IncomingHttpHeaders, response: ServerResponse) => void) {
	const headers: IncomingHttpHeaders[] = [];
	const paths: string[] = [];
	const server: Server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* drain body */ }
		headers.push(request.headers);
		paths.push(request.url ?? "");
		onRequest(request.headers, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let address = server.address();
	// Node fetch rejects the reserved low ports even when a real server is listening.
	while (address && typeof address !== "string" && address.port <= 10_080) {
		server.close();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		address = server.address();
	}
	if (!address || typeof address === "string") throw new Error("HTTP server has no port");
	return { server, headers, paths, url: `http://127.0.0.1:${address.port}` };
}

function reply(response: ServerResponse, status: number, content = '{"ok":true}'): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(status === 200
		? { choices: [{ message: { content }, text: content }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
		: { error: { code: "credential_invalid" } }));
}

describe("Sno GPU request attribution headers", () => {
	beforeEach(() => {
		globalThis.fetch = ((input, init) => String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL
			? Promise.resolve(new Response(JSON.stringify(didDocument), { status: 200 }))
			: originalFetch(input, init)) as typeof fetch;
	});
	afterEach(() => { globalThis.fetch = originalFetch; });

	it.each(["product", "research", "ops", undefined] as const)("chat calls retain %s attribution while the host fallback carries none", async (usageClass) => {
		const sno = await serve((_headers, response) => reply(response, 401));
		const host = await serve((_headers, response) => reply(response, 200));
		try {
			const llm = createLlmClient({
				preset: "mem_claw/sno_ai_extract", apiKey: "test-machine-key", baseURL: sno.url, refuseOnUnavailable: false, usageClass,
				routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
				agentPort: new RegisteredAgentPort({ baseUrl: `${host.url}/host/v1`, credential: "host-key", model: "host-model" }),
			});
			const request = { callId: "E1" as const, prompt: "Sno prompt", hostPrompt: "Host prompt", timeoutMs: 5_000, maxTokens: 32 };
			await llm.completeJson(request);
			await llm.completeJson(request);
			expect(sno.paths).toEqual(["/extract/v1/chat/completions", "/extract/v1/chat/completions"]);
			expect(sno.headers).toHaveLength(2);
			for (const headers of sno.headers) {
				expect(headers["x-sno-source"]).toBe("sno-station");
				expect(headers["x-sno-workload"]).toBe("station-extract");
				expect(headers["x-sno-usage-class"]).toBe(usageClass);
				expect(headers["x-request-id"]).toMatch(UUID_V4);
				expect(headers["x-internal-token"]).toBe("test-machine-key");
				expect(headers["x-sno-user-id"]).toBeUndefined();
				expect(headers["x-sno-machine-id"]).toBeUndefined();
			}
			expect(sno.headers[0]?.["x-request-id"]).not.toBe(sno.headers[1]?.["x-request-id"]);
			expect(host.headers).toHaveLength(2);
			for (const headers of host.headers) {
				expect(headers["x-sno-source"]).toBeUndefined();
				expect(headers["x-sno-workload"]).toBeUndefined();
				expect(headers["x-sno-usage-class"]).toBeUndefined();
			}
		} finally { sno.server.closeAllConnections(); sno.server.close(); host.server.closeAllConnections(); host.server.close(); }
	});

	it.each(["product", "research", "ops", undefined] as const)("profile completions retain %s attribution through the client", async (usageClass) => {
		const sno = await serve((_headers, response) => reply(response, 200));
		try {
			const llm = createLlmClient({
				preset: "mem_claw/sno_ai_extract", apiKey: "k", baseURL: sno.url, usageClass,
				operationId: "capture:job-1",
				routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
			});
			const call = () => llm.completeJson({ callId: "E9", prompt: "p", timeoutMs: 5_000, maxTokens: 32 });
			await call();
			await call();
			expect(sno.paths).toEqual(["/extract/profile/v1/completions", "/extract/profile/v1/completions"]);
			expect(sno.headers).toHaveLength(2);
			for (const headers of sno.headers) {
				expect(headers["x-sno-source"]).toBe("sno-station");
				expect(headers["x-sno-workload"]).toBe("station-profile-key");
				expect(headers["x-sno-usage-class"]).toBe(usageClass);
				expect(headers["x-request-id"]).toMatch(UUID_V4);
				expect(headers["x-sno-operation"]).toBe("capture:job-1");
			}
			expect(sno.headers[0]?.["x-request-id"]).not.toBe(sno.headers[1]?.["x-request-id"]);
		} finally { sno.server.closeAllConnections(); sno.server.close(); }
	});


	it.each(["E1", "E9"] as const)("retries %s with the same usage class and a new request id per attempt", async (callId) => {
		let attempts = 0;
		const sno = await serve((_headers, response) => reply(response, ++attempts === 1 ? 503 : 200));
		try {
			const llm = createLlmClient({
				preset: "mem_claw/sno_ai_extract", apiKey: "k", baseURL: sno.url, usageClass: "research",
				routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
			});
			expect(await llm.completeJson({ callId, prompt: "p", timeoutMs: 5_000, maxTokens: 32 })).toEqual({ ok: true });
			expect(sno.headers).toHaveLength(2);
			for (const headers of sno.headers) {
				expect(headers["x-sno-usage-class"]).toBe("research");
				expect(headers["x-request-id"]).toMatch(UUID_V4);
			}
			expect(sno.headers[0]?.["x-request-id"]).not.toBe(sno.headers[1]?.["x-request-id"]);
		} finally { sno.server.closeAllConnections(); sno.server.close(); }
	});

	it("a request id the caller names is sent as given on the profile route", async () => {
		const sno = await serve((_headers, response) => reply(response, 200, "yes"));
		try {
			await callSnoProfileCompletion({
				endpointUrl: `${sno.url}/extract/profile/v1/completions`, model: "m", apiKey: "k",
				prompt: "p", timeoutMs: 5_000, callId: "E9", requestId: "caller-token-1",
			});
			expect(sno.headers[0]?.["x-request-id"]).toBe("caller-token-1");
			expect(sno.headers[0]?.["x-sno-workload"]).toBe("station-profile-key");
		} finally { sno.server.closeAllConnections(); sno.server.close(); }
	});

	it.each(["product", "research"] as const)("precision calls carry literal workload labels and %s usage class", async usageClass => {
		const sno = await serve((_headers, response) => reply(response, 200));
		const hostPrompts: string[] = [];
		try {
			const llm = createLlmClient({
				preset: "mem_claw/sno_ai_extract", apiKey: "fixture", baseURL: sno.url, usageClass,
				routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
				agentPort: { async complete({ prompt }) {
					hostPrompts.push(prompt);
					return { kind: "ok", text: '{"ok":true}' };
				} },
			});
			for (const callId of ["E13", "E14", "E15", "E16", "E17", "E19", "E20"] as ModelCallId[]) {
				expect(await llm.completeJson({ callId, prompt: `fixture judgment ${callId}`, timeoutMs: 5_000, maxTokens: 32 })).toEqual({ ok: true });
			}
			expect.soft(hostPrompts).toEqual(["fixture judgment E15", "fixture judgment E19", "fixture judgment E20"]);
			expect.soft(sno.headers.map(headers => [headers["x-sno-source"], headers["x-sno-workload"], headers["x-sno-usage-class"]])).toEqual([
				["sno-station", "station-capture-mode", usageClass],
				["sno-station", "station-profile-scope", usageClass],
				["sno-station", "station-cleanup", usageClass],
				["sno-station", "station-recall-pick", usageClass],
			]);
			expect.soft(new Set(sno.headers.map(headers => headers["x-request-id"])).size).toBe(4);
			for (const headers of sno.headers) expect(headers["x-request-id"]).toMatch(UUID_V4);
		} finally { sno.server.closeAllConnections(); sno.server.close(); }
	});

	it("every call has a workload in the allowed label format, split by what the caller is doing", () => {
		for (const workload of Object.values(MODEL_CALL_WORKLOAD)) expect(workload).toMatch(/^[a-z0-9-]{1,64}$/);
		expect(MODEL_CALL_WORKLOAD.E10).toBe("station-verdict");
		expect(MODEL_CALL_WORKLOAD).toMatchObject({
			E17: "station-recall-pick",
			E19: "station-start-label",
			E20: "station-start-pick",
		});
		expect(new Set(Object.values(MODEL_CALL_WORKLOAD)).size).toBe(13);
	});

	it("the log keeps client_request_id readable so it can be joined to the GPU logs", () => {
		const id = "ad4e117c-39f0-4d79-b59a-f39fc2467e24";
		expect(sanitizeLogAttributes({ client_request_id: id })).toEqual({ client_request_id: id });
		expect(sanitizeLogAttributes({ other_request_id: id })).not.toEqual({ other_request_id: id });
	});
});
