/** @file model-downloader.test.ts
 * @purpose Model downloads reach the pinned revision and survive the network failures users meet.
 * @boundary Real downloader and real filesystem; the download host is a local HTTP server used as the mirror.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { embeddingModelSpec, ensureModelDownloaded } from "../../../../packages/embedder/src/model-download.ts";

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
	const spec = embeddingModelSpec("q8");
	const modelDir = join(cacheDir, EMBEDDING_MODEL);
	// The flat layout an earlier release wrote (sparse files of the right sizes), its marker, and an older revision.
	for (const file of spec.files) {
		mkdirSync(dirname(join(modelDir, file.path)), { recursive: true });
		writeFileSync(join(modelDir, file.path), "");
		truncateSync(join(modelDir, file.path), file.size);
	}
	writeFileSync(join(cacheDir, ".download-complete"), JSON.stringify({ model: EMBEDDING_MODEL, revision: PINNED_REVISION, dtype: "q8" }));
	mkdirSync(join(modelDir, "1".repeat(40), "onnx"), { recursive: true });
	writeFileSync(join(modelDir, "1".repeat(40), "onnx", "model_quantized.onnx"), "older revision");
	const mirror = await host((_req, res) => { res.statusCode = 404; res.end(); });

	await ensureModelDownloaded({ cacheDir, mirror: mirror.url });

	expect(mirror.requests).toEqual([]);
	expect(readdirSync(modelDir)).toEqual([PINNED_REVISION]);
	expect(existsSync(join(cacheDir, ".download-complete"))).toBe(false);
	for (const file of spec.files) expect(existsSync(join(modelDir, PINNED_REVISION, file.path))).toBe(true);
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

it("gives up on a download that stops sending data within a minute, not five", async () => {
	const cacheDir = tempDir();
	// Sends the headers and a little of the body, then nothing.
	const mirror = await host((_req, res) => {
		res.writeHead(200, { "content-length": String(1024 * 1024) });
		res.write(Buffer.alloc(1024));
	});
	const started = Date.now();
	await expect(ensureModelDownloaded({ cacheDir, mirror: mirror.url })).rejects.toThrow(/no data/);
	expect(Date.now() - started).toBeLessThan(60_000);
}, 90_000);
