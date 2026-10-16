/** @file local-reranker-release-during-load.test.ts
 * @purpose Releasing the reranker while its model is still downloading (a recall just before shutdown, on first use)
 * returns at once instead of waiting for the download.
 * @boundary Real LocalReranker; the download host is a local server that accepts the request and never answers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalReranker } from "../../../../packages/embedder/src/local-reranker.ts";

it("a release during the model download returns without waiting for it", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "sno-reranker-download-"));
	let requests = 0;
	const host = createServer(() => { requests += 1; });
	await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
	try {
		const reranker = new LocalReranker({ cacheDir, mirror: `http://127.0.0.1:${(host.address() as AddressInfo).port}/` });
		expect(await reranker.score("Where does Nate live?", ["Nate lives in Berlin."])).toBeUndefined();
		const deadline = performance.now() + 30_000;
		while (requests === 0 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		expect(requests).toBeGreaterThan(0);
		const started = performance.now();
		const released = await Promise.race([
			reranker.dispose().then(() => "released"),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
		]);
		expect(released).toBe("released");
		expect(performance.now() - started).toBeLessThan(1_000);
	} finally {
		host.closeAllConnections();
		host.close();
		rmSync(cacheDir, { recursive: true, force: true });
	}
}, 60_000);
