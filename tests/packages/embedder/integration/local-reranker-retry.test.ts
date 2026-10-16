/** @file local-reranker-retry.test.ts
 * @purpose A model load whose download failed (the network was down) is tried again once some minutes have passed, so
 * a transient failure does not leave the process without the model until it restarts.
 * @boundary Real LocalReranker, real model files from a test cache directory; only the clock is moved forward.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { LocalReranker } from "../../../../packages/embedder/src/local-reranker.ts";

const emptyCache = mkdtempSync(join(tmpdir(), "sno-reranker-empty-"));
afterAll(() => {
	vi.useRealTimers();
	rmSync(emptyCache, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pair = ["Nate lives in Berlin.", "Joanna likes tea."];

it("tries the model load again after a failed one, once the retry interval has passed", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// Nothing cached and a download host that refuses the connection.
	const unreachable = new LocalReranker({ cacheDir: emptyCache, mirror: "http://127.0.0.1:9/" });
	expect(await unreachable.score("Where does Nate live?", pair)).toBeUndefined();
	// The downloader retries an unreachable host for about 15 s before the load fails.
	await wait(20_000);
	const online = new LocalReranker({ cacheDir: join(homedir(), ".cache", "sno-test-local-reranker"), intraOpNumThreads: 2 });
	expect(await online.score("Where does Nate live?", pair)).toBeUndefined();

	vi.setSystemTime(Date.now() + 11 * 60_000);
	const deadline = performance.now() + 240_000;
	let scores = await online.score("Where does Nate live?", pair);
	while (scores === undefined && performance.now() < deadline) {
		await wait(1_000);
		scores = await online.score("Where does Nate live?", pair);
	}
	expect(scores?.[0]).toBeGreaterThan(scores?.[1] ?? Number.POSITIVE_INFINITY);
	await unreachable.dispose();
	await online.dispose();
}, 300_000);
