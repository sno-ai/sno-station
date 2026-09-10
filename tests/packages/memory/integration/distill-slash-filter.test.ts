/**
 * Integration tests for the slash-command noise filter in jsonl_distill.py.
 *
 * Tests the `_is_noise()` function's slash-command filtering via the full
 * Python script using real subprocess calls. No mocking.
 *
 * Spec: openspec/changes/mem-claw-catchup/specs/distill-slash-filter/spec.md
 *   - 7 scenarios covering slash filtering, whitespace handling, mid-sentence
 *     slash preservation, normal passthrough, mixed input counts, and empty input.
 */

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(
	TEST_DIR,
	"..",
	"..",
	"..",
	"..",
	"apps",
	"mem-claw",
	"scripts",
	"jsonl_distill.py",
);

/** Build a JSONL message line matching OpenClaw session format. */
function makeMessage(role: string, text: string, ts: number): string {
	return JSON.stringify({
		type: "message",
		timestamp: ts,
		message: {
			role,
			content: [{ type: "text", text }],
		},
	});
}

function appendMessages(sessionPath: string, messages: string[]): void {
	appendFileSync(sessionPath, `${messages.join("\n")}\n`, "utf-8");
}

/** Run jsonl_distill.py with given args. Asserts exit code 0, returns parsed JSON stdout. */
function runScript(args: string[]): Record<string, unknown> {
	const run = spawnSync("python3", [scriptPath, ...args], {
		encoding: "utf-8",
		env: {
			...process.env,
			OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS: "*",
		},
	});
	if (run.status !== 0) {
		throw new Error(
			`jsonl_distill.py exited with code ${run.status}: ${run.stderr || run.stdout}`,
		);
	}
	return JSON.parse(run.stdout.trim()) as Record<string, unknown>;
}

/** Scaffold a work directory with state-dir, agents-dir, and a session file. Returns paths. */
function scaffold(workDir: string): {
	stateDir: string;
	agentsDir: string;
	sessionPath: string;
} {
	const stateDir = join(workDir, "state");
	const agentsDir = join(workDir, "agents");
	const sessionsDir = join(agentsDir, "main", "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	const sessionPath = join(sessionsDir, "session-1.jsonl");
	writeFileSync(sessionPath, "");

	return { stateDir, agentsDir, sessionPath };
}

/** Extract text array from batch for the first (main) agent. */
function extractTexts(batch: Record<string, unknown>): string[] {
	const agents = batch.agents as Array<{ agentId: string; messages: Array<{ text: string }> }>;
	const mainAgent = agents.find((a) => a.agentId === "main");
	if (!mainAgent) return [];
	return mainAgent.messages.map((m) => m.text);
}

function requireBatch(batch: Record<string, unknown> | null): Record<string, unknown> {
	expect(batch).not.toBeNull();
	if (batch === null) {
		throw new Error("expected distill batch");
	}
	return batch;
}

/** Run the script with "run" sub-command only (init already done). */
function initAndRunFromState(
	stateDir: string,
	agentsDir: string,
	extraArgs: string[] = [],
): {
	result: Record<string, unknown>;
	batch: Record<string, unknown> | null;
} {
	const result = runScript([
		"--state-dir",
		stateDir,
		"--agents-dir",
		agentsDir,
		"run",
		...extraArgs,
	]);
	expect(result.ok).toBe(true);

	let batch: Record<string, unknown> | null = null;
	if (result.action === "created" && typeof result.batchFile === "string") {
		batch = JSON.parse(readFileSync(result.batchFile, "utf-8")) as Record<string, unknown>;
	}

	return { result, batch };
}

describe("jsonl_distill slash-command filtering", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "distill-slash-filter-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	// ── Scenario 1: Slash command filtered ───────────────────────────

	it("filters /note slash command from output", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		const initResult = runScript([
			"--state-dir",
			stateDir,
			"--agents-dir",
			agentsDir,
			"init",
		]);
		expect(initResult.ok).toBe(true);

		appendMessages(sessionPath, [
			makeMessage(
				"user",
				"/note self-improvement (before reset): write summary",
				1,
			),
			makeMessage("assistant", "Here is a normal reply about summaries.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		// The /note line must be excluded; only the assistant reply remains
		expect(texts).toHaveLength(1);
		expect(texts[0]).toBe("Here is a normal reply about summaries.");
		expect(texts.every((t) => !t.trimStart().startsWith("/"))).toBe(true);
	});

	// ── Scenario 2: Sno Memory slash command filtered ────────────────────

	it("filters /memory slash command from output", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		appendMessages(sessionPath, [
			makeMessage("user", "/memory search typescript", 1),
			makeMessage("assistant", "TypeScript is a typed superset of JavaScript.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		expect(texts).toHaveLength(1);
		expect(texts[0]).toBe("TypeScript is a typed superset of JavaScript.");
	});

	// ── Scenario 3: Leading whitespace slash command filtered ────────

	it("filters slash command with leading whitespace", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		appendMessages(sessionPath, [
			makeMessage("user", "   /note remember this for later", 1),
			makeMessage("assistant", "Acknowledged, I will remember.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		expect(texts).toHaveLength(1);
		expect(texts[0]).toBe("Acknowledged, I will remember.");
	});

	// ── Scenario 4: Mid-sentence slash preserved ─────────────────────

	it("preserves mid-sentence slash (not at line start)", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		appendMessages(sessionPath, [
			makeMessage("user", "The path /home/user/file.txt is wrong", 1),
			makeMessage("assistant", "I see the issue with that file path.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		// Both messages pass through — the slash is mid-sentence
		expect(texts).toHaveLength(2);
		expect(texts).toContain("The path /home/user/file.txt is wrong");
		expect(texts).toContain("I see the issue with that file path.");
	});

	// ── Scenario 5: Normal user message passes through ───────────────

	it("passes through normal user message without slash", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		appendMessages(sessionPath, [
			makeMessage("user", "Please keep tests concise", 1),
			makeMessage("assistant", "Understood. I will keep tests focused.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe("Please keep tests concise");
		expect(texts[1]).toBe("Understood. I will keep tests focused.");
	});

	// ── Scenario 6: Mixed input produces correct output count ────────

	it("mixed input: 3 slash-command lines + 2 normal lines → 2 entries", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		appendMessages(sessionPath, [
			makeMessage("user", "/note self-improvement: be more concise", 1),
			makeMessage("user", "/memory search recent topics", 2),
			makeMessage("user", "   /note whitespace-leading slash command", 3),
			makeMessage("user", "Please keep my preferred test style as concise.", 4),
			makeMessage("assistant", "Understood. I will keep tests focused and concise.", 5),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		const texts = extractTexts(requireBatch(batch));
		// 3 slash-command lines filtered, 2 normal lines pass through
		expect(texts).toHaveLength(2);
		expect(texts).toEqual([
			"Please keep my preferred test style as concise.",
			"Understood. I will keep tests focused and concise.",
		]);
	});

	// ── Scenario 7: Empty input produces empty output ────────────────

	it("empty session file produces no batch (noop)", () => {
		const { stateDir, agentsDir } = scaffold(workDir);
		// Session file is empty (created by scaffold with writeFileSync "")
		runScript(["--state-dir", stateDir, "--agents-dir", agentsDir, "init"]);

		const result = runScript([
			"--state-dir",
			stateDir,
			"--agents-dir",
			agentsDir,
			"run",
		]);
		expect(result.ok).toBe(true);
		// No new data → action is "noop", no batchFile
		expect(result.action).toBe("noop");
		expect(result.batchFile).toBeUndefined();
	});

	it("captures existing messages from a newly discovered session on first run", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		appendMessages(sessionPath, [
			makeMessage("user", "Remember that new sessions must not skip first messages.", 1),
			makeMessage("assistant", "I will capture the first messages.", 2),
		]);

		const { result, batch } = initAndRunFromState(stateDir, agentsDir);
		expect(result.action).toBe("created");

		expect(extractTexts(requireBatch(batch))).toEqual([
			"Remember that new sessions must not skip first messages.",
			"I will capture the first messages.",
		]);
	});

	it("does not commit messages trimmed by the per-agent cap", () => {
		const { stateDir, agentsDir, sessionPath } = scaffold(workDir);
		appendMessages(sessionPath, [
			makeMessage("user", "first valid memory", 1),
			makeMessage("assistant", "second valid memory", 2),
			makeMessage("user", "third valid memory", 3),
		]);

		const firstRun = initAndRunFromState(stateDir, agentsDir, [
			"--max-messages-per-agent",
			"2",
		]);
		expect(extractTexts(requireBatch(firstRun.batch))).toEqual([
			"first valid memory",
			"second valid memory",
		]);
		expect(typeof firstRun.result.batchFile).toBe("string");

		const commitResult = runScript([
			"--state-dir",
			stateDir,
			"--agents-dir",
			agentsDir,
			"commit",
			"--batch-file",
			String(firstRun.result.batchFile),
		]);
		expect(commitResult.ok).toBe(true);

		const secondRun = initAndRunFromState(stateDir, agentsDir, [
			"--max-messages-per-agent",
			"2",
		]);
		expect(extractTexts(requireBatch(secondRun.batch))).toEqual(["third valid memory"]);
	});
});
