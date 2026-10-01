import assert from "node:assert/strict";
import { runCase } from "./run-parity-01-explicit-remember-e2e.mjs";

// 40-noise.e2e.test.ts and helpers/prompts.ts: noisePrompt.
await runCase(async ({ runId, turn, rows }) => {
	const noiseMarker = `n${runId.slice(0, 8)}`;
	assert.ok(turn(noiseMarker).length > 0);
	await new Promise(resolve => setTimeout(resolve, 10_000));
	assert.equal(rows().filter(row => row.text.includes(noiseMarker)).length, 0,
		"noise marker was stored");
});
