/** @file local-reranker-dispose.test.ts
 * @purpose Releasing the reranker while a model run it no longer waits for is still going (a recall past its deadline,
 * then shutdown) waits for that run instead of freeing the model under it.
 * @boundary Real LocalReranker and real model files from the test cache directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalReranker } from "../../../../packages/embedder/src/local-reranker.ts";

const cacheDir = join(homedir(), ".cache", "sno-test-local-reranker");

it("a release during a model run lets the run finish with scores", async () => {
	const reranker = new LocalReranker({ cacheDir, intraOpNumThreads: 1 });
	const deadline = performance.now() + 240_000;
	while ((await reranker.score("probe", ["probe"])) === undefined && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	const long = "Nate: We spent most of the evening talking about the garden, who would sort it out, and what it would cost. ".repeat(20);
	const running = reranker.score("Where does Nate live?", Array.from({ length: 15 }, (_, i) => `${i} ${long}`));
	await new Promise((resolve) => setTimeout(resolve, 50));
	await reranker.dispose();
	const scores = await running;
	expect(scores?.length).toBe(15);
}, 300_000);
