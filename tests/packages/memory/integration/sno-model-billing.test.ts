import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, LlmClientTerminalError, ModelCallRefusedError } from "../../../../packages/memory/src/model/llm-client";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port";
import { SNO_STATION_MEM_RELEASE_ANCHOR_URL } from "../../../../packages/memory/src/model/llmix-registry";
import { memoryOperationId, withMemoryOperation } from "../../../../packages/memory/src/engine/operation-cancellation";
import type { ModelCallId } from "../../../../packages/memory/src/model/model-call-table";
import { runRemBatchJob } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture";
import { seedProductionMemory } from "../../../apps/mem-claw/helpers/rem-production-entry-fixture";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const originalFetch = globalThis.fetch;
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

type RequestRecord = { path: string; operation: string | undefined; body: Record<string, unknown> };

async function serve(onRequest: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void): Promise<{
	server: Server;
	url: string;
	requests: RequestRecord[];
}> {
	const requests: RequestRecord[] = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push({ path: request.url ?? "", operation: request.headers["x-sno-operation"] as string | undefined, body });
		onRequest(request, response, body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let address = server.address();
	// Node fetch rejects the reserved low ports even when a real server is listening (observed on 1723).
	while (address && typeof address !== "string" && address.port <= 10_080) {
		await close(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		address = server.address();
	}
	if (!address || typeof address === "string") throw new Error("HTTP server has no port");
	return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function answer(response: ServerResponse, content: string): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ choices: [{ message: { content }, text: content }], usage: {
		prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
	} }));
}

function client(snoUrl: string, hostUrl?: string, apiKey = "test-machine-key", refuseOnUnavailable = false) {
	const attempts: Array<{ callId: ModelCallId; destination: string; transport: string }> = [];
	const llm = createLlmClient({
		preset: "mem_claw/sno_ai_extract", apiKey, baseURL: snoUrl, refuseOnUnavailable,
		routing: { mode: "rem-enhanced", language: "en", modelCalls: defaultSettings().modelCalls },
		...(hostUrl ? { agentPort: new RegisteredAgentPort({
			baseUrl: `${hostUrl}/host/v1`, credential: "host-key", model: "host-model",
		}) } : {}),
		onTransportAttempt: attempt => attempts.push(attempt),
	});
	return { llm, attempts };
}

async function complete(llm: ReturnType<typeof createLlmClient>, callId: "E1" | "E9" | "E10" | "P1", signal?: AbortSignal) {
	const request = { callId, prompt: "Sno adapter prompt", hostPrompt: "Host chat prompt", timeoutMs: 500,
		maxTokens: 32, ...(signal ? { signal } : {}) };
	return callId === "E10" || callId === "P1"
		? llm.completeText(request)
		: llm.completeJson(request);
}

describe("Sno model billing Station journeys", () => {
	beforeEach(() => {
		globalThis.fetch = ((input, init) => String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL
			? Promise.resolve(new Response(JSON.stringify(didDocument), { status: 200 }))
			: originalFetch(input, init)) as typeof fetch;
	});
	afterEach(() => { globalThis.fetch = originalFetch; });

	const failures = ["401", "429", "503", "timeout", "refused", "empty", "missing-key"] as const;
	const calls = ["E1", "E9", "E10", "P1"] as const;
	for (const callId of calls) {
		for (const failure of failures) {
			it(`${callId} uses the host answer after Sno ${failure}`, async () => {
				const sno = await serve((_request, response) => {
					if (failure === "timeout") return;
					if (failure === "empty") return answer(response, "");
					const status = Number(failure);
					response.writeHead(status, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { code: status === 429 ? "allowance_used_up"
						: status === 401 ? "credential_invalid" : "admission_unavailable" } }));
				});
				if (failure === "refused") await close(sno.server);
				const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
				try {
					const { llm, attempts } = client(sno.url, host.url, failure === "missing-key" ? "" : "test-machine-key");
					const diagnostics: string[] = [];
					const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
						diagnostics.push(String(chunk));
						return true;
					});
					let operationId: string | undefined;
					let result: unknown;
					try {
						result = await withMemoryOperation("capture", undefined, async () => {
							operationId = memoryOperationId();
							return complete(llm, callId);
						});
					} finally { output.mockRestore(); }
					expect(operationId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
					expect(result).toEqual(callId === "E10" || callId === "P1" ? '{"from":"host"}' : { from: "host" });
					expect(host.requests).toHaveLength(1);
					expect(host.requests[0]?.path).toBe("/host/v1/chat/completions");
					expect(host.requests[0]?.operation).toBeUndefined();
					expect(attempts.at(-1)).toMatchObject({ callId, destination: "host", transport: "agent-host-seam" });
					const fallback = diagnostics.map(line => {
						try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
					}).filter(line => line?.event_name === "memory.llm_client.fallback" && line.body === "Sno model call answered by host");
					expect(fallback).toHaveLength(1);
					expect(fallback[0]?.attributes).toMatchObject({
						operation_id: operationId,
						call_id: { length: callId.length, sha256: createHash("sha256").update(callId).digest("hex") },
						host_outcome: { length: 8, sha256: createHash("sha256").update("answered").digest("hex") },
					});
					const attributes = fallback[0]?.attributes;
					if (!attributes || typeof attributes !== "object" || !("sno_failure" in attributes)) {
						throw new Error("fallback log is missing the Sno failure category");
					}
					const cause = attributes.sno_failure;
					const expectedCause = failure === "empty" ? "empty_reply" : failure === "missing-key" ? "missing_key"
						: failure === "refused" ? "transport" : failure === "timeout" ? "timeout" : `HTTP ${failure}`;
					expect(cause).toEqual({ length: expectedCause.length,
						sha256: createHash("sha256").update(expectedCause).digest("hex") });
					if (callId === "E10" || callId === "P1") {
						const messages = host.requests[0]?.body.messages as Array<{ role: string; content: string }>;
						expect(messages.at(-1)?.content).toBe("Host chat prompt");
					}
					if (failure === "refused") expect(attempts[0]).toMatchObject({ callId, destination: "sno-gpu" });
					else expect(sno.requests).toHaveLength(failure === "missing-key" ? 0
						: failure === "401" || failure === "timeout" ? 1 : 3);
					if (failure !== "refused" && failure !== "missing-key") {
						expect(sno.requests.every(request => request.operation === operationId)).toBe(true);
					}
				} finally {
					if (failure !== "refused") await close(sno.server);
					await close(host.server);
				}
			});
		}
	}

	it("does not use the host when Sno answers", async () => {
		const sno = await serve((_request, response) => answer(response, '{"from":"sno"}'));
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const { llm } = client(sno.url, host.url);
			expect(await complete(llm, "E1")).toEqual({ from: "sno" });
			expect(sno.requests).toHaveLength(1);
			expect(host.requests).toHaveLength(0);
		} finally { await close(sno.server); await close(host.server); }
	});

	it("does not use the host after the caller cancels", async () => {
		let sawRequest!: () => void;
		const started = new Promise<void>(resolve => { sawRequest = resolve; });
		const sno = await serve(() => sawRequest());
		const host = await serve((_request, response) => answer(response, '{"from":"host"}'));
		try {
			const { llm } = client(sno.url, host.url);
			const controller = new AbortController();
			const result = complete(llm, "E1", controller.signal);
			await started;
			controller.abort();
			await expect(result).rejects.toMatchObject({ name: LlmClientTerminalError.name, category: "cancelled" });
			expect(host.requests).toHaveLength(0);
		} finally { await close(sno.server); await close(host.server); }
	});

	it("retains the Sno failure when the host is unavailable", async () => {
		let unavailable = true;
		const sno = await serve((_request, response) => {
			if (unavailable) { response.writeHead(401); response.end(); }
			else answer(response, '{"from":"sno"}');
		});
		try {
			const { llm } = client(sno.url, undefined, "test-machine-key", true);
			const diagnostics: string[] = [];
			const output = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
				diagnostics.push(String(chunk));
				return true;
			});
			let operationId: string | undefined;
			try {
				await withMemoryOperation("capture", undefined, async () => {
					operationId = memoryOperationId();
					await expect(complete(llm, "E1")).rejects.toMatchObject({
						name: ModelCallRefusedError.name, destination: "sno-gpu",
					});
				});
			} finally { output.mockRestore(); }
			const fallback = diagnostics.map(line => {
				try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
			}).filter(line => line?.event_name === "memory.llm_client.fallback" && line.body === "Sno model call and host fallback failed");
			expect(fallback).toHaveLength(1);
			const http401 = "HTTP 401";
			const portUnavailable = "port_unavailable";
			expect(fallback[0]?.attributes).toMatchObject({
				operation_id: operationId,
				call_id: { length: 2, sha256: createHash("sha256").update("E1").digest("hex") },
				sno_failure: { length: http401.length, sha256: createHash("sha256").update(http401).digest("hex") },
				host_failure: { length: portUnavailable.length, sha256: createHash("sha256").update(portUnavailable).digest("hex") },
			});
			unavailable = false;
			expect(await complete(llm, "E1")).toEqual({ from: "sno" });
		} finally { await close(sno.server); }
	});

	it("retains Sno usage and error when the host redo fails or answers empty", async () => {
		let hostReply: "error" | "empty" = "error";
		const sno = await serve((_request, response) => answer(response, ""));
		const host = await serve((_request, response) => {
			if (hostReply === "error") { response.writeHead(503); response.end(); }
			else answer(response, "");
		});
		try {
			for (const reply of ["error", "empty"] as const) {
				hostReply = reply;
				const { llm } = client(sno.url, host.url);
				expect(await complete(llm, "E1")).toBeNull();
				expect(host.requests).toHaveLength(reply === "error" ? 1 : 2);
				expect(llm.getLastError()).toBe('sno-station-mem: llm-client [E1] no JSON found (chars=0, preview="")');
				// Three empty Sno attempts were each a charged request, so the caller reads their sum.
				expect(llm.getLastUsage()).toEqual({ inputTokens: 3, outputTokens: 3, totalTokens: 6 });
			}
		} finally { await close(sno.server); await close(host.server); }
	});

	it("sums usage over empty-reply retries that end in an answer", async () => {
		let sent = 0;
		const sno = await serve((_request, response) => answer(response, ++sent <= 2 ? "" : '{"from":"sno"}'));
		try {
			const { llm } = client(sno.url);
			expect(await complete(llm, "E1")).toEqual({ from: "sno" });
			expect(sno.requests).toHaveLength(3);
			expect(llm.getLastUsage()).toEqual({ inputTokens: 3, outputTokens: 3, totalTokens: 6 });
		} finally { await close(sno.server); }
	});

	it("keeps the usage of charged empty attempts when a later retry is refused", async () => {
		let sent = 0;
		const sno = await serve((_request, response) => {
			if (++sent === 1) { answer(response, ""); return; }
			response.writeHead(401); response.end();
		});
		try {
			const { llm } = client(sno.url);
			await expect(complete(llm, "E1")).rejects.toBeInstanceOf(LlmClientTerminalError);
			expect(llm.getLastUsage()).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
		} finally { await close(sno.server); }
	});

	it("keeps each concurrent call's error and usage together on one client", async () => {
		const sno = await serve((_request, response, body) =>
			answer(response, JSON.stringify(body).includes("PROMPT-B") ? '{"from":"sno-b"}' : ""));
		const host = await serve((_request, response) => { setTimeout(() => { response.writeHead(503); response.end(); }, 300); });
		try {
			const { llm } = client(sno.url, host.url);
			const slow = llm.completeJson({ callId: "E1", prompt: "PROMPT-A", hostPrompt: "host A", timeoutMs: 2_000, maxTokens: 32 });
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(await llm.completeJson({ callId: "E9", prompt: "PROMPT-B", hostPrompt: "host B", timeoutMs: 2_000, maxTokens: 32 }))
				.toEqual({ from: "sno-b" });
			// The fast call published its own pair when it ended.
			expect(llm.getLastError()).toBeNull();
			expect(llm.getLastUsage()).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
			expect(await slow).toBeNull();
			// The slow call ends last and publishes its own Sno failure and summed usage, never a mix.
			expect(llm.getLastError()).toBe('sno-station-mem: llm-client [E1] no JSON found (chars=0, preview="")');
			expect(llm.getLastUsage()).toEqual({ inputTokens: 3, outputTokens: 3, totalTokens: 6 });
		} finally { await close(sno.server); await close(host.server); }
	});

	it("uses one operation id for two calls in a scope and no header outside it", async () => {
		const sno = await serve((_request, response) => answer(response, '{"from":"sno"}'));
		try {
			const { llm } = client(sno.url);
			await withMemoryOperation("capture", undefined, async () => {
				await complete(llm, "E1");
				await complete(llm, "E9");
			});
			await complete(llm, "E1");
			expect(sno.requests).toHaveLength(3);
			expect(sno.requests[0]?.operation).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
			expect(sno.requests[1]?.operation).toBe(sno.requests[0]?.operation);
			expect(sno.requests[2]?.operation).toBeUndefined();
		} finally { await close(sno.server); }
	});

	for (const hostFails of [false, true]) {
		it(`runs a real REM pair after Sno refuses and the host ${hostFails ? "fails" : "answers"}`, async () => {
			const database = createTestDb();
			const stateRoot = mkdtempSync(join(tmpdir(), "daisy-rem-"));
			const previousProfile = process.env["SNO_PROFILE_DIR"];
			const previousExpectedPath = process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"];
			process.env["SNO_PROFILE_DIR"] = stateRoot;
			process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
			const sno = await serve((_request, response) => { response.writeHead(503); response.end(); });
			const host = await serve((_request, response) => {
				if (hostFails) { response.writeHead(503); response.end(); }
				else answer(response, "keep");
			});
			try {
				const scope = `persona:billing-rem-${hostFails ? "host-fails" : "host-answers"}`;
				for (let index = 0; index < 2; index++) {
					seedProductionMemory(database.runtime.raw, {
						id: `billing-rem-${hostFails}-${index}`, scope,
						text: `The researcher uses option ${index} for memory storage.`,
						metadata: { fact_key: "profile:preferences.memory-storage", section_name: "preferences.memory-storage" },
						timestamp: `2026-08-0${index + 1}T10:00:00.000Z`,
					});
				}
				const settings = defaultSettings();
				settings.mode = "rem-enhanced";
				settings.store = { path: database.dbPath, encryptionKey: database.encryptionKey };
				settings.snoGpu = { baseUrl: sno.url, apiKey: "test-machine-key" };
				settings.embedding.cacheDir = "";
				settings.rerank.mode = "none";
				const jobId = `billing-rem-job-${hostFails ? "failed" : "answered"}`;
				const run = runRemBatchJob({
					settings, mode: "rem-enhanced", agentPort: new RegisteredAgentPort({
						baseUrl: `${host.url}/host/v1`, credential: "host-key", model: "host-model",
					}),
					jobId, jobType: "rem-replace", scope,
					configuration: parseRemOperationalConfiguration({
						...createRemOwnerDecidedOperationalConfiguration(), budgets: { maxPairs: 1 },
						retrieval: { neighborLimit: 2, similarityThreshold: 1 },
					}),
				});
				if (hostFails) {
					await expect(run).rejects.toMatchObject({ name: ModelCallRefusedError.name, destination: "sno-gpu" });
					const activeClaims = database.runtime.raw.prepare("SELECT row_id FROM nodix_rem_row_claims WHERE state = 'active'").all();
					const claimedPairs = database.runtime.raw.prepare("SELECT pair_id FROM nodix_rem_scan_pairs WHERE claim_state = 'claimed'").all();
					expect(activeClaims).toEqual([]);
					expect(claimedPairs).toEqual([]);
				}
				else await expect(run).resolves.toMatchObject({ terminalState: "done" });
				expect(sno.requests.length).toBeGreaterThan(0);
				expect(sno.requests.every(request => request.operation === jobId)).toBe(true);
				expect(host.requests.length).toBeGreaterThan(0);
				const hostMessages = host.requests[0]?.body.messages;
				if (!Array.isArray(hostMessages)) throw new Error("host request has no chat messages");
				const hostUserMessage = hostMessages.at(-1);
				if (!hostUserMessage || typeof hostUserMessage !== "object" || !("content" in hostUserMessage)) {
					throw new Error("host request has no user prompt");
				}
				expect(hostUserMessage.content).toContain("Adjudicate whether the newer memory replaces the older memory.");
				expect(hostUserMessage.content).not.toContain("Judge the relationship of the newer memory to the older memory.");
				expect(sno.requests[0]?.body.prompt).toContain("Judge the relationship of the newer memory to the older memory.");
			} finally {
				await close(sno.server);
				await close(host.server);
				database.cleanup();
				rmSync(stateRoot, { recursive: true, force: true });
				if (previousProfile === undefined) delete process.env["SNO_PROFILE_DIR"];
				else process.env["SNO_PROFILE_DIR"] = previousProfile;
				if (previousExpectedPath === undefined) delete process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"];
				else process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = previousExpectedPath;
			}
		});
	}

	it("keeps one operation id across a group maintenance command", async () => {
		const database = createTestDb();
		const stateRoot = mkdtempSync(join(tmpdir(), "daisy-group-"));
		const sno = await serve((_request, response) => answer(response, '{"group":"kept"}'));
		try {
			const rowId = seedProductionMemory(database.runtime.raw, {
				scope: "persona:billing-group", text: "The deployment is waiting on a security review.",
				metadata: { section_name: "deployment.status", fact_key: "state:deployment.status" },
			});
			database.runtime.raw.prepare(`UPDATE nodix_memories
				SET category = 'state', subject = 'entity:deployment', attribute = NULL,
					maturity = 'extracted', source = 'edge', extractor_version = 'billing-test'
				WHERE id = ?`).run(rowId);
			const profileId = seedProductionMemory(database.runtime.raw, {
				scope: "persona:billing-group", text: "The user prefers jasmine tea.",
				metadata: { section_name: "preferences.drink" },
			});
			database.runtime.raw.prepare(`UPDATE nodix_memories
				SET subject = 'user', attribute = NULL,
					maturity = 'extracted', source = 'edge', extractor_version = 'billing-test'
				WHERE id = ?`).run(profileId);
			writeSettingsFixture(stateRoot, {
				mode: "rem-enhanced", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
				embedding: { cacheDir: "" }, rerank: { mode: "none" },
				snoGpu: { baseUrl: sno.url, apiKey: "test-machine-key" },
			});
			const repoRoot = resolve(import.meta.dirname, "../../../..");
			const child = spawn(resolve(repoRoot, "node_modules/.bin/tsx"),
				["src/engine/maintenance/run-group-crud-maintenance.ts", database.dbPath], {
					cwd: resolve(repoRoot, "packages/memory"),
					env: { ...process.env, SNO_PROFILE_DIR: stateRoot }, stdio: ["ignore", "pipe", "pipe"],
				});
			const completion = once(child, "close");
			let stderr = "";
			for await (const chunk of child.stderr) stderr += chunk;
			const [exitCode] = await completion as [number];
			expect(exitCode, stderr.slice(-2_000)).toBe(0);
			expect(sno.requests.length).toBeGreaterThan(1);
			const prompts = new Set(sno.requests.map(request => JSON.stringify(request.body.messages ?? request.body.prompt)));
			expect(prompts.size).toBeGreaterThan(1);
			expect(new Set(sno.requests.map(request => request.path)).size).toBeGreaterThan(1);
			const ids = new Set(sno.requests.map(request => request.operation));
			expect(ids.size).toBe(1);
			expect([...ids][0]).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
		} finally {
			await close(sno.server);
			database.cleanup();
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
