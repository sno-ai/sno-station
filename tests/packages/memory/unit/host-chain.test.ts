/** @file host-chain.test.ts
 * @purpose A host call that moves from host to host keeps the caller's one deadline.
 * @boundary Real loopback HTTP hosts and the real RegisteredAgentPort; no substitute port.
 */

import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../../packages/memory/config/settings";
import { createLlmClient } from "../../../../packages/memory/src/model/llm-client.ts";
import { hostChain, RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
});

/** A host that answers after `delayMs`: a typed worker-not-ready refusal, or a completion. */
async function host(delayMs: number, refuse: boolean, text = "answer"): Promise<RegisteredAgentPort> {
	const server = createServer((request, response) => {
		request.resume();
		setTimeout(() => {
			response.writeHead(refuse ? 503 : 200, { "content-type": "application/json" });
			response.end(JSON.stringify(refuse
				? { error: { kind: "error", category: "transport", message: "worker-not-ready" } }
				: { choices: [{ message: { role: "assistant", content: text } }] }));
		}, delayMs);
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" });
}

async function goneHost(): Promise<RegisteredAgentPort> {
	const port = await host(0, false);
	const server = servers.at(-1);
	if (!server) throw new Error("missing test host");
	await new Promise<void>(done => server.close(() => done()));
	return port;
}

// Pass the optional start argument to today's export without importing anything from the fix.
const chainWithStart = hostChain as (hosts: Parameters<typeof hostChain>[0], start: (deadlineMs: number) => Promise<boolean>) => ReturnType<typeof hostChain>;

it("starts once after its only host has gone and rereads the live list on the same chain", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	const live = await host(0, false, "started host answer");
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => {
		starts++;
		hosts.unshift({ agentPort: live, connected: true });
		return true;
	});
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({ result: { kind: "ok", text: "started host answer" }, starts: 1 });
});

it("starts once from an empty live list and answers on the same chain", async () => {
	const hosts: Array<{ agentPort: RegisteredAgentPort; connected: boolean }> = [];
	const live = await host(0, false, "first host answer");
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => {
		starts++;
		hosts.push({ agentPort: live, connected: true });
		return true;
	});
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({ result: { kind: "ok", text: "first host answer" }, starts: 1 });
});

it("does not start a worker after a typed auth failure", async () => {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { kind: "error", category: "auth", message: "login required" } }));
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const agentPort = new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" });
	let starts = 0;
	const chain = chainWithStart(() => [{ agentPort, connected: true }], async () => { starts++; return true; });
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({
		result: { kind: "error", category: "auth", message: "registered model HTTP 503: login required" }, starts: 0,
	});
});

it("preserves the original gone-host error when the one start returns false", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => { starts++; return false; });
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({
		result: { kind: "error", category: "transport", message: "no-agent-endpoint" }, starts: 1,
	});
});

it("retries the whole newest-first list after the older of two gone hosts registers again", async () => {
	const skins = new Map([
		["A", { agentPort: await goneHost(), connected: true }],
		["B", { agentPort: await goneHost(), connected: true }],
	]);
	const liveA = await host(0, false, "A registered again");
	let starts = 0;
	const chain = chainWithStart(() => [...skins.values()].reverse(), async () => {
		starts++;
		skins.delete("A");
		skins.set("A", { agentPort: liveA, connected: true });
		return true;
	});
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({ result: { kind: "ok", text: "A registered again" }, starts: 1 });
});

it("walks past a still-gone host in the current list after starting", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	const live = await host(0, false, "second host answer");
	const chain = chainWithStart(() => hosts, async () => {
		hosts.push({ agentPort: live, connected: true });
		return true;
	});
	expect(await chain.complete({ prompt: "question", timeoutMs: 2_000 })).toEqual({ kind: "ok", text: "second host answer" });
});

it("keeps the caller's one deadline across starting and the new host's answer", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	const live = await host(300, false);
	const chain = chainWithStart(() => hosts, async () => {
		await new Promise(resolve => setTimeout(resolve, 300));
		hosts.push({ agentPort: live, connected: true });
		return true;
	});
	const started = performance.now();
	const result = await chain.complete({ prompt: "question", timeoutMs: 450 });
	const elapsed = performance.now() - started;
	expect(result).toEqual({ kind: "cancelled", reason: "deadline" });
	expect(elapsed).toBeLessThan(700);
});

it("starts only once when starting succeeds but every host is still gone", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => { starts++; return true; });
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({
		result: { kind: "error", category: "transport", message: "no-agent-endpoint" }, starts: 1,
	});
});

it("starts once when a host destroys the request socket before sending a response", async () => {
	const server = createServer(request => { request.resume(); request.socket.destroy(); });
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const hosts = [{ agentPort: new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" }), connected: true }];
	const live = await host(0, false, "replacement answer");
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => {
		starts++;
		hosts.unshift({ agentPort: live, connected: true });
		return true;
	});
	const result = await chain.complete({ prompt: "question", timeoutMs: 2_000 });
	expect({ result, starts }).toEqual({ result: { kind: "ok", text: "replacement answer" }, starts: 1 });
});

it("becomes reachable after starting a live host when its only host has gone", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	const live = await host(0, false);
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => {
		starts++;
		hosts.unshift({ agentPort: live, connected: true });
		return true;
	});
	const reachable = await chain.reachable?.();
	expect({ reachable, starts }).toEqual({ reachable: true, starts: 1 });
});

it("stays unreachable when starting succeeds but every host is still gone", async () => {
	const hosts = [{ agentPort: await goneHost(), connected: true }];
	let starts = 0;
	const chain = chainWithStart(() => hosts, async () => { starts++; return true; });
	const reachable = await chain.reachable?.();
	expect({ reachable, starts }).toEqual({ reachable: false, starts: 1 });
});

it("moves to the next host after an error answer, within the caller's one deadline", async () => {
	// Each host used to get a fresh timeout, so one call could run hosts × timeout past the deadline it was given.
	const hosts = [
		{ agentPort: await host(300, true), connected: true },
		{ agentPort: await host(300, false), connected: true },
	];
	const started = performance.now();
	const result = await hostChain(() => hosts).complete({ prompt: "question", timeoutMs: 400 });
	const elapsed = performance.now() - started;
	expect(result.kind).not.toBe("ok");
	expect(elapsed).toBeLessThan(550);
});

it("answers from the next host when the deadline leaves it time", async () => {
	const hosts = [
		{ agentPort: await host(50, true), connected: true },
		{ agentPort: await host(50, false), connected: true },
	];
	expect(await hostChain(() => hosts).complete({ prompt: "question", timeoutMs: 2_000 })).toEqual({ kind: "ok", text: "answer" });
});

it("tells the host when the caller stops waiting, so a host never runs a model for an abandoned call", async () => {
	// The worker queues host calls; without this time it ran a model for every call whose caller had already given up.
	let header: string | undefined;
	const server = createServer((request, response) => {
		header = request.headers["x-sno-deadline"] as string | undefined;
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "answer" } }] }));
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const port = new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" });
	const before = Date.now();
	expect(await port.complete({ prompt: "question", timeoutMs: 5_000 })).toEqual({ kind: "ok", text: "answer" });
	const sent = Number(header);
	expect(sent).toBeGreaterThanOrEqual(before + 5_000);
	expect(sent).toBeLessThanOrEqual(Date.now() + 5_000);
});

it("passes on the token counts and model name a host reports, and leaves them out when it reports none", async () => {
	const reply = async (body: unknown): Promise<RegisteredAgentPort> => {
		const server = createServer((request, response) => {
			request.resume();
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		});
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		servers.push(server);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		return new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" });
	};
	const choices = [{ message: { role: "assistant", content: "answer" } }];
	const reported = await (await reply({ choices, model: "claude-sonnet-5-5", usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } })).complete({ prompt: "q", timeoutMs: 2_000 });
	expect(reported).toEqual({ kind: "ok", text: "answer", usage: { inputTokens: 120, outputTokens: 7 }, model: "claude-sonnet-5-5" });
	const partial = await (await reply({ choices, usage: { prompt_tokens: 120 } })).complete({ prompt: "q", timeoutMs: 2_000 });
	expect(partial).toEqual({ kind: "ok", text: "answer" });
});

it("records the tokens and model a host reported in the host call log", async () => {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "answer" } }], model: "claude-sonnet-5-5", usage: { prompt_tokens: 120, completion_tokens: 7 } }));
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const written: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { written.push(String(chunk)); return true; });
	try {
		const llm = createLlmClient({
			preset: "mem_claw/sno_ai_extract", apiKey: "", baseURL: "http://127.0.0.1:9",
			routing: { mode: "agent-native", language: "en", modelCalls: defaultSettings().modelCalls },
			agentPort: new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" }),
		});
		expect(await llm.completeText({ callId: "E10", prompt: "p", hostPrompt: "p", timeoutMs: 2_000, maxTokens: 16 })).toBe("answer");
	} finally {
		spy.mockRestore();
	}
	const record = written.join("").split("\n").filter(line => line.includes('"llm.host.request.completed"')).map(line => JSON.parse(line))[0];
	expect(record.attributes).toMatchObject({ returned_model: "claude-sonnet-5-5", usage: { source: "provider_reported", inputTokens: 120, outputTokens: 7, totalTokens: 127 } });
});
