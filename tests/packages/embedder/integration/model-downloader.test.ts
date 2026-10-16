/** @file model-downloader.test.ts
 * @purpose Model downloads reach the pinned revision and survive the network failures users meet.
 * @boundary Real downloader and real filesystem; the download host is a local HTTP server used as the mirror.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { downloadModel, hubModelSpec, type ModelSpec } from "../../../../packages/embedder/src/downloader.ts";
import { LocalEmbedProvider } from "../../../../packages/embedder/src/local-provider.ts";
import { ensureModelDownloaded } from "../../../../packages/embedder/src/model-download.ts";

const EMBEDDING_MODEL = "tss-deposium/pplx-embed-v1-0.6b-onnx-int8-standard";
const PINNED_REVISION = "a18fdffe7480e6ea5643acb7757142b33838817a";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sno-downloader-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function host(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer((req, res) => { requests.push(req.url ?? ""); handle(req, res); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => { server.closeAllConnections(); server.close(); });
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, requests };
}

it("fetches the pinned revision when the cache holds a complete download of another revision", async () => {
	const cacheDir = tempDir();
	// What an earlier release left: the model files and a completion marker for an older revision.
	const modelDir = join(cacheDir, EMBEDDING_MODEL);
	mkdirSync(join(modelDir, "onnx"), { recursive: true });
	for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
		writeFileSync(join(modelDir, file), "older revision");
	}
	writeFileSync(join(cacheDir, ".download-complete"), JSON.stringify({ model: EMBEDDING_MODEL, revision: "0".repeat(40), dtype: "q8" }));
	const mirror = await host((_req, res) => { res.statusCode = 404; res.end(); });

	await expect(ensureModelDownloaded({ cacheDir, mirror: mirror.url })).rejects.toThrow();
	expect(mirror.requests.some((url) => url.includes(`/${EMBEDDING_MODEL}/resolve/${PINNED_REVISION}/`))).toBe(true);
}, 30_000);

it("moves an earlier release's complete files into the revision directory and removes every older copy", async () => {
	const cacheDir = tempDir();
	const modelRoot = join(cacheDir, SMALL.id);
	// The flat layout an earlier release wrote, its marker at the cache root, and an older revision.
	mkdirSync(join(modelRoot, "onnx"), { recursive: true });
	writeFileSync(join(modelRoot, "config.json"), CONFIG);
	writeFileSync(join(modelRoot, "onnx/model.onnx"), WEIGHTS);
	writeFileSync(join(cacheDir, ".download-complete"), JSON.stringify({ model: SMALL.id, revision: SMALL.revision }));
	mkdirSync(join(modelRoot, "r0", "onnx"), { recursive: true });
	writeFileSync(join(modelRoot, "r0", "onnx", "model.onnx"), "older revision");
	const mirror = await host((_req, res) => { res.statusCode = 404; res.end(); });

	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });

	expect(mirror.requests).toEqual([]);
	expect(readdirSync(modelRoot)).toEqual([SMALL.revision]);
	expect(existsSync(join(cacheDir, ".download-complete"))).toBe(false);
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
}, 30_000);

it("downloads through the proxy the environment names", async () => {
	const cacheDir = tempDir();
	const mirror = await host((_req, res) => { res.statusCode = 404; res.end(); });
	// A proxy receives the absolute URL of a plain-HTTP request; this one answers it itself.
	const proxy = await host((_req, res) => { res.statusCode = 404; res.end(); });
	const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
	cleanups.push(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	process.env.HTTP_PROXY = proxy.url;
	process.env.http_proxy = proxy.url;
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";

	await expect(ensureModelDownloaded({ cacheDir, mirror: mirror.url })).rejects.toThrow();
	expect(mirror.requests).toEqual([]);
	expect(proxy.requests.some((url) => url.startsWith(`${mirror.url}${EMBEDDING_MODEL}/resolve/`))).toBe(true);
}, 30_000);

it("drops a download that stops sending data after 30 seconds, not five minutes, and tries again", async () => {
	const cacheDir = tempDir();
	let calls = 0;
	// The first answer sends the headers and a little of the body, then nothing.
	const mirror = await host((req, res) => {
		calls += 1;
		if (calls === 1) { res.writeHead(200, { "content-length": String(body(req.url).length) }); res.write(body(req.url).subarray(0, 10)); return; }
		res.end(body(req.url));
	});
	const started = Date.now();
	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "config.json")).equals(CONFIG)).toBe(true);
	expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
	expect(Date.now() - started).toBeLessThan(60_000);
}, 90_000);

// A small model of two files for the downloader's own behaviour.
const WEIGHTS = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251));
const CONFIG = Buffer.from('{"model_type":"bert"}');
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const SMALL: ModelSpec = {
	id: "test-org/small-model",
	revision: "r1",
	files: [
		{ path: "config.json", size: CONFIG.length, sha256: sha(CONFIG) },
		{ path: "onnx/model.onnx", size: WEIGHTS.length, sha256: sha(WEIGHTS) },
	],
};
const body = (url: string | undefined): Buffer => (url?.endsWith("config.json") ? CONFIG : WEIGHTS);

it("retries a server error and a rate limit, then completes the download", async () => {
	const cacheDir = tempDir();
	let calls = 0;
	const mirror = await host((req, res) => {
		calls += 1;
		if (calls === 1) { res.statusCode = 500; res.end(); return; }
		if (calls === 2) { res.writeHead(429, { "retry-after": "1" }); res.end(); return; }
		res.end(body(req.url));
	});
	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
	expect(readFileSync(join(dir, "config.json")).equals(CONFIG)).toBe(true);
}, 60_000);

it("says which file failed and why when the host cannot be reached", async () => {
	const cacheDir = tempDir();
	await expect(downloadModel(SMALL, { cacheDir, mirror: "http://127.0.0.1:9/" }))
		.rejects.toThrow(/test-org\/small-model config\.json: .*ECONNREFUSED.* after 5 attempts/);
}, 60_000);

/** Serves `bytes` honouring a `Range: bytes=N-` request; records each request's range. */
function serveRange(req: IncomingMessage, res: ServerResponse, bytes: Buffer, ranges: string[]): void {
	const range = req.headers.range ?? "";
	ranges.push(range);
	const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
	if (start > 0) {
		res.writeHead(206, { "content-length": String(bytes.length - start), "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` });
		res.end(bytes.subarray(start));
		return;
	}
	res.writeHead(200, { "content-length": String(bytes.length) });
	res.end(bytes);
}

it("resumes a file from where the connection broke instead of starting over", async () => {
	const cacheDir = tempDir();
	const ranges: string[] = [];
	let cut = false;
	const mirror = await host((req, res) => {
		if (!req.url?.endsWith("model.onnx")) { res.end(body(req.url)); return; }
		if (!cut) {
			cut = true;
			res.writeHead(200, { "content-length": String(WEIGHTS.length) });
			res.write(WEIGHTS.subarray(0, 120_000), () => setTimeout(() => req.socket.destroy(), 100));
			return;
		}
		serveRange(req, res, WEIGHTS, ranges);
	});
	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
	expect(ranges[0]).toMatch(/^bytes=[1-9]\d*-$/);
}, 60_000);

it("resumes the part a killed process left behind", async () => {
	const cacheDir = tempDir();
	const dir = join(cacheDir, SMALL.id, SMALL.revision);
	mkdirSync(join(dir, "onnx"), { recursive: true });
	writeFileSync(join(dir, "onnx/model.onnx.part"), WEIGHTS.subarray(0, 50_000));
	const ranges: string[] = [];
	const mirror = await host((req, res) => (req.url?.endsWith("model.onnx") ? serveRange(req, res, WEIGHTS, ranges) : res.end(body(req.url))));
	await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
	expect(ranges).toEqual(["bytes=50000-"]);
}, 60_000);

it("loads a custom embedding model only through the downloader: listed, fetched into its revision directory, marked complete", async () => {
	const cacheDir = tempDir();
	const tree = [
		{ type: "file", path: "config.json", size: CONFIG.length },
		{ type: "file", path: "onnx/model_quantized.onnx", size: WEIGHTS.length, lfs: { oid: sha(WEIGHTS) } },
		{ type: "file", path: "README.md", size: 5 },
	];
	const mirror = await host((req, res) => {
		if (req.url?.startsWith("/api/models/test-org/custom-embedder/tree/r1")) { res.end(JSON.stringify(tree)); return; }
		if (req.url?.endsWith("config.json") || req.url?.endsWith("model_quantized.onnx")) { res.end(body(req.url)); return; }
		res.statusCode = 404;
		res.end();
	});
	const provider = new LocalEmbedProvider({ model: "test-org/custom-embedder", revision: "r1", cacheDir, mirror: mirror.url, dtype: "q8" });
	cleanups.push(() => { void provider.dispose(); });
	// The fake weights cannot run; what matters is how the files arrived.
	await expect(provider.warmup()).rejects.toThrow();
	expect(mirror.requests[0]).toMatch(/^\/api\/models\/test-org\/custom-embedder\/tree\/r1/);
	const dir = join(cacheDir, "test-org/custom-embedder", "r1");
	expect(readFileSync(join(dir, "onnx/model_quantized.onnx")).equals(WEIGHTS)).toBe(true);
	expect(existsSync(join(dir, ".complete"))).toBe(true);
	expect(mirror.requests.some((url) => url.includes("README.md"))).toBe(false);
}, 60_000);

it("fetches a file again when its content does not match the pinned SHA-256", async () => {
	const cacheDir = tempDir();
	let weightCalls = 0;
	const corrupt = Buffer.from(WEIGHTS).fill(0, 1000, 2000);
	const mirror = await host((req, res) => {
		if (!req.url?.endsWith("model.onnx")) { res.end(body(req.url)); return; }
		weightCalls += 1;
		res.end(weightCalls === 1 ? corrupt : WEIGHTS);
	});
	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
	expect(weightCalls).toBe(2);
}, 60_000);

it("never blocks the model on a SHA-256 that keeps differing: the second download is kept", async () => {
	const cacheDir = tempDir();
	const corrupt = Buffer.from(WEIGHTS).fill(0, 1000, 2000);
	const mirror = await host((req, res) => res.end(req.url?.endsWith("model.onnx") ? corrupt : body(req.url)));
	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(corrupt)).toBe(true);
	expect(existsSync(join(dir, ".complete"))).toBe(true);
}, 60_000);

it("offline, uses an earlier release's complete files instead of refusing", async () => {
	const cacheDir = tempDir();
	const modelRoot = join(cacheDir, SMALL.id);
	mkdirSync(join(modelRoot, "onnx"), { recursive: true });
	writeFileSync(join(modelRoot, "config.json"), CONFIG);
	writeFileSync(join(modelRoot, "onnx/model.onnx"), WEIGHTS);
	const mirror = await host((_req, res) => { res.statusCode = 404; res.end(); });

	const dir = await downloadModel(SMALL, { cacheDir, mirror: mirror.url, offline: true });

	expect(mirror.requests).toEqual([]);
	expect(readFileSync(join(dir, "onnx/model.onnx")).equals(WEIGHTS)).toBe(true);
}, 30_000);

it("fetches a file again when the hub lists a new SHA-256 for it at the same revision and size", async () => {
	const cacheDir = tempDir();
	const updated = Buffer.from('{"model_type":"xlmr"}');
	let served = CONFIG;
	const mirror = await host((req, res) => res.end(req.url?.endsWith("config.json") ? served : body(req.url)));
	await downloadModel(SMALL, { cacheDir, mirror: mirror.url });
	// Upstream replaced config.json on the same branch with a file of the same size.
	served = updated;
	const files = SMALL.files.map((file) => (file.path === "config.json" ? { ...file, sha256: sha(updated) } : file));
	const dir = await downloadModel({ ...SMALL, files }, { cacheDir, mirror: mirror.url });
	expect(readFileSync(join(dir, "config.json")).equals(updated)).toBe(true);
}, 30_000);

it("uses a custom model already on disk when the hub cannot list its files", async () => {
	const cacheDir = tempDir();
	const tree = [{ type: "file", path: "config.json", size: CONFIG.length }, { type: "file", path: "onnx/model_quantized.onnx", size: WEIGHTS.length, lfs: { oid: sha(WEIGHTS) } }];
	let down = false;
	const mirror = await host((req, res) => {
		if (down) { res.statusCode = 503; res.end(); return; }
		if (req.url?.startsWith("/api/models/")) { res.end(JSON.stringify(tree)); return; }
		res.end(body(req.url));
	});
	const options = { cacheDir, mirror: mirror.url };
	await downloadModel(await hubModelSpec("test-org/custom", "r1", "q8", options), options);
	down = true;
	const spec = await hubModelSpec("test-org/custom", "r1", "q8", options);
	const dir = await downloadModel(spec, options);
	expect(readFileSync(join(dir, "onnx/model_quantized.onnx")).equals(WEIGHTS)).toBe(true);
}, 60_000);
