/** Real coding hooks include first-use filesystem work in their configured deadline. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as codexHooks from "../../../../apps/mem-codex/src/hooks";
import * as claudeHooks from "../../../../apps/mem-claude/src/hooks";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db";
import { createMemUpdateFixture } from "../fixtures/mem-update-fixture";

const repo = resolve(import.meta.dirname, "../../../..");
type Host = "codex" | "claude";
let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;
let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
let workspace: string;
let importHost: Host | undefined;
let cliImportHost: Host | undefined;
const previousArgv = process.argv[1];
const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(async () => {
	fixture = await createMemUpdateFixture(embedder, {
		capture: { ambient: true }, recall: { sessionStart: { timeoutMs: 10_000 } },
	});
	workspace = join(fixture.profile, "deadline-repository");
	mkdirSync(workspace);
	process.env.CLAUDE_CONFIG_DIR = join(fixture.profile, "claude-config");
	importHost = undefined;
	cliImportHost = undefined;
});

afterEach(async () => {
	try {
		const host = importHost ?? cliImportHost;
		if (host) {
			const app = join(fixture.profile, `sno-mem-${host}`);
			const receipt = join(app, "import", `${createHash("sha256").update(workspace).digest("hex")}.json`);
			// A timed-out first import can finish asynchronously; do not delete its destination early.
			if (importHost) await vi.waitFor(() => expect(existsSync(receipt)).toBe(true), { timeout: 15_000, interval: 20 });
			const lock = join(app, "worker.lock");
			// A CLI that exits at timeout may have stopped before completing import or starting a worker.
			if (cliImportHost && !existsSync(receipt) && !existsSync(lock)) return;
			await vi.waitFor(() => expect(existsSync(lock)).toBe(true), { timeout: 15_000, interval: 20 });
			const pid = Number(readFileSync(lock, "utf8").split(" ")[0]);
			const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			expect(environment).toContain(`SNO_PROFILE_DIR=${fixture.profile}`);
			// Only this temporary profile's detached worker is stopped, after real import completion.
			process.kill(-pid, "SIGTERM");
			await vi.waitFor(() => {
				if (!existsSync(`/proc/${pid}/stat`)) return;
				expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ")).toBe(true);
			}, { timeout: 10_000, interval: 20 });
		}
	} finally {
		process.argv[1] = previousArgv;
		if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
		await fixture?.close();
	}
});

function notes(host: Host, count: number) {
	const directory = host === "codex" ? join(workspace, ".codex", "memories")
		: join(process.env.CLAUDE_CONFIG_DIR ?? "", "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "project-notes.md"), Array.from({ length: count }, (_, index) =>
		`## Deployment note ${index}\nThe Harbor component ${index} uses the deployment checklist stored in its engineering wiki.\n`).join("\n"));
	importHost = host;
	// The imported production handler launches its real built worker, not the Vitest executable.
	process.argv[1] = join(repo, `apps/mem-${host}/dist/cli.js`);
}

function settings(values: { ambient?: boolean; timeoutMs?: number }) {
	const path = join(fixture.profile, "settings.json");
	const document = JSON.parse(readFileSync(path, "utf8"));
	if (values.ambient !== undefined) document.capture.ambient = values.ambient;
	if (values.timeoutMs !== undefined) document.recall.sessionStart.timeoutMs = values.timeoutMs;
	writeFileSync(path, JSON.stringify(document));
}

function payload(host: Host, session: string) {
	return { session_id: session, cwd: workspace, source: "startup", hook_event_name: "SessionStart",
		transcript_path: join(fixture.profile, `${host}-empty-transcript.jsonl`) };
}

function runCli(host: Host, session: string) {
	const started = performance.now();
	return new Promise<{ code: number | null; stdout: string; stderr: string;
		wallMs: number; afterEnvelopeMs: number }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", join(repo, `apps/mem-${host}/src/cli.ts`), "session-start"], {
			cwd: repo, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx` },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		let envelopeAt: number | undefined;
		child.stdout.on("data", part => {
			stdout += part;
			if (envelopeAt !== undefined) return;
			try {
				if (JSON.parse(stdout).hookSpecificOutput?.hookEventName === "SessionStart") envelopeAt = performance.now();
			} catch { /* The pipe can split one JSON envelope into multiple chunks. */ }
		});
		child.stderr.on("data", part => { stderr += part; });
		child.once("error", reject);
		child.once("close", code => {
			const closedAt = performance.now();
			resolve({ code, stdout, stderr, wallMs: closedAt - started,
				afterEnvelopeMs: envelopeAt === undefined ? Number.POSITIVE_INFINITY : closedAt - envelopeAt });
		});
		child.stdin.end(JSON.stringify(payload(host, session)));
	});
}

describe("coding hook deadline includes first repository import", () => {
	it.each<Host>(["codex", "claude"])("%s returns within its configured startup deadline despite real first-note import", async host => {
		notes(host, 1000);
		settings({ timeoutMs: 20 });
		const started = performance.now();
		const output = await (host === "codex" ? codexHooks : claudeHooks).sessionStart(payload(host, `${host}-deadline`));
		const elapsed = performance.now() - started;
		expect(JSON.parse(output).hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(elapsed, `${host} startup took ${elapsed.toFixed(1)}ms with a configured 20ms deadline`).toBeLessThanOrEqual(100);
	});

	it.each<Host>(["codex", "claude"])("%s still injects real service memory with an adequate startup deadline", async host => {
		notes(host, 1);
		const memory = await fixture.store.store({ text: "The Harbor repository deployment owner is Jordan.", projectId: "global", category: "episodic" });
		const output = await (host === "codex" ? codexHooks : claudeHooks).sessionStart(payload(host, `${host}-positive`));
		const context = JSON.parse(output).hookSpecificOutput.additionalContext as string;
		expect(context).toContain("The Harbor repository deployment owner is Jordan.");
		expect(context).toContain(`[id:${memory.id}]`);
	});

	it.each<Host>(["codex", "claude"])("%s actual CLI closes promptly after emitting its timeout result during first-note import", async host => {
		settings({ ambient: false, timeoutMs: 20 });
		const baseline = await runCli(host, `${host}-baseline-cli`);
		expect(baseline.code, baseline.stderr).toBe(0);
		expect(JSON.parse(baseline.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
		notes(host, 1000);
		// Unlike an imported hook function, the real CLI may deliberately stop the unfinished import.
		importHost = undefined;
		cliImportHost = host;
		settings({ ambient: true, timeoutMs: 20 });
		const actual = await runCli(host, `${host}-importing-cli`);
		expect(actual.code, actual.stderr).toBe(0);
		expect(JSON.parse(actual.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
		const excess = actual.afterEnvelopeMs - baseline.afterEnvelopeMs;
		process.stderr.write(`${JSON.stringify({ codingCliDeadline: { host, node: process.version,
			entry: join(repo, `apps/mem-${host}/src/cli.ts`), timeoutMs: 20, blocks: 1000,
			baselineWallMs: baseline.wallMs, importWallMs: actual.wallMs,
			baselineAfterEnvelopeMs: baseline.afterEnvelopeMs, importAfterEnvelopeMs: actual.afterEnvelopeMs,
			excessAfterEnvelopeMs: excess } })}\n`);
		expect(excess, `${host} CLI stayed alive ${excess.toFixed(1)}ms beyond its healthy post-output baseline`).toBeLessThanOrEqual(100);
	});

	it.each<Host>(["codex", "claude"])("%s CLI emits one valid hook envelope when ambient capture is disabled", async host => {
		const memory = await fixture.store.store({ text: "The Harbor repository deployment owner is Jordan.", projectId: "global", category: "episodic" });
		settings({ ambient: false });
		const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", join(repo, `apps/mem-${host}/src/cli.ts`), "session-start"], {
				cwd: repo, env: process.env, stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "", stderr = "";
			child.stdout.on("data", part => { stdout += part; });
			child.stderr.on("data", part => { stderr += part; });
			child.once("error", reject);
			child.once("exit", code => resolve({ code, stdout, stderr }));
			child.stdin.end(JSON.stringify(payload(host, `${host}-disabled-cli`)));
		});
		expect(output.code, output.stderr).toBe(0);
		expect(() => JSON.parse(output.stdout), output.stdout).not.toThrow();
		expect(JSON.parse(output.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(JSON.parse(output.stdout).hookSpecificOutput.additionalContext).toContain(memory.text);
		expect(JSON.parse(output.stdout).hookSpecificOutput.additionalContext).toContain(`[id:${memory.id}]`);
	});
});
