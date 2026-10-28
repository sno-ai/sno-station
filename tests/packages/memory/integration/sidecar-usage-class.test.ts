import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../../../../packages/memory/src/contract/client";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { LOCAL_EMBEDDING_CACHE_DIR_DEFAULT } from "../../../../packages/embedder/src/constants.ts";

// The metadata standard requires the caller's real purpose on every Sno GPU request; an evaluation starts its
// sidecar with SNO_USAGE_CLASS=research so its extractions are not counted as product use.
const extraction = '{"claims_found":[],"decisions":[{"turn_index":0,"progress_only":false}],"facts":[]}';
const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const cleanups: Array<() => Promise<void> | void> = [];
const previous = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, SNO_USAGE_CLASS: process.env.SNO_USAGE_CLASS };

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function extractionHeaders(usageClass: string | undefined): Promise<IncomingHttpHeaders[]> {
	const seen: IncomingHttpHeaders[] = [];
	const gpu = createServer(async (request, response) => {
		for await (const _ of request) { /* drain */ }
		seen.push(request.headers);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk({ id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: extraction }, finish_reason: "stop" }] })
			+ chunk({ id: "c1", model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + "data: [DONE]\n\n");
	});
	gpu.listen(0, "127.0.0.1");
	await once(gpu, "listening");
	cleanups.push(() => { gpu.closeAllConnections(); gpu.close(); });
	const address = gpu.address();
	if (!address || typeof address === "string") throw new Error("HTTP server has no port");

	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	const root = mkdtempSync(join(homedir(), ".cache", "sidecar-usage-class-"));
	const database = createTestDb();
	cleanups.push(() => { database.cleanup(); rmSync(root, { recursive: true, force: true }); });
	process.env.SNO_PROFILE_DIR = root;
	if (usageClass === undefined) delete process.env.SNO_USAGE_CLASS;
	else process.env.SNO_USAGE_CLASS = usageClass;
	writeSettingsFixture(root, { mode: "rem-enhanced", rerank: { mode: "none" },
		snoGpu: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-machine-key" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey }, embedding: { cacheDir: LOCAL_EMBEDDING_CACHE_DIR_DEFAULT } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	const sidecar = await startRemSidecar();
	cleanups.push(() => sidecar.stop());
	const client = await connect({ skinId: "claude-code" });
	if (client.degraded) throw new Error(client.reason);
	const scope = { principal: "caller", project: root, session: "usage-class", host: { sessionId: "usage-class", workspace: root } };
	await client.init(scope, { skinId: "claude-code" });
	await client.capture({ turnId: "t1", rewindEpoch: 0, messages: [
		{ role: "user", content: "The billing service deploys on Tuesdays.", at: Date.now() },
		{ role: "assistant", content: "Noted.", at: Date.now() },
	] }, scope);
	// The capture is accepted and extracted in the background.
	await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 30_000, interval: 100 });
	return seen;
}

describe("sidecar Sno GPU usage class", () => {
	it.each([["research", "research"], [undefined, "product"]] as const)("SNO_USAGE_CLASS=%s sends %s", async (env, expected) => {
		const headers = await extractionHeaders(env);
		expect(headers.map(header => header["x-sno-usage-class"])).toEqual(headers.map(() => expected));
	}, 120_000);
});
