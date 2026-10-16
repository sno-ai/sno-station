/** @file local-reranker-shared.test.ts
 * @purpose Rerankers in one process share one loaded model: a second one scores at once, and releasing one keeps the
 * other working.
 * @boundary Real LocalReranker and real model download into a test cache directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalReranker } from "../../../../packages/embedder/src/local-reranker.ts";

const cacheDir = join(homedir(), ".cache", "sno-test-local-reranker");

it("a second reranker scores on its first call once the first has loaded the model, and survives the first's release", async () => {
	const first = new LocalReranker({ cacheDir, intraOpNumThreads: 2 });
	expect(await first.score("Where does Nate live?", ["Nate lives in Berlin.", "Joanna likes tea."])).toBeUndefined();
	const deadline = Date.now() + 240_000;
	let scores: number[] | undefined;
	while (scores === undefined && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		scores = await first.score("Where does Nate live?", ["Nate lives in Berlin.", "Joanna likes tea."]);
	}
	expect(scores?.[0]).toBeGreaterThan(scores?.[1] ?? Number.POSITIVE_INFINITY);
	// A caller that already stopped waiting gets no run at all.
	expect(await first.score("Where does Nate live?", ["Nate lives in Berlin.", "Joanna likes tea."], AbortSignal.abort())).toBeUndefined();

	const second = new LocalReranker({ cacheDir, intraOpNumThreads: 2 });
	await first.dispose();
	const again = await second.score("Nate 住在哪里？", ["Nate 住在柏林。", "Joanna 喜欢喝茶。"]);
	expect(again?.[0]).toBeGreaterThan(again?.[1] ?? Number.POSITIVE_INFINITY);
	await second.dispose();
}, 300_000);
