import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmClient } from "../../../../packages/sno-station-mem/src/model/llm-client.ts";
import type { DispatchContext } from "../../../../packages/sno-station-mem/src/model/llm-client-types.ts";
import { callProvider } from "../../../../packages/sno-station-mem/src/model/llm-provider-transport.ts";
import { SNO_STATION_MEM_RELEASE_ANCHOR_URL } from "../../../../packages/sno-station-mem/src/model/llmix-registry.ts";

const originalFetch = globalThis.fetch;
const didDocument = {
	"@context": ["https://www.w3.org/ns/did/v1"],
	id: "did:web:www.sno.ai",
	verificationMethod: [
		{
			id: "did:web:www.sno.ai#sno-mem-openclaw-release",
			type: "JsonWebKey2020",
			controller: "did:web:www.sno.ai",
			publicKeyJwk: {
				kty: "OKP",
				crv: "Ed25519",
				x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o",
			},
		},
	],
	assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"],
};

function okChat(content: string): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content } }],
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				total_tokens: 2,
			},
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function okChatWithoutUsage(content: string): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content } }],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

type ClientRequest = Parameters<ReturnType<typeof createLlmClient>["completeJson"]>[0];

function clientRequest(value: Record<string, unknown>): ClientRequest {
	return value as ClientRequest;
}

function memoryExtractRequest(prompt: string, callLabel: string): ClientRequest {
	return {
		prompt,
		callLabel,
		adapterSlot: "memory-extract",
	};
}

describe("mem-claw llm-client", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		"memory-extract-episodic",
		"memory-extract-fallback-projection-gate",
		"memory-extract-profile-gate",
	])(
		"leaves Qwen sampling unset for %s so the Sno GPU wrapper owns mode defaults",
		async (callLabel) => {
		let providerBody: Record<string, unknown> | null = null;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return okChat('{"status":"ok"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		await client.completeJson<{ status: string }>(
			memoryExtractRequest("Return JSON", callLabel),
		);

		expect(providerBody).not.toBeNull();
		for (const key of [
			"temperature",
			"top_p",
			"top_k",
			"min_p",
			"frequency_penalty",
			"presence_penalty",
			"repetition_penalty",
		]) {
			expect(providerBody).not.toHaveProperty(key);
		}
		},
	);

	it("rejects missing callLabel or adapterSlot before provider dispatch", async () => {
		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return okChat('{"status":"unexpected"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		await expect(
			client.completeJson<{ status: string }>(
				clientRequest({
					prompt: "Return JSON",
					adapterSlot: "memory-extract",
				}),
			),
		).rejects.toThrow(/callLabel/);
		await expect(
			client.completeJson<{ status: string }>(
				clientRequest({
					prompt: "Return JSON",
					callLabel: "memory-extract-episodic",
				}),
			),
		).rejects.toThrow(/adapterSlot/);

		expect(fetchCallCount).toBe(0);
	});

	it("rejects unknown adapter slots before provider dispatch", async () => {
		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return okChat('{"status":"unexpected"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		await expect(
			client.completeJson<{ status: string }>(
				clientRequest({
					prompt: "Return JSON",
					callLabel: "custom",
					adapterSlot: "my-custom-slot",
				}),
			),
		).rejects.toThrow(/adapterSlot/);

		expect(fetchCallCount).toBe(0);
	});

	it("validates and forwards a request id through the client facade", async () => {
		let requestId: string | null = null;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			requestId = new Headers(init?.headers).get("X-Request-ID");
			return okChat('{"status":"ok"}');
		}) as typeof fetch;
		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		await client.completeJson<{ status: string }>({
			...memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			requestId: "dingo-client-correlation-1",
		});
		expect(requestId).toBe("dingo-client-correlation-1");
		await expect(
			client.completeJson({
				...memoryExtractRequest("Return JSON", "memory-extract-episodic"),
				requestId: "contains user text",
			}),
		).rejects.toThrow(/content-free correlation token/);
	});

	it("terminates a caller-cancelled provider prompt after exactly one attempt", async () => {
		const controller = new AbortController();
		let providerFetchCount = 0;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerFetchCount++;
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) {
				throw new Error("missing abort signal");
			}
			setTimeout(() => controller.abort(), 1);
			return await new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("request aborted")), {
					once: true,
				});
			});
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		const started = Date.now();
		await expect(
			client.completeJson<{ status: string }>(clientRequest({
				prompt: "Return JSON",
				callLabel: "memory-extract-episodic",
				adapterSlot: "memory-extract",
				timeoutMs: 5_000,
				signal: controller.signal,
			})),
		).rejects.toMatchObject({ category: "cancelled" });
		const elapsedMs = Date.now() - started;

		expect(providerFetchCount).toBe(1);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("preserves caller cancellation while reading a chat response body", async () => {
		const headersSent = Promise.withResolvers<void>();
		const server = createServer((request, response) => {
			request.resume();
			response.writeHead(200, { "Content-Type": "application/json" });
			response.flushHeaders();
			headersSent.resolve();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected a TCP test server address");
		}
		const controller = new AbortController();
		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: `http://127.0.0.1:${address.port}/v1`,
		});
		const update = client.completeJson<{ status: string }>(
			clientRequest({
				prompt: "Return JSON",
				callLabel: "memory-extract-episodic",
				adapterSlot: "memory-extract",
				timeoutMs: 5_000,
				signal: controller.signal,
			}),
		);

		try {
			await Promise.race([
				headersSent.promise,
				update.then(() => {
					throw new Error("provider call completed before response headers");
				}),
			]);
			controller.abort(new Error("user cancelled"));
			await expect(update).rejects.toMatchObject({ category: "cancelled" });
		} finally {
			controller.abort();
			await update.catch(() => undefined);
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("terminates a timed-out provider prompt after exactly one attempt", async () => {
		let providerFetchCount = 0;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerFetchCount++;
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) {
				throw new Error("missing abort signal");
			}
			return await new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("request timed out")), {
					once: true,
				});
			});
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		const started = Date.now();
		await expect(
			client.completeJson<{ status: string }>(clientRequest({
				prompt: "Return JSON",
				callLabel: "memory-extract-episodic",
				adapterSlot: "memory-extract",
				timeoutMs: 25,
			})),
		).rejects.toMatchObject({ category: "timeout" });

		expect(providerFetchCount).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it.each([401, 403])(
		"terminates HTTP %i authentication rejection after exactly one provider attempt",
		async (status) => {
			let providerFetchCount = 0;
			globalThis.fetch = (async (input) => {
				if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
					return new Response(JSON.stringify(didDocument), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				providerFetchCount++;
				return new Response(JSON.stringify({ error: "credential rejected" }), {
					status,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch;

			const client = createLlmClient({
				apiKey: "rejected-provider-key",
				preset: "mem_claw/openai_gpt_5_nano",
				baseURL: "https://llm.example.test/v1",
			});

			await expect(
				client.completeJson<{ status: string }>(
					memoryExtractRequest("Return JSON", "memory-extract-episodic"),
				),
			).rejects.toMatchObject({ category: "auth" });
			expect(providerFetchCount).toBe(1);
		},
	);

	it("records conservative estimated usage when provider usage is missing", async () => {
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return okChatWithoutUsage('{"status":"ok"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/sno_ai_extract",
			baseURL: "https://llm.example.test/v1",
		});

		await expect(
			client.completeJson<{ status: string }>(
				clientRequest({
					prompt: "Return JSON",
					callLabel: "memory-extract-episodic",
					adapterSlot: "memory-extract",
				}),
			),
		).resolves.toEqual({ status: "ok" });

		const usage = client.getLastUsage();
		expect(usage).not.toBeNull();
		if (usage === null) {
			throw new Error("missing usage");
		}
		expect(usage.estimated).toBe(true);
		expect(usage.inputTokens).toBeGreaterThan(0);
		expect(usage.outputTokens).toBeGreaterThan(0);
		expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
	});

	it("does not replay cached malformed JSON for identical prompts", async () => {
		let fetchCallCount = 0;
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			fetchCallCount++;

			const content = fetchCallCount === 1 ? "not json" : '{"status":"ok","attempt":2}';
			return okChat(content);
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://llm.example.test/v1",
		});

		const first = await client.completeJson<{
			status: string;
			attempt: number;
		}>(memoryExtractRequest("Return JSON", "memory-extract-episodic"));
		const second = await client.completeJson<{
			status: string;
			attempt: number;
		}>(memoryExtractRequest("Return JSON", "memory-extract-episodic"));

		expect(first).toBeNull();
		expect(second).toEqual({ status: "ok", attempt: 2 });
		expect(fetchCallCount).toBe(2);
	});

	it("rotates two provider keys across exactly three transient attempts before success", async () => {
		const authorizationHeaders: Array<string | null> = [];
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			authorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
			if (authorizationHeaders.length < 3) {
				return new Response(JSON.stringify({ error: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}
			return okChat('{"status":"ok","attempt":3}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "first-provider-key,second-provider-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://llm.example.test/v1",
		});

		const result = await client.completeJson<{
			status: string;
			attempt: number;
		}>(memoryExtractRequest("Return JSON", "memory-extract-episodic"));

		expect(result).toEqual({ status: "ok", attempt: 3 });
		expect(authorizationHeaders).toEqual([
			"Bearer first-provider-key",
			"Bearer second-provider-key",
			"Bearer first-provider-key",
		]);
	});

	it("surfaces a real pipeline error (not a silent empty response) once all provider retries are exhausted", async () => {
		let fetchCallCount = 0;
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			fetchCallCount++;
			return new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://llm.example.test/v1",
		});

		const result = await client.completeJson<{ status: string }>(
			memoryExtractRequest("Return JSON", "memory-extract-episodic"),
		);

		expect(result).toBeNull();
		expect(fetchCallCount).toBe(3);
		expect(client.getLastError()).toMatch(/pipeline error/);
		expect(client.getLastError()).not.toMatch(/empty response/);
	});

	it("survives one transient release-anchor failure inside one completeJson call", async () => {
		let anchorFetchCount = 0;
		let providerFetchCount = 0;
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				anchorFetchCount++;
				if (anchorFetchCount === 1) {
					throw new Error("release anchor unavailable");
				}
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerFetchCount++;
			return okChat('{"status":"ok"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://llm.example.test/v1",
		});

		await expect(
			client.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			),
		).resolves.toEqual({
			status: "ok",
		});

		expect(anchorFetchCount).toBe(2);
		expect(providerFetchCount).toBe(1);
	});

	it("reuses a verified endpoint for repeated requests on the same client", async () => {
		let anchorFetchCount = 0;
		let providerFetchCount = 0;
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				anchorFetchCount++;
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerFetchCount++;
			return okChat('{"status":"ok"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "test-key",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://llm.example.test/v1",
		});

		for (const callLabel of ["memory-extract-episodic", "memory-extract-episodic"]) {
			await expect(
				client.completeJson<{ status: string }>(memoryExtractRequest("Return JSON", callLabel)),
			).resolves.toEqual({ status: "ok" });
		}

		expect(anchorFetchCount).toBe(1);
		expect(providerFetchCount).toBe(2);
	});

	it("defaults OpenAI extraction to zero-billing ccproxy and keeps localhost overrides possible", async () => {
		const originalHeliconeApiKey = process.env.SNO_STATION_MEM_HELICONE_API_KEY;
		const originalHeliconeOpenaiBaseUrl = process.env.HELICONE_OPENAI_BASE_URL;
		delete process.env.SNO_STATION_MEM_HELICONE_API_KEY;
		delete process.env.HELICONE_OPENAI_BASE_URL;

		const requests: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			});
			return okChat('{"status":"ok"}');
		}) as typeof fetch;

		try {
			const defaultClient = createLlmClient({
				apiKey: "ignored-by-ccproxy",
				preset: "mem_claw/openai_gpt_5_nano",
			});
			await defaultClient.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			);

			const customClient = createLlmClient({
				apiKey: "ignored-by-local-test-server",
				preset: "mem_claw/openai_gpt_5_nano",
				baseURL: "http://127.0.0.1:43210/v1",
			});
			await customClient.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			);
		} finally {
			if (originalHeliconeApiKey === undefined) {
				delete process.env.SNO_STATION_MEM_HELICONE_API_KEY;
			} else {
				process.env.SNO_STATION_MEM_HELICONE_API_KEY = originalHeliconeApiKey;
			}
			if (originalHeliconeOpenaiBaseUrl === undefined) {
				delete process.env.HELICONE_OPENAI_BASE_URL;
			} else {
				process.env.HELICONE_OPENAI_BASE_URL = originalHeliconeOpenaiBaseUrl;
			}
		}

		expect(requests[0]?.url).toBe("http://localhost:8070/codex/v1/chat/completions");
		expect(requests[0]?.headers.get("Authorization")).toBe("Bearer ignored-by-ccproxy");
		expect(requests[0]?.headers.get("Helicone-Auth")).toBeNull();
		expect(requests[1]?.url).toBe("http://127.0.0.1:43210/v1/chat/completions");
		expect(requests[1]?.headers.get("Helicone-Auth")).toBeNull();
	});

	it("rejects direct public OpenAI billing before provider dispatch", async () => {
		let providerFetchCount = 0;
		globalThis.fetch = (async (input) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			providerFetchCount++;
			return okChat('{"status":"unexpected"}');
		}) as typeof fetch;

		const client = createLlmClient({
			apiKey: "must-not-be-spent",
			preset: "mem_claw/openai_gpt_5_nano",
			baseURL: "https://api.openai.com/v1",
		});

		await expect(
			client.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			),
		).resolves.toBeNull();
		expect(client.getLastError()).toMatch(/api\.openai\.com.*forbidden|forbidden.*api\.openai\.com/i);
		expect(providerFetchCount).toBe(0);
	});

	it("uses LLMIx sno_ai_extract routing without sending SNO_MEM_CLAW_LLM_INTERNAL_KEY to overrides", async () => {
		const originalGpuBaseUrl = process.env.GPU_BASE_URL;
		const originalSnoKey = process.env.SNO_STATION_MEM_LLM_API_KEY;
		const originalInternalSecret = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		process.env.GPU_BASE_URL = "https://gpu.example.test";
		delete process.env.SNO_STATION_MEM_LLM_API_KEY;
		process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY = "internal-secret";

		const requests: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (input, init) => {
			if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
				return new Response(JSON.stringify(didDocument), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			});
			return okChat('{"status":"ok"}');
		}) as typeof fetch;

		try {
			const defaultClient = createLlmClient({
				preset: "mem_claw/sno_ai_extract",
			});
			await defaultClient.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			);

			const overrideClient = createLlmClient({
				preset: "mem_claw/sno_ai_extract",
				baseURL: "https://sno-override.example.test/v1",
				apiKey: "override-key",
			});
			await overrideClient.completeJson<{ status: string }>(
				memoryExtractRequest("Return JSON", "memory-extract-episodic"),
			);
		} finally {
			if (originalGpuBaseUrl === undefined) delete process.env.GPU_BASE_URL;
			else process.env.GPU_BASE_URL = originalGpuBaseUrl;
			if (originalSnoKey === undefined) delete process.env.SNO_STATION_MEM_LLM_API_KEY;
			else process.env.SNO_STATION_MEM_LLM_API_KEY = originalSnoKey;
			if (originalInternalSecret === undefined) delete process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
			else process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY = originalInternalSecret;
		}

		expect(requests[0]?.url).toBe("https://gpu.example.test/extract/v1/chat/completions");
		expect(requests[0]?.headers.get("X-Internal-Token")).toBe("internal-secret");
		expect(requests[1]?.url).toBe(
			"https://sno-override.example.test/extract/v1/chat/completions",
		);
		expect(requests[1]?.headers.get("X-Internal-Token")).toBe("override-key");
	});

	it("routes Sno episodic chat through GPU_BASE_URL with the internal token", async () => {
		const originalGpuBaseUrl = process.env.GPU_BASE_URL;
		const requests: Array<{
			url: string;
			internalToken: string | undefined;
			requestId: string | undefined;
			body: Record<string, unknown>;
		}> = [];
		let gpuBaseUrl = "";
		let callError: unknown;
		let result: Awaited<ReturnType<typeof callProvider>> | undefined;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
			const internalToken = request.headers["x-internal-token"];
			if (Array.isArray(internalToken)) {
				throw new Error("expected a single X-Internal-Token header");
			}
			requests.push({
				url: new URL(request.url ?? "/", gpuBaseUrl).toString(),
				internalToken,
				requestId: request.headers["x-request-id"] as string | undefined,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
			});
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					choices: [{ message: { content: '{"status":"ok"}' } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});

		try {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("local HTTP server did not expose a TCP port");
			}
			gpuBaseUrl = `http://127.0.0.1:${address.port}`;
			process.env.GPU_BASE_URL = gpuBaseUrl;

			const context: DispatchContext = {
				provider: "sno-gpu",
				model: "Qwen/Qwen3.5-9B",
				apiKey: "integration-internal-token",
				messages: [
					{
						role: "user",
						content: "Extract durable episodic memories as JSON",
					},
				],
				kwargs: { temperature: 0 },
				config: {
					provider: "sno-gpu",
					model: "Qwen/Qwen3.5-9B",
					endpointUrl: `${gpuBaseUrl}/extract/v1/chat/completions`,
					requestId: "dingo-chat-correlation-1",
				},
			};
			try {
				result = await callProvider(context);
			} catch (error) {
				callError = error;
			}
		} finally {
			if (originalGpuBaseUrl === undefined) delete process.env.GPU_BASE_URL;
			else process.env.GPU_BASE_URL = originalGpuBaseUrl;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		}

		expect(requests).toEqual([
			{
				url: `${gpuBaseUrl}/extract/v1/chat/completions`,
				internalToken: "integration-internal-token",
				requestId: "dingo-chat-correlation-1",
				body: expect.not.objectContaining({ temperature: expect.anything() }),
			},
		]);
		expect(callError).toBeUndefined();
		expect(result).toMatchObject({
			success: true,
			content: '{"status":"ok"}',
			model: "Qwen/Qwen3.5-9B",
		});
	});

	it("forwards a content-free request id through raw profile completions", async () => {
		let requestId: string | undefined;
		let maxTokens: unknown;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
				maxTokens = body.max_tokens;
			});
			requestId = request.headers["x-request-id"] as string | undefined;
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					choices: [{ text: '{"profile_candidates":[]}' }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("local HTTP server did not expose a TCP port");
			}
			await callProvider({
				provider: "sno-gpu",
				model: "Qwen/Qwen3.5-9B",
				apiKey: "integration-internal-token",
				messages: ["profile prompt"],
				kwargs: {},
				config: {
					provider: "sno-gpu",
					model: "Qwen/Qwen3.5-9B",
					rawCompletion: {
						endpointUrl: `http://127.0.0.1:${address.port}/extract/profile/v1/completions`,
						prompt: "profile prompt",
						timeoutMs: 5_000,
						requestId: "dingo-profile-correlation-1",
						maxTokens: 1280,
					},
				},
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}

		expect(requestId).toBe("dingo-profile-correlation-1");
		expect(maxTokens).toBe(1280);
	});
});
