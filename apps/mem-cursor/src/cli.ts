#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { doctor } from "./doctor.js";
import { correctCommand, getCommand, recallCommand, rememberCommand } from "./explicit.js";
import { afterAgentResponse, afterAgentThought, preCompact, sessionEnd, sessionStart, stop, userPromptSubmit } from "./hooks.js";
import { installCursor, uninstallCursor } from "./install.js";
import { runWorker } from "./worker.js";

const USAGE = "Run through sno: sno memory <recall|get|remember|correct|doctor> --harness cursor, or sno memory hook <event> --harness cursor";

const HOOKS: Record<string, (raw: unknown) => Promise<string>> = {
	"session-start": sessionStart,
	"user-prompt-submit": userPromptSubmit,
	"after-agent-response": afterAgentResponse,
	"after-agent-thought": afterAgentThought,
	stop,
	"pre-compact": preCompact,
	"session-end": sessionEnd,
};

async function readStdin(): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text ? JSON.parse(text) : {};
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function cursorHome(args: string[], required: boolean): string {
	const home = option(args, "--cursor-home") ?? (required ? undefined : join(homedir(), ".cursor"));
	if (!home || !isAbsolute(home)) throw new Error("--cursor-home must be absolute");
	return home;
}

async function main(): Promise<number> {
	const [command = "", ...args] = process.argv.slice(2);
	const hook = HOOKS[command];
	if (hook) {
		process.stdout.write(`${await hook(await readStdin())}\n`);
		return 0;
	}
	const writeOutput = (line: string): void => { process.stdout.write(`${line}\n`); };
	if (command === "worker") {
		await runWorker();
		return 0;
	}
	if (command === "install") {
		const programPath = process.env["SNO_EXECUTABLE"];
		if (!programPath || !isAbsolute(programPath)) throw new Error("SNO_EXECUTABLE must be the absolute path of sno; run sno setup");
		await installCursor({ cursorHome: cursorHome(args, true), programPath, dryRun: args.includes("--dry-run"), writeOutput });
		return 0;
	}
	if (command === "uninstall") {
		await uninstallCursor({ cursorHome: cursorHome(args, true), dryRun: args.includes("--dry-run"), writeOutput });
		return 0;
	}
	if (command === "doctor") {
		const lines = await doctor(cursorHome(args, false)).catch(() => ["doctor: unavailable"]);
		for (const line of lines) writeOutput(line);
		return 0;
	}
	const explicit = {
		recall: () => recallCommand(args.join(" ")),
		get: () => getCommand(args[0] ?? ""),
		remember: () => rememberCommand(args.join(" ")),
		correct: () => correctCommand(args[0] ?? "", args.slice(1).join(" ")),
	}[command];
	if (explicit) {
		const result = await explicit();
		writeOutput(result.text);
		return result.ok ? 0 : 1;
	}
	process.stderr.write(`${USAGE}\n`);
	return 2;
}

const command = process.argv[2] ?? "";
main().then(code => {
	process.exitCode = code;
	if (command in HOOKS || command === "worker") process.stdout.write("", () => process.exit(code));
}, error => {
	if (command in HOOKS) {
		// Unreadable hook input: Cursor still gets an empty answer and the conversation continues.
		process.stderr.write(`${JSON.stringify({ event: command, reason: "invalid-input", impact: "hook did nothing" })}\n`);
		process.stdout.write("{}\n", () => process.exit(0));
		return;
	}
	process.stderr.write(`${error instanceof Error ? error.message : "engine-failed"}\n`);
	process.exitCode = 1;
});
