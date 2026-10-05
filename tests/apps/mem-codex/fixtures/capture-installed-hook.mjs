#!/usr/bin/env node
/** Record an installed Codex hook, then run the real `sno` with the same arguments and input. */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

if (!process.env.SNO_BINARY) throw new Error("SNO_BINARY must be the absolute path of the real sno");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
// argv: memory hook <event> --harness codex
const event = process.argv[4];
const child = spawn(process.env.SNO_BINARY, process.argv.slice(2), {
	env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
let output = "", error = "";
child.stdout.on("data", part => { output += part; });
child.stderr.on("data", part => { error += part; });
child.stdin.end(raw);
child.on("error", cause => { throw cause; });
// The detached capture worker drains the spool within a moment of the Stop hook, so the rows are
// read here, right after the real hook returns, to keep them observable.
function spoolRows() {
	const directory = join(process.env.SNO_PROFILE_DIR ?? "", "sno-mem-codex", "spool");
	let names = [];
	try { names = readdirSync(directory).filter(name => name.endsWith(".json")); }
	catch (cause) { if (cause.code !== "ENOENT") throw cause; }
	return names.flatMap(name => {
		try { return [JSON.parse(readFileSync(join(directory, name), "utf8"))]; }
		catch (cause) { if (cause.code === "ENOENT") return []; throw cause; }
	});
}
child.on("exit", async code => {
	await appendFile(process.env.SNO_MEM_UPDATE_CAPTURE_FILE,
		`${JSON.stringify({ command: event, input: JSON.parse(raw), output, error, code, spoolAfter: spoolRows() })}\n`);
	process.stdout.write(output);
	process.stderr.write(error);
	process.exitCode = code ?? 1;
});
