// `sno observe append` returns once the event is stored locally; a one-shot detached `flush`
// child delivers it. Real bin, real buffer.db, a loopback HTTP server that can hold requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BufferStore } from "../../../../packages/observability/dist/internal/buffer-store.js";
import { SnoObserveRuntime } from "../../../../packages/observability/dist/internal/runtime.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";

const bin = fileURLToPath(new URL("../../../../packages/observability/dist/bin/sno-observe.js", import.meta.url));
const message = (kind) => [
	"append", "reach.message", "--agent=codex", `--kind=${kind}`, "--from_harness=codex",
	"--to_harness=codex", "--outcome=ok", "--latency_ms=3",
];

let dir;
let env;
let server;
let delayMs = 0;
let hits = [];

before(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const events = request.url.endsWith("/events");
			let type = "";
			try { type = JSON.parse(body).event_type ?? ""; } catch {}
			hits.push({ url: request.url, type });
			setTimeout(() => {
				response.writeHead(events ? 202 : 200, { "content-type": "application/json" });
				response.end("{}");
			}, events ? delayMs : 0).unref();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(() => {
	server.closeAllConnections();
	server.close();
});

function freshProfile() {
	dir = mkdtempSync(join(tmpdir(), "sno-observe-detached-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		telemetry: { observe: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
	}));
	env = { ...process.env, SNO_PROFILE_DIR: dir, HOME: dir };
	delete env.SNO_BUFFER_PATH;
	hits = [];
}

// Run the bin the way Reach does: under `timeout`. Async, because the server lives in this process.
function run(args, { timeout = 5 } = {}) {
	return new Promise((resolve) => {
		const child = spawn("timeout", ["--foreground", "--signal=TERM", "--kill-after=1", String(timeout), "node", bin, ...args],
			{ env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		const started = Date.now();
		child.on("exit", (code) => resolve({ code, stdout, ms: Date.now() - started }));
	});
}

const store = () => new BufferStore(join(dir, "buffer.db"));
const pending = () => {
	const buffer = store();
	try { return buffer.countPending(); } finally { buffer.close(); }
};
const messageHits = () => hits.filter((hit) => hit.url.endsWith("/events") && hit.type === "reach.message");

async function until(check, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await sleep(100);
	}
	return check();
}

describe("append stores first and delivers from a detached child", () => {
	it("returns quickly against a slow endpoint with the event stored, then the event arrives", async () => {
		freshProfile();
		delayMs = 3000;
		const result = await run(message("card"));
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "stored\n");
		assert.ok(result.ms < 2000, `append returned in ${result.ms} ms while the endpoint holds each event 3 s`);
		assert.ok(pending() >= 1, "the event is in the local buffer when append returns");
		assert.ok(await until(() => messageHits().length === 1, 20_000), `endpoint saw the event: ${JSON.stringify(hits)}`);
		assert.ok(await until(() => pending() === 0, 10_000), "the event is marked shipped");
	});

	it("delivers two appends made back to back", async () => {
		freshProfile();
		delayMs = 500;
		await run(message("card"));
		await run(message("reply"));
		assert.ok(await until(() => messageHits().length === 2, 20_000), `both events arrived: ${JSON.stringify(hits)}`);
		assert.ok(await until(() => pending() === 0, 10_000));
	});

	it("a delivery child killed during the network step leaves the event stored and a later flush sends it", async () => {
		freshProfile();
		delayMs = 60_000;
		const appended = await run(message("card"));
		assert.equal(appended.code, 0);
		// The detached child is now stuck in the held request; kill it the way a crash would.
		assert.ok(await until(() => hits.length >= 1, 10_000), "delivery started");
		spawn("pkill", ["-KILL", "-f", `${bin} flush`]);
		await sleep(500);
		assert.ok(pending() >= 1, "the event survived the kill in the buffer");
		delayMs = 0;
		// The killed child still holds the 30 s flush lease; a later flush sends once it lapses.
		await sleep(31_000);
		const flushed = await run(["flush"]);
		assert.equal(flushed.code, 0);
		assert.equal(pending(), 0);
		assert.ok(messageHits().length >= 1);
	});

	it("with 50 or more events already waiting, the parent starts no delivery and the child sends all", async () => {
		freshProfile();
		delayMs = 0;
		const runtime = new SnoObserveRuntime({ env: { ...env }, deferDelivery: true });
		for (let i = 0; i < 50; i += 1) {
			await runtime.emitParsed(parseEventInput({
				event_type: "reach.message", lane: "squad", agent_id: "codex",
				payload: { kind: "card", from_harness: "codex", to_harness: "codex", outcome: "ok", latency_ms: i },
			}));
		}
		assert.equal(hits.length, 0, "storing with deferred delivery sent nothing");
		const appended = await run(message("ring"));
		assert.equal(appended.code, 0);
		assert.ok(await until(() => messageHits().length === 51, 20_000), `all 51 arrived, saw ${messageHits().length}`);
		assert.ok(await until(() => pending() === 0, 10_000));
	});

	it("a malformed append exits 2 and prints no stored marker", async () => {
		freshProfile();
		const result = await run(["append", "reach.message", "--agent=codex", "--kind=bogus"]);
		assert.equal(result.code, 2);
		assert.equal(result.stdout, "");
	});
});

after(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});
