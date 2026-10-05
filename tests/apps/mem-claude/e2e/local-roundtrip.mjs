import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClaudeNative, shellQuote } from "../e2e-agent/run-parity-01-explicit-remember-e2e.mjs";

const test = await createClaudeNative("roundtrip");
let failure;
try {
	const text = `The Claude local roundtrip marker is ${randomUUID()}.`;
	const remember = await test.model(`Run exactly one Bash command: ${test.memory("remember")} ${shellQuote(text)}. Return its output.`);
	const id = test.output(remember, "remember").text;
	assert.match(id, /^[0-9a-f-]{36}$/i);
	assert.equal((await test.rows()).find(row => row.id === id)?.text, text);
	const recall = await test.model(`Run exactly one Bash command: ${test.memory("recall")} ${shellQuote("Claude local roundtrip marker")}. Return its actual output.`);
	assert.ok(test.output(recall, "recall").text.includes(text));
	test.proof.passed = true;
} catch (error) { failure = error; }
await test.finish(failure);
