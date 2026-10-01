#!/usr/bin/env node
/** Record an installed Codex hook and forward unchanged input to the real plugin CLI. */
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const args = process.env.SNO_MEM_UPDATE_TSX
	? ["--import", process.env.SNO_MEM_UPDATE_TSX, process.env.SNO_MEM_UPDATE_CLI, ...process.argv.slice(2)]
	: [process.env.SNO_MEM_UPDATE_CLI, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
	env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
let output = "", error = "";
child.stdout.on("data", part => { output += part; });
child.stderr.on("data", part => { error += part; });
child.stdin.end(raw);
child.on("error", cause => { throw cause; });
child.on("exit", async code => {
	await appendFile(process.env.SNO_MEM_UPDATE_CAPTURE_FILE,
		`${JSON.stringify({ command: process.argv[2], input: JSON.parse(raw), output, error, code })}\n`);
	process.stdout.write(output);
	process.stderr.write(error);
	process.exitCode = code ?? 1;
});
