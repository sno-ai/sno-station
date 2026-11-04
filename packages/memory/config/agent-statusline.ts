import { spawn } from "node:child_process";
import { compactAgentView, readAgentView } from "./agent-state";
import { shellQuote } from "./coding-skin";

type StatusHarness = "claude" | "cursor";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function originalStatusLine(command: unknown, harness: StatusHarness): { value: unknown } | undefined {
	if (typeof command !== "string" || !command.includes(`/mem-${harness}/dist/cli.js' status-line `)) return undefined;
	const encoded = / --sno-original '([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
	if (!encoded) return undefined;
	const values: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	if (!Array.isArray(values)) throw new Error("invalid original status-line configuration");
	return { value: values[0] };
}

/** The owned command carries the original configuration; no separate settings backup is needed. */
export function composeAgentStatusLine(config: Record<string, unknown>, entryPath: string, harness: StatusHarness, installing: boolean): void {
	const previous = originalStatusLine(record(config.statusLine)?.command, harness);
	if (!installing && !previous) return;
	const original = previous ? previous.value : config.statusLine;
	if (!installing) {
		if (original === undefined) delete config.statusLine;
		else config.statusLine = original;
		return;
	}
	const encoded = Buffer.from(JSON.stringify(original === undefined ? [] : [original])).toString("base64");
	config.statusLine = {
		...record(original),
		type: "command",
		command: `${shellQuote(process.execPath)} ${shellQuote(entryPath)} status-line --sno-original '${encoded}'`,
	};
}

async function userOutput(command: string, input: string): Promise<{ output: Buffer; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "inherit"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", code => resolve({ output: Buffer.concat(chunks), code: code ?? 1 }));
		child.stdin.on("error", error => { if (!("code" in error) || error.code !== "EPIPE") reject(error); });
		child.stdin.end(input);
	});
}

export async function renderAgentStatusLine(harness: StatusHarness, originalEncoded: string, input: string): Promise<number> {
	const originals: unknown = JSON.parse(Buffer.from(originalEncoded, "base64").toString("utf8"));
	const command = Array.isArray(originals) ? record(originals[0])?.command : undefined;
	const user = typeof command === "string" ? await userOutput(command, input) : { output: Buffer.alloc(0), code: 0 };
	const newlineLength = user.output.at(-1) === 10 ? (user.output.at(-2) === 13 ? 2 : 1) : 0;
	process.stdout.write(user.output.subarray(0, user.output.length - newlineLength));
	try {
		const payload = record(JSON.parse(input));
		// Both clients' status-line payloads use session_id; Cursor hooks separately use conversation_id.
		const sessionId = payload?.session_id;
		if (typeof sessionId !== "string" || !sessionId) throw new Error("current client session identity unavailable");
		const view = await readAgentView({ recent: true });
		const segment = compactAgentView(view, { harness, sessionId });
		const color = /\bneed you\b/.test(segment) ? "\x1b[1;33m" : "\x1b[2m";
		const displayed = process.env.NO_COLOR === undefined ? `${color}${segment}\x1b[0m` : segment;
		process.stdout.write(`${user.output.length > newlineLength ? " | " : ""}${displayed}\n`);
	} catch (error) {
		process.stdout.write(user.output.subarray(user.output.length - newlineLength));
		process.stderr.write(`${JSON.stringify({ operation: "agent-state-status-line", target: harness, error: String(error), impact: "Sno segment unavailable; original output retained" })}\n`);
	}
	return user.code;
}
