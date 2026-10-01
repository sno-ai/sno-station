import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(join(tmpdir(), "logging-rotation-race-"));
await symlink(resolve(root, "node_modules"), join(directory, "node_modules"));
const source = await readFile(resolve(root, "packages/utils/dist/log-file-sink.js"), "utf8");
const marker = "const file = await this.openCurrent();\n                try {\n                    await file.writeFile";
assert.equal(source.split(marker).length, 2, "exact append path-open seam exists once");
const instrumented = source.replace(marker, `const file = await this.openCurrent();
                if (process.argv[2] === "writer" && !globalThis.loggingPaused) {
                    globalThis.loggingPaused = true;
                    process.send({ stage: "path_checked" });
                    await new Promise(resolve => process.once("message", message => {
                        if (message !== "release") throw Error("unexpected pause control");
                        resolve();
                    }));
                }
                try {
                    await file.writeFile`);
await writeFile(join(directory, "sink.mjs"), instrumented);
const clockPath = join(directory, "clock.json");
const today = Date.now();
await writeFile(clockPath, JSON.stringify(today));
await writeFile(join(directory, "clock.mjs"), `import {readFileSync} from "node:fs";
const NativeDate=Date;const now=()=>JSON.parse(readFileSync(${JSON.stringify(clockPath)},"utf8"));
globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};
`);
await writeFile(join(directory, "runner.mjs"), `import {LogFileSink} from "./sink.mjs";
const sink=new LogFileSink(${JSON.stringify(join(directory, "mem-claw.log"))},reason=>JSON.stringify({notice:reason}));
process.on("message",async message=>{
 if(message==="write")sink.enqueue(JSON.stringify({id:process.argv[2]}),"info");
 if(message==="next")sink.enqueue(JSON.stringify({id:"writer-next"}),"info");
 if(message==="close"){await sink.close();process.disconnect();}
});process.send({stage:"ready"});
`);
const children = [];
function child(role) {
	const process = spawn(globalThis.process.execPath, ["--import", join(directory, "clock.mjs"), join(directory, "runner.mjs"), role], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const messages = [];
	let stderr = "";
	process.on("message", message => messages.push(message));
	process.stderr.on("data", bytes => { stderr += bytes; });
	children.push({ process, messages, stderr: () => stderr, closed: once(process, "close") });
	return children.at(-1);
}
async function eventually(read, ready, timeoutMs = 5000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) { const value = await read(); if (ready(value)) return value; await delay(20); }
	throw new Error("Concurrent rotation observation timed out");
}
async function records(path) { return (await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map(JSON.parse); }
const path = join(directory, "mem-claw.log");
try {
	const writer = child("writer");
	await eventually(async () => writer.messages, rows => rows.some(row => row.stage === "ready"));
	writer.process.send("write");
	await eventually(async () => writer.messages, rows => rows.some(row => row.stage === "path_checked"));
	await writeFile(clockPath, JSON.stringify(today + 86400000));
	const rotator = child("rotator");
	await eventually(async () => rotator.messages, rows => rows.some(row => row.stage === "ready"));
	rotator.process.send("write");
	await eventually(() => records(path), rows => rows.some(row => row.id === "rotator"));
	assert.equal((await readdir(directory)).filter(name => /^mem-claw\.log\.\d/.test(name)).length, 0, "rotation cannot complete while path-checked writer holds shared lock");
	writer.process.send("release");
	const rotated = await eventually(() => readdir(directory), names => names.some(name => /^mem-claw\.log\.\d/.test(name)), 70000);
	assert.equal(rotated.filter(name => /^mem-claw\.log\.\d/.test(name)).length, 1, "one dated file with no overwrite");
	writer.process.send("next");
	await eventually(() => records(path), rows => rows.some(row => row.id === "writer-next"));
	for (const child of children) child.process.send("close");
	for (const child of children) assert.equal((await child.closed)[0], 0, child.stderr());
	const all = (await Promise.all((await readdir(directory)).filter(name => name === "mem-claw.log" || /^mem-claw\.log\.\d/.test(name)).map(name => records(join(directory, name))))).flat();
	for (const id of ["writer", "rotator", "writer-next"]) assert.equal(all.filter(row => row.id === id).length, 1, `${id} appears exactly once across rotation`);
	assert.deepEqual((await records(path)).filter(row => row.id).map(row => row.id), ["writer-next"], "writer's next record reaches new current path");
	console.log(JSON.stringify({ passed: true, directory, checks: 6, records: all.length }));
} finally {
	for (const child of children) if (child.process.exitCode === null) child.process.kill("SIGTERM");
}
