#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { doctor } from "./doctor.js";
import { correctCommand, getCommand, recallCommand, rememberCommand } from "./explicit.js";
import { postToolUse, preToolUse, sessionEnd, sessionStart, stop, userPromptSubmit } from "./hooks.js";
import { installCodex } from "./install.js";
import { importRepository, importUser } from "./import.js";
import { MESSAGES } from "./messages.js";
import { workspaceRoot } from "./scope.js";
import { runWorker } from "./worker.js";

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

async function main(): Promise<number> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "session-start") {
		process.stdout.write(`${await sessionStart(await readStdin())}\n`);
		return 0;
	}
	if (command === "user-prompt-submit") {
		process.stdout.write(`${await userPromptSubmit(await readStdin())}\n`);
		return 0;
	}
	if (command === "stop") {
		await stop(await readStdin());
		return 0;
	}
	if (command === "session-end") {
		await sessionEnd(await readStdin());
		return 0;
	}
	if (command === "pre-tool-use") {
		await preToolUse(await readStdin());
		return 0;
	}
	if (command === "post-tool-use") {
		await postToolUse(await readStdin());
		return 0;
	}
	if (command === "worker") {
		await runWorker();
		return 0;
	}
	if (command === "install") {
		const codexHome = option(args, "--codex-home");
		if (!codexHome || !isAbsolute(codexHome)) throw new Error("--codex-home must be absolute");
		const programPath = process.env["SNO_EXECUTABLE"];
		if (!programPath || !isAbsolute(programPath)) throw new Error("SNO_EXECUTABLE must be the absolute path of sno; run sno setup");
		await installCodex({
			codexHome,
			programPath,
			dryRun: args.includes("--dry-run"),
			writeOutput: line => process.stdout.write(`${line}\n`),
		});
		if (!args.includes("--dry-run")) {
			await importUser(codexHome).catch(() => process.stdout.write(`${MESSAGES.installImportDeferred}\n`));
		}
		return 0;
	}
	if (command === "import") {
		const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
		const repo = option(args, "--repo");
		if (!args.includes("--user") && (!repo || !isAbsolute(repo))) throw new Error("import requires --user or --repo <absolute-root>");
		const result = args.includes("--user")
			? await importUser(codexHome)
			: repo && isAbsolute(repo) ? await importRepository(await workspaceRoot(repo)) : undefined;
		if (!result) throw new Error("import requires --user or --repo <absolute-root>");
		process.stdout.write(`blocks fed: ${result.blocksFed}\nreceipt: ${result.receiptPath}\n`);
		return 0;
	}
	if (command === "doctor") {
		const codexHome = option(args, "--codex-home") ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
		const lines = await doctor(codexHome).catch(() => [MESSAGES.doctorUnavailable]);
		for (const line of lines) process.stdout.write(`${line}\n`);
		return 0;
	}
	if (command === "recall") {
		const result = await recallCommand(args.join(" "));
		process.stdout.write(`${result.text}\n`);
		return result.ok ? 0 : 1;
	}
	if (command === "get") {
		const result = await getCommand(args[0] ?? "");
		process.stdout.write(`${result.text}\n`);
		return result.ok ? 0 : 1;
	}
	if (command === "remember") {
		const result = await rememberCommand(args.join(" "));
		process.stdout.write(`${result.text}\n`);
		return result.ok ? 0 : 1;
	}
	if (command === "correct") {
		const result = await correctCommand(args[0] ?? "", args.slice(1).join(" "));
		process.stdout.write(`${result.text}\n`);
		return result.ok ? 0 : 1;
	}
	process.stderr.write(`${MESSAGES.usage}\n`);
	return 2;
}

main().then(code => {
	process.exitCode = code;
	if (process.argv[2] === "session-start") {
		process.stdout.write("", () => process.exit(code));
	}
}, error => {
	const reason = error instanceof Error ? error.message : "engine-failed";
	process.stderr.write(`${reason}\n`);
	process.exitCode = 1;
});
