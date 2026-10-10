/** @file host-chain.test.ts
 * @purpose A host call that moves from host to host keeps the caller's one deadline.
 * @boundary Real loopback HTTP hosts and the real RegisteredAgentPort; no substitute port.
 */

import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { hostChain, RegisteredAgentPort } from "../../../../packages/memory/src/model/registered-agent-port.ts";

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
});

/** A host that answers after `delayMs`: a typed worker-not-ready refusal, or a completion. */
async function host(delayMs: number, refuse: boolean): Promise<RegisteredAgentPort> {
	const server = createServer((request, response) => {
		request.resume();
		setTimeout(() => {
			response.writeHead(refuse ? 503 : 200, { "content-type": "application/json" });
			response.end(JSON.stringify(refuse
				? { error: { kind: "error", category: "transport", message: "worker-not-ready" } }
				: { choices: [{ message: { role: "assistant", content: "answer" } }] }));
		}, delayMs);
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return new RegisteredAgentPort({ baseUrl: `http://127.0.0.1:${address.port}/v1`, credential: "c", model: "m" });
}

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
