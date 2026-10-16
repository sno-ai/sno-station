/** @file local-reranker-heal.test.ts
 * @purpose A reranker model file that went bad on disk, behind a marker that still calls the download complete, is
 * checked and fetched again on the next load, so the reranker comes back without a restart or a manual cache wipe.
 * @boundary Real LocalReranker, real downloader and real model files; a local HTTP server serves the good files as the
 * mirror; only the clock is moved forward past the retry interval.
 */

import { cpSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { downloadModel } from "../../../../packages/embedder/src/downloader.ts";
import { LOCAL_RERANK_MODEL, LocalReranker } from "../../../../packages/embedder/src/local-reranker.ts";

const ID = "sno-lab/multilingual-reranker-small-int8";
const REVISION = "ce76796ae42628f54f501271aeac16df8ecc8a6f";
const goodCache = join(homedir(), ".cache", "sno-test-local-reranker");
const good = join(goodCache, ID, REVISION);
const cacheDir = mkdtempSync(join(tmpdir(), "sno-reranker-heal-"));
const requests: string[] = [];
const server = createServer((req, res) => {
	requests.push(req.url ?? "");
	const path = join(good, decodeURIComponent((req.url ?? "").replace(`/${ID}/resolve/${REVISION}/`, "")));
	res.setHeader("content-length", statSync(path).size);
	createReadStream(path).pipe(res);
});
afterAll(() => {
	vi.useRealTimers();
	server.closeAllConnections();
	server.close();
	rmSync(cacheDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pair = ["Nate lives in Berlin.", "Joanna likes tea."];

it("fetches a damaged model file again after the load fails, and then scores", async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const mirror = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	// The good copy: already in the test cache, or downloaded into it from the hub on a fresh machine.
	await downloadModel(LOCAL_RERANK_MODEL, { cacheDir: goodCache });
	const local = join(cacheDir, ID, REVISION);
	cpSync(good, local, { recursive: true });
	// The weights go bad on disk at the same size; the marker still records the download as complete.
	const fd = openSync(join(local, "onnx/model_quantized.onnx"), "r+");
	writeSync(fd, Buffer.alloc(65_536), 0, 65_536, 0);
	closeSync(fd);

	vi.useFakeTimers({ toFake: ["Date"] });
	const reranker = new LocalReranker({ cacheDir, mirror, intraOpNumThreads: 2 });
	expect(await reranker.score("Where does Nate live?", pair)).toBeUndefined();
	// Each call comes past the retry interval, so the load that failed on the damaged file is tried again whenever it
	// failed; without the check that follows a failed load, every retry fails the same way.
	const deadline = performance.now() + 120_000;
	let scores: number[] | undefined;
	while (scores === undefined && performance.now() < deadline) {
		await wait(1_000);
		vi.setSystemTime(Date.now() + 11 * 60_000);
		scores = await reranker.score("Where does Nate live?", pair);
	}
	expect(scores?.[0]).toBeGreaterThan(scores?.[1] ?? Number.POSITIVE_INFINITY);
	expect(requests).toEqual([`/${ID}/resolve/${REVISION}/onnx/model_quantized.onnx`]);
	expect(readFileSync(join(local, "onnx/model_quantized.onnx")).equals(readFileSync(join(good, "onnx/model_quantized.onnx")))).toBe(true);
	await reranker.dispose();
}, 180_000);
