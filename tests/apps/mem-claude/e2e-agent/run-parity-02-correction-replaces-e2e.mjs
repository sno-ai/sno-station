import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClaudeNative, shellQuote } from "./run-parity-01-explicit-remember-e2e.mjs";

const test = await createClaudeNative("correct");
let failure;
try {
	const nonce = randomUUID();
	const oldText = `The native Claude cedar release owner for ${nonce} is Dana.`;
	const newText = `The native Claude cedar release owner for ${nonce} is Jordan.`;
	const run = await test.model(`Use Bash only and run each memory command separately, waiting for each result. Use ${shellQuote(test.sno)} exactly, in the form ${shellQuote(test.sno)} memory <action> --harness claude <arguments>.
1. remember ${shellQuote(oldText)}.
2. get the id returned by remember.
3. correct that original id with ${shellQuote(newText)}.
4. get the fresh id returned by correct.
5. get the original id again.
6. recall ${shellQuote(`native Claude cedar release owner ${nonce}`)}.
Return the actual tool outputs. Do not use in-place update, pending metadata, or background REM.`);
	const oldId = test.output(run, "remember").text;
	const newId = test.output(run, "correct").text;
	assert.match(oldId, /^[0-9a-f-]{36}$/i);
	assert.match(newId, /^[0-9a-f-]{36}$/i);
	assert.notEqual(oldId, newId);
	const oldGets = test.outputs(run, `get ${oldId}`);
	assert.ok(oldGets.every(result => !result.isError));
	assert.ok(oldGets.some(result => result.text === `${oldId}\n${oldText}`), "The model must read the original before correcting it");
	assert.ok(oldGets.some(result => result.text === `${oldId}\n${oldText}\nretired; superseded by ${newId}`), "The model must read retirement after correcting it");
	assert.equal(test.output(run, `get ${newId}`).text, `${newId}\n${newText}`);
	const stored = await test.rows();
	const old = stored.find(row => row.id === oldId);
	const current = stored.find(row => row.id === newId);
	assert.equal(old?.text, oldText);
	assert.equal(current?.text, newText);
	assert.equal(JSON.parse(old.metadata).superseded_by, newId);
	assert.equal(JSON.parse(current.metadata).superseded_by, undefined);
	assert.equal(current.projectId, old.projectId);
	assert.equal(stored.length, 2);
	const oldGet = await test.cli("get", oldId);
	const newGet = await test.cli("get", newId);
	assert.equal(oldGet.code, 0, oldGet.stderr);
	assert.equal(newGet.code, 0, newGet.stderr);
	assert.equal(oldGet.stdout.trim(), `${oldId}\n${oldText}\nretired; superseded by ${newId}`);
	assert.equal(newGet.stdout.trim(), `${newId}\n${newText}`);
	const recalled = test.output(run, "recall").text;
	assert.ok(recalled.includes(`${oldId}\t`) && recalled.includes(`retired; superseded by ${newId}`));
	assert.ok(recalled.includes(`${newId}\t${newText} [id:${newId}]\n${newText}`));
	test.proof.checks.modelCorrectionAndReadback = true;
	for (const content of [newText, `The native Claude cedar release owner for ${nonce} is Avery.`]) {
		const retry = await test.cli("correct", oldId, content);
		assert.notEqual(retry.code, 0, "Retry on the retired id must refuse the proposed wording");
		assert.equal(retry.stdout.trim(), `already-superseded: superseded by ${newId}; correct that id`);
		const remaining = await test.rows();
		assert.equal(remaining.length, 2, "Retry must not add a third row");
		assert.equal(remaining.find(row => row.id === newId)?.text, newText);
	}
	test.proof.checks.sameAndDifferentRetry = true;
	const fresh = await test.model(`Run Bash ${test.memory("get")} ${newId} once and return the full entry. The old ${oldId} is retired. Do not remember or correct anything.`);
	assert.equal(test.output(fresh, `get ${newId}`).text, `${newId}\n${newText}`);
	const contexts = test.hooks().filter(item => item.input.session_id === fresh.session && !item.input.agent_id
		&& ["session-start", "user-prompt-submit"].includes(item.command));
	assert.ok(contexts.some(item => item.stdout.includes(` [id:${newId}]`)), "Fresh native session must inject the successor");
	assert.ok(contexts.every(item => !item.stdout.includes(oldId) && !item.stdout.includes(oldText)), "Retired row must not be auto-injected");
	assert.equal(contexts.flatMap(item => item.stdout.match(new RegExp(`\\[id:${newId}\\]`, "g")) ?? []).length, 1);
	assert.ok(contexts.some(item => item.command === "user-prompt-submit"));
	assert.ok(contexts.every(item => !item.stderr.includes('"reason":"invalid-input"')));
	test.proof.checks.currentOnlyNativeInjection = true;
	test.proof.passed = true;
} catch (error) { failure = error; }
await test.finish(failure);
