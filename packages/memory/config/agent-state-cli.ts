#!/usr/bin/env node
import { execFile } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { promisify } from "node:util";
import { compactAgentView, markAgentResultSeen, readAgentView, type AgentView } from "./agent-state";

const execute = promisify(execFile);

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

function renderAgentSnapshot(view: AgentView, selected = -1): string {
	const lines = [`Sno Station · squad · ${view.observedAt}`, ""];
	for (const group of ["Needs you", "Working", "Finished", "unknown"]) {
		lines.push(group === "unknown" ? "Unknown observations" : group);
		for (const row of view.agents.filter(row => row.group === group)) {
			const index = view.agents.indexOf(row);
			lines.push(`${index === selected ? ">" : " "} ${row.harness} ${row.sessionId} · ${row.subgroup} · ${row.ageSeconds}s ago`,
				`  Doing: ${row.doing} · Process: ${row.process} · Resumable: ${row.resumable} · Waiting for a human: ${row.waitingForHuman}`,
				`  Reason: ${row.waitingReason} · Reach: ${row.reachAddress} · Project: ${row.cwd} · Task: ${row.description}`,
				`  Work: ${JSON.stringify(row.work)} · Delivery: ${row.delivery} · Resume: ${row.resumeEvidence}`,
				`  Result: ${row.resultId} · Seen: ${row.humanSeen} · Last event: ${JSON.stringify(row.lastEvent)}`);
			if (row.missingReasons.length) lines.push(`  Missing: ${row.missingReasons.join("; ")}`);
		}
		lines.push("");
	}
	if (!view.agents.length) lines.push("No observed agents.");
	lines.push("Quota", ...(view.quota.length ? view.quota.map(item => JSON.stringify(item)) : ["unknown · no account observation"]));
	if (view.errors.length) lines.push("Operation errors", ...view.errors.map(error => `${error.operation}: ${error.target}: ${error.error} (${error.impact})`));
	return lines.join("\n");
}

/** Explicit account read only; local snapshots and status redraw never invoke this. */
async function refreshAgentQuota(view: AgentView): Promise<void> {
	let output: string;
	let code = 0;
	try {
		output = (await execute("sno", ["subscription-quota-check", "--vendor", "both", "--json", "--quiet"])).stdout;
	} catch (error) {
		const failed = error instanceof Error ? error : new Error(String(error));
		output = "stdout" in failed && typeof failed.stdout === "string" ? failed.stdout : "";
		code = "code" in failed && typeof failed.code === "number" ? failed.code : -1;
		view.errors.push({ operation: "read account quota", target: "subscription-quota-check", error: failed.message, impact: "unavailable account quota remains unknown" });
	}
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object" || !("vendors" in parsed) || !Array.isArray(parsed.vendors)) throw new Error("quota reader returned no vendor observations");
		const observedAt = "captured_at" in parsed ? parsed.captured_at : "unknown";
		view.quota = parsed.vendors.map((vendor: unknown) => ({ observation: vendor, source: "subscription-quota-check", observedAt, exitCode: code }));
	} catch (error) {
		view.errors.push({ operation: "parse account quota", target: "subscription-quota-check", error: String(error), impact: "quota unknown" });
	}
}

async function screen(): Promise<number> {
	let view = await readAgentView();
	let selected = 0;
	let result = "";
	const wasRaw = process.stdin.isRaw;
	const draw = (): void => {
		process.stdout.write(`\x1b[H\x1b[2J${renderAgentSnapshot(view, selected)}\n${result}\n↑/↓ select · Enter open result · r refresh quota · Space refresh · q/Escape exit\n`);
	};
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true); process.stdin.resume(); draw();
	try {
		await new Promise<void>(resolve => {
			const close = (): void => { process.stdin.off("keypress", keypress); process.off("SIGTERM", close); process.off("SIGINT", close); resolve(); };
			const keypress = async (value: string, key: { name?: string; ctrl?: boolean }): Promise<void> => {
				if (value === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) { close(); return; }
				try {
					if (key.name === "down" || value === "j") selected = Math.min(view.agents.length - 1, selected + 1);
					else if (key.name === "up" || value === "k") selected = Math.max(0, selected - 1);
					else if (key.name === "return") {
						const row = view.agents[selected];
						if (row) { result = row.finalReply; await markAgentResultSeen(row); view = await readAgentView(); }
					} else if (value === "r") await refreshAgentQuota(view);
					else if (value === " ") { const quota = view.quota; view = await readAgentView(); view.quota = quota; }
					draw();
				} catch (error) { result = `refresh failed: ${String(error)}`; draw(); }
			};
			process.stdin.on("keypress", keypress); process.on("SIGTERM", close); process.on("SIGINT", close);
		});
	} finally {
		process.stdin.setRawMode(wasRaw ?? false); process.stdin.pause();
		process.stdout.write("\x1b[?25h\x1b[?1049l");
	}
	return 0;
}

async function agentStateMain(args: string[]): Promise<number> {
	if (args.includes("--help")) { process.stdout.write("sno squad [global --json] · local squad observations\n"); return 0; }
	if (!args.includes("--json") && !args.includes("--compact") && process.stdout.isTTY && process.stdin.isTTY) return screen();
	const view = await readAgentView();
	if (args.includes("--json")) process.stdout.write(`${JSON.stringify(view)}\n`);
	else if (args.includes("--compact")) process.stdout.write(`${compactAgentView(view, {
		harness: option(args, "--harness"), sessionId: option(args, "--session-id"), reachAddress: option(args, "--reach-address"),
	})}\n`);
	else process.stdout.write(`${renderAgentSnapshot(view)}\n`);
	return 0;
}

agentStateMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
	process.stderr.write(`${JSON.stringify({ operation: "read agent inventory", error: String(error), impact: "squad unavailable" })}\n`);
	process.exitCode = 1;
});
