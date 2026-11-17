import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { connect as connectMemory } from "@snoai/memory/client";

if (process.argv[2] !== "worker") throw new Error("expected worker argument");
const profile = process.env.SNO_PROFILE_DIR;
appendFileSync(join(profile, "host-worker-starts.jsonl"), `${JSON.stringify({ pid: process.pid })}\n`);
writeFileSync(join(profile, "host-worker-started.json"), JSON.stringify({ pid: process.pid, argument: process.argv[2] }));
let idle;
const server = createServer((request, response) => {
	request.resume();
	clearTimeout(idle);
	idle = setTimeout(expire, 3_000);
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recorded worker answer" } }] }));
});
const expire = () => { server.closeAllConnections(); server.close(); };
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
	const client = await connectMemory({ skinId: "recorded-host" });
	if (client.degraded) throw new Error(client.error ?? client.reason);
	await client.init({ principal: client.principal, project: "global", session: "recorded-worker" }, {
		skinId: "recorded-host",
		model: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credential: "recorded-worker-credential", model: "recorded-worker-model" },
	});
	console.log(JSON.stringify({ registered: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
	// A detached fixture must not survive a failed assertion in its parent test.
	idle = setTimeout(expire, 3_000);
} catch (error) {
	server.closeAllConnections();
	server.close();
	throw error;
}
