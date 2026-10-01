import { spawn } from "node:child_process";
import type { CommandOptions, CommandResult } from "./types";

export async function runRequiredCommand(
	command: string,
	args: string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	const result = await runCommand(command, args, options);
	if (result.code !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
	}
	return result;
}

export function runCommand(
	command: string,
	args: string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	return new Promise((resolveCommand, rejectCommand) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: true,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timeout: NodeJS.Timeout | undefined;
		let killTimeout: NodeJS.Timeout | undefined;
		let spawnError: Error | undefined;
		let timedOut = false;
		if (options.timeoutMs !== undefined) {
			timeout = setTimeout(() => {
				timedOut = true;
				killChildProcessGroup(child.pid, "SIGTERM");
				killTimeout = setTimeout(() => {
					killChildProcessGroup(child.pid, "SIGKILL");
				}, 2_000);
			}, options.timeoutMs);
		}
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			if (options.forwardStderr === true) process.stderr.write(chunk);
		});
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (code, signal) => {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (killTimeout) {
				clearTimeout(killTimeout);
			}
			if (spawnError) {
				rejectCommand(spawnError);
				return;
			}
			if (timedOut) {
				rejectCommand(new Error(`${command} ${args.join(" ")} timed out`));
				return;
			}
			resolveCommand({
				code,
				signal,
				stderr: Buffer.concat(stderr).toString("utf8"),
				stdout: Buffer.concat(stdout).toString("utf8"),
			});
		});
		if (options.input !== undefined) {
			child.stdin.end(options.input);
		} else {
			child.stdin.end();
		}
	});
}

function killChildProcessGroup(
	pid: number | undefined,
	signal: NodeJS.Signals,
): void {
	if (!pid) {
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process already exited; close will settle the command promise.
		}
	}
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function shellWord(value: string): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error(`Unsafe shell word: ${value}`);
	}
	return value;
}
