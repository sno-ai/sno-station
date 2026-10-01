import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { runCase, remote, profile, unit } from "./run-parity-01-explicit-remember-e2e.mjs";

// 62-restart-recall.e2e.test.ts: stored marker survives a real restart and fresh recall.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runCase(async ({ runId, turn, waitRows }) => {
		const restartNonce = randomUUID();
		const restartProject = `RestartVault-${runId}`;
		const restartFact = `For ${restartProject}, encrypted restart recall marker ${restartNonce}; gemstone lapis-lazuli.`;
		turn(`Please remember this project handoff detail for future sessions: ${restartFact}`);

		const beforeRestartEvidence = await waitRows(
			rows => rows.filter(row => row.text.includes(restartNonce)).length > 0,
			"encrypted memory row before sidecar restart",
		);
		console.log(JSON.stringify({ beforeRestartEvidence }));

		// Restart the memory-owning process; every turn already starts a fresh Codex process.
		console.log(`Restarting ${unit}; memory service unavailable until health returns (up to 60 seconds).`);
		const restart = remote(`systemctl --user restart ${unit}
for attempt in $(seq 1 30); do
  if port=$(jq -r .port ${profile}/station/sidecar.json 2>/dev/null) && curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    systemctl --user is-active ${unit}
    exit 0
  fi
  sleep 2
done
echo 'Sidecar health did not recover after restart' >&2
exit 1`, 90_000);
		console.log(JSON.stringify({ restart }));

		const afterRestartEvidence = await waitRows(
			rows => rows.filter(row => row.text.includes(restartNonce)).length > 0,
			"encrypted memory row after sidecar restart",
		);
		console.log(JSON.stringify({ afterRestartEvidence }));

		const answer = turn(`For ${restartProject}, what is my encrypted restart recall marker and gemstone? Answer with only the marker UUID and gemstone.`).toLowerCase();
		assert.ok(answer.includes(restartNonce), `recall missing ${restartNonce}: ${answer}`);
		assert.ok(answer.includes("lapis"), `recall missing lapis: ${answer}`);
	});
}
