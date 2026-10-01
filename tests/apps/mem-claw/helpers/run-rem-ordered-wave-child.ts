import { runRemProductionOrderedWave } from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";

const scope = process.env["REM_ACC6_SCOPE"];

if (!scope) {
	throw new Error("REM ACC-6 child input is incomplete");
}

const result = await runRemProductionOrderedWave({
	scope,
	implementationVersion: "acc6-owner-decided-wave-v1",
});

process.stdout.write(`${JSON.stringify(result)}\n`);
