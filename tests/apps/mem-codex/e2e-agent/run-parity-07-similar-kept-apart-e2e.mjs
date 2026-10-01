import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runCase } from "./run-parity-01-explicit-remember-e2e.mjs";

// 64-similar-memory-disambiguation.e2e.test.ts: separate stored items, fresh recall.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runCase(async ({ runId, turn, waitRows }) => {
		const suffix = runId.slice(0, 8);
		const similarMarker = `atlas-${suffix}`;
		const similarDecoyCode = `notebook-${suffix}`;
		const similarCorrectCode = `backpack-${suffix}`;

		const decoyTeach = turn(`Please remember one project handoff detail for future sessions: For Project Atlas ${similarMarker}, the blue notebook code is ${similarDecoyCode}. Later I will ask about a different blue backpack code, so keep the notebook item distinct. Reply with exactly: noted.`);
		assert.ok(decoyTeach.length > 0);
		const decoyMemory = await waitRows(
			rows => rows.some(row => row.text.includes(similarDecoyCode)),
			"similar memory row containing decoy code",
		);
		assert.ok(decoyMemory.some(row => row.text.includes(similarDecoyCode)));
		console.log(JSON.stringify({ decoyMemory }));

		const correctTeach = turn(`Please remember one project handoff detail for future sessions: For Project Atlas ${similarMarker}, the blue backpack code is ${similarCorrectCode}. This is different from the notebook code; later I will ask for the backpack code only. Reply with exactly: noted.`, true);
		assert.ok(correctTeach.length > 0);
		const correctMemory = await waitRows(
			rows => rows.some(row => row.text.includes(similarCorrectCode)),
			"similar memory row containing correct code",
		);
		assert.ok(correctMemory.some(row => row.text.includes(similarCorrectCode)));
		console.log(JSON.stringify({ correctMemory }));

		const recall = turn(`For Project Atlas ${similarMarker}, what is my blue backpack code? Answer with only that code.`);
		assert.ok(recall.includes(similarCorrectCode), `recall missing ${similarCorrectCode}: ${recall}`);
		assert.ok(!recall.includes(similarDecoyCode), `recall contains decoy ${similarDecoyCode}: ${recall}`);
	});
}
