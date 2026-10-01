import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runCase, remote, quote, root, profile } from "./run-parity-01-explicit-remember-e2e.mjs";

// 60-cjk-memory.e2e.test.ts and 63-multilingual-restart-recall.e2e.test.ts (recall only).
const failures = [];
try {
	await runCase(async ({ turn }) => {
		assert.ok(turn("请记住这个中文使用偏好，之后我会问项目代号和茶饮偏好：我的中文项目代号是青岚九号，默认茶饮偏好是冻顶乌龙。").length > 0);
		const end = Date.now() + 300_000;
		let answer;
		do {
			answer = turn("我的中文项目代号是什么？我的默认茶饮偏好是什么？只回答项目代号和茶名。");
			if ((answer.includes("青岚") || answer.includes("青嵐")) && (answer.includes("冻顶乌龙") || answer.includes("凍頂烏龍"))) return;
			await new Promise(resolve => setTimeout(resolve, 10_000));
		} while (Date.now() < end);
		assert.fail(`CJK recall response containing project name and tea: ${answer}`);
	});
} catch (error) { failures.push(error.message); }
try {
	await runCase(async ({ runId, cwd, rows, turn }) => {
		const nonce = randomUUID();
		const marker = `alondra-${nonce.slice(0, 8)}`;
		const text = `Proyecto ${marker}; codigo ${nonce}; ciudad favorita: Sevilla.`;
		const result = JSON.parse(remote(`SNO_PROFILE_DIR=${profile} node --input-type=module <<'JS'
import {connectMemory} from "${root}/mem-codex/dist/memory-client.js";
const client=await connectMemory();
const result=await client.mutate({op:"store",content:${JSON.stringify(text)},category:"episodic",importance:1,metadata:{e2ePhase:"63-multilingual-restart-recall",runId:${JSON.stringify(runId)}}},{principal:"lh",project:${JSON.stringify(cwd)},session:"fixture",host:{sessionId:"fixture"}});
console.log(JSON.stringify(result));
JS`));
		assert.equal(result.degraded, false);
		assert.ok(rows().some(row => row.text === text), "Imported memory fixture was not visible");
		const answer = turn(`Para el proyecto ${marker}, cual es mi codigo de memoria en espanol y cual es mi ciudad favorita? Responde solo con el codigo y la ciudad.`);
		assert.ok(answer.includes(nonce), `multilingual recall missing ${nonce}: ${answer}`);
		assert.ok(answer.includes("Sevilla"), `multilingual recall missing Sevilla: ${answer}`);
	});
} catch (error) { failures.push(error.message); }
assert.equal(failures.length, 0, failures.join("\n"));
