import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client";
import { MODEL_CALL_WORKLOAD } from "../../../../packages/memory/src/model/model-call-table";
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
	const server: Server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* drain body */ }
		headers.push(request.headers);
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
	return { server, headers, url: `http://127.0.0.1:${address.port}` };
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

	it("chat calls to Sno GPU carry source, workload and a new request id per attempt; the host fallback carries none", async () => {
		const sno = await serve((_headers, response) => reply(response, 401));
		const host = await serve((_headers, response) => reply(response, 200));
		try {
			const llm = createLlmClient({
				preset: "mem_claw/sno_ai_extract", apiKey: "test-machine-key", baseURL: sno.url, refuseOnUnavailable: false,
				routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
				agentPort: new RegisteredAgentPort({ baseUrl: `${host.url}/host/v1`, credential: "host-key", model: "host-model" }),
			});
			const request = { callId: "E1" as const, prompt: "Sno prompt", hostPrompt: "Host prompt", timeoutMs: 5_000, maxTokens: 32 };
			await llm.completeJson(request);
			await llm.completeJson(request);
			expect(sno.headers).toHaveLength(2);
			for (const headers of sno.headers) {
				expect(headers["x-sno-source"]).toBe("sno-station");
				expect(headers["x-sno-workload"]).toBe("station-extract");
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
			}
		} finally { sno.server.closeAllConnections(); sno.server.close(); host.server.closeAllConnections(); host.server.close(); }
	});

	it("profile completions carry their own workload and a new request id each time", async () => {
		const sno = await serve((_headers, response) => reply(response, 200, "yes"));
		try {
			const call = () => callSnoProfileCompletion({
				endpointUrl: `${sno.url}/extract/profile/v1/completions`, model: "m", apiKey: "k",
				prompt: "p", timeoutMs: 5_000, callId: "E9", operationId: "capture:job-1",
			});
			await call();
			await call();
			expect(sno.headers).toHaveLength(2);
			for (const headers of sno.headers) {
				expect(headers["x-sno-source"]).toBe("sno-station");
				expect(headers["x-sno-workload"]).toBe("station-profile-key");
				expect(headers["x-request-id"]).toMatch(UUID_V4);
				expect(headers["x-sno-operation"]).toBe("capture:job-1");
			}
			expect(sno.headers[0]?.["x-request-id"]).not.toBe(sno.headers[1]?.["x-request-id"]);
		} finally { sno.server.closeAllConnections(); sno.server.close(); }
	});

	it("every call has a workload in the allowed label format, split by what the caller is doing", () => {
		for (const workload of Object.values(MODEL_CALL_WORKLOAD)) expect(workload).toMatch(/^[a-z0-9-]{1,64}$/);
		expect(MODEL_CALL_WORKLOAD.E10).toBe("station-verdict");
		expect(MODEL_CALL_WORKLOAD.REM1).toBe("station-rem-replace");
		expect(MODEL_CALL_WORKLOAD.REM5).toBe("station-rem-update");
		expect(new Set(Object.values(MODEL_CALL_WORKLOAD)).size).toBe(8);
	});

	it("the log keeps client_request_id readable so it can be joined to the GPU logs", () => {
		const id = "ad4e117c-39f0-4d79-b59a-f39fc2467e24";
		expect(sanitizeLogAttributes({ client_request_id: id })).toEqual({ client_request_id: id });
		expect(sanitizeLogAttributes({ other_request_id: id })).not.toEqual({ other_request_id: id });
	});
});
