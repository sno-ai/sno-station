import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runCase } from "./run-parity-01-explicit-remember-e2e.mjs";

// 65-exact-identifier-recall.e2e.test.ts: exact stored identifier and fresh-session recall.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runCase(async ({ runId, turn, waitRows }) => {
		const exactCode = `SNO-OPS/${runId}_R7.caseA`;
		const teach = turn(`Remember this exact support handoff detail for run ${runId}: exact support handoff identifier ${exactCode}. Preserve punctuation and letter case.`);
		assert.ok(teach.length > 0, "teach response must not be empty");
		await waitRows(
			rows => rows.some(row => row.text.includes(exactCode)),
			"exact-identifier-recall memory evidence",
			Number(process.env.SNO_AGENT_E2E_MEMORY_TIMEOUT_MS || 60_000),
		);
		const recall = turn(`For run ${runId}, what exact support handoff identifier did I ask you to remember? Answer with only the identifier, preserving punctuation and letter case.`);
		assert.ok(recall.length > 0, "recall response must not be empty");
		assert.ok(recall.includes(exactCode), `recall missing ${exactCode}: ${recall}`);
	});
}
