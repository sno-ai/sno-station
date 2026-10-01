import assert from "node:assert/strict";
import { runCase } from "./run-parity-01-explicit-remember-e2e.mjs";

// 92-profile-section-writers.e2e.test.ts: active-task portion only.
await runCase(async ({ runId, cwd, turn, waitRows, db }) => {
	const activeTask = `prepare archive review packet ${runId}`;
	turn(`Remember this current open task: ${activeTask}. It remains active.`);
	// The atomic path records an open task in the task lifecycle store, not an active_tasks row.
	await waitRows(rows => rows.some(row => row.text.includes(runId) && row.metadata.todo === "open"),
		"open-task evidence: no memory row marked todo open");
	const tasks = db(`console.log(JSON.stringify(db.prepare("SELECT status FROM nodix_active_task_instances WHERE project_id = ?").all(${JSON.stringify(cwd)})));`);
	assert.ok(tasks.some(task => task.status === "active"), `open-task evidence: no active task for ${cwd}`);
});
