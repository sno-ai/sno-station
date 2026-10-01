import assert from "node:assert/strict";
import { runNativeCase, quote } from "./run-parity-01-explicit-remember-e2e.mjs";

// Real Codex tools perform correction; the fixture only reads the encrypted destination.
await runNativeCase(async ({ runId, cli, turn, action, hooks, rowCount, readRow }) => {
	const oldText = `The native Codex release owner for ${runId} is Dana.`;
	const newText = `The native Codex release owner for ${runId} is Jordan.`;
	const changedText = `The native Codex release owner for ${runId} is Avery.`;
	const command = `${quote(process.execPath)} ${quote(cli)}`;
	const remembered = await turn(`Run exactly: ${command} remember ${quote(oldText)}. Reply only with the stored memory id. Do not write or edit files.`);
	assert.match(remembered.response, /^[0-9a-f-]{36}$/);
	const oldId = remembered.response;
	assert.equal((await readRow(oldId))?.text, oldText);
	const corrected = await turn(`Run exactly: ${command} correct ${quote(oldId)} ${quote(newText)}. Reply only with the new memory id. Do not write or edit files.`, remembered.session);
	assert.match(corrected.response, /^[0-9a-f-]{36}$/);
	const newId = corrected.response;
	assert.notEqual(newId, oldId);
	const oldRow = await readRow(oldId), newRow = await readRow(newId);
	assert.equal(JSON.parse(oldRow.metadata).superseded_by, newId);
	assert.equal(newRow.text, newText);
	assert.equal(JSON.parse(newRow.metadata).superseded_by, undefined);
	const get = await action("get", oldId);
	assert.deepEqual(get, { ok: true, text: `${oldId}\n${oldText}\nretired; superseded by ${newId}` });
	assert.deepEqual(await action("get", newId), { ok: true, text: `${newId}\n${newText}` });
	const recalled = await action("recall", `native Codex release owner ${runId}`);
	assert.ok(recalled.ok, recalled.text);
	assert.ok(recalled.text.includes(`retired; superseded by ${newId}`), recalled.text);
	assert.ok(recalled.text.includes(newText), recalled.text);
	const before = await rowCount(), refusal = `already-superseded: superseded by ${newId}; correct that id`;
	for (const content of [newText, changedText]) assert.deepEqual(await action("correct", oldId, content), { ok: false, text: refusal });
	assert.equal(await rowCount(), before, "same and different text retries must create no extra rows");
	const automatic = await turn(`Who is the current release owner for ${runId}? Use the Sno memory data already in this conversation. Reply only with the person's name. Do not run tools or commands.`);
	const currentBlocks = hooks().filter(hook => hook.input.session_id === automatic.session && ["session-start", "user-prompt-submit"].includes(hook.command))
		.map(hook => JSON.parse(hook.output).hookSpecificOutput.additionalContext);
	const current = currentBlocks.join("\n");
	assert.ok(current.includes(`[id:${newId}]`), current);
	assert.ok(!current.includes(`[id:${oldId}]`), current);
	assert.equal(current.split(`[id:${newId}]`).length - 1, 1, "automatic phases must not repeat the successor id");
	const resumed = await turn(`For ${runId}, repeat the current release owner's name using the same conversation memory. Reply only with the name. Do not run tools or commands.`, automatic.session);
	const later = hooks().filter(hook => hook.input.session_id === automatic.session && ["session-start", "user-prompt-submit"].includes(hook.command))
		.map(hook => JSON.parse(hook.output).hookSpecificOutput.additionalContext).join("\n");
	assert.equal(later.split(`[id:${newId}]`).length - 1, 1, "resume must preserve the service repeat ledger");
	console.log(JSON.stringify({ correction: { oldId, newId, oldClosed: true, successorCurrent: true, retryRowCount: before, currentResponse: automatic.response, resumedResponse: resumed.response } }));
	assert.equal(automatic.response, "Jordan");
	assert.equal(resumed.response, "Jordan");
});
