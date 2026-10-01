/**
 * Observe v2 (QCG-9, OpenClaw half): the registered after_tool_call handler turns a host `read`
 * of `skills/<name>/SKILL.md` into one skill.run row in the profile's observe ledger, carrying the
 * project of the agent's configured workspace even though the sidecar connection is never ready;
 * every other path and tool appends nothing. The host api is a stand-in that only records
 * handlers and carries the host config; the handler, category table, and ledger writer are real.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRuntimeHooks } from "../../../../apps/mem-claw/src/hooks/openclaw-runtime-hooks.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

type HookHandler = (event: unknown, context: unknown) => Promise<unknown>;

let root: string;
let previousProfile: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "openclaw-skill-runs-"));
	previousProfile = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = join(root, "profile");
});

afterEach(() => {
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
	rmSync(root, { recursive: true, force: true });
});

/** The after_tool_call handler as registered under `sessionStrategy: "none"`. */
function afterToolCall(): HookHandler {
	const handlers = new Map<string, HookHandler>();
	const api = {
		registerHook: () => undefined,
		logger: { info: vi.fn(), warn: vi.fn() },
		on: (name: string, handler: HookHandler) => handlers.set(name, handler),
		config: { agents: { defaults: { workspace: root } } },
	};
	const config = () => ({ sessionStrategy: "none", selfImprovement: { enabled: false } });
	registerRuntimeHooks(api as never, config as never, {} as never, {} as never, {} as never);
	const handler = handlers.get("after_tool_call");
	if (!handler) throw new Error("after_tool_call was not registered");
	return handler;
}

function skillFile(name: string): string {
	const dir = join(root, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
	return join(dir, "SKILL.md");
}

function ledgerRows(): Record<string, unknown>[] {
	const path = join(root, "profile", "observe", "ledger.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const context = { sessionId: "s1", sessionKey: "agent:main:s1" };

it("recalls a keyword near the end of a long prompt and preserves the service-rendered recall block", async () => {
	writeSettingsFixture(join(root, "profile"), { recall: { auto: true, prompt: { maxChars: 1500 } } });
	const handlers = new Map<string, HookHandler>();
	const api = { config: {}, registerHook: () => undefined, on: (name: string, handler: HookHandler) => handlers.set(name, handler) };
	const connection = {
		ready: async () => ({
			getRecall: async (query: string) => ({
				degraded: false,
				contextText: query.includes("KUROSHIO") ? `KUROSHIO is the ramen codeword. ${"x".repeat(1400)}` : "",
			}),
		}),
		scope: async () => ({ host: {} }),
	};
	const observe = {
		startObserveSession: async () => undefined,
		lookupActiveObserveSession: () => undefined,
	};
	registerRuntimeHooks(api as never, (() => ({ sessionStrategy: "none" })) as never, connection as never, observe as never, {} as never);
	const handler = handlers.get("before_prompt_build");
	if (!handler) throw new Error("before_prompt_build was not registered");
	const result = await handler(
		{ prompt: `${"Background notes for this question. ".repeat(48)}What is the KUROSHIO codeword?` },
		context,
	) as { prependContext?: string } | undefined;
	expect(result?.prependContext).toContain("KUROSHIO is the ramen codeword.");
	expect(result?.prependContext).toBe(`KUROSHIO is the ramen codeword. ${"x".repeat(1400)}`);
});

describe("OpenClaw after_tool_call skill runs", () => {
	it("a read of a skill's SKILL.md appends one skill.run row without memoryReflection", async () => {
		await afterToolCall()(
			{ toolName: "read", params: { path: skillFile("rem-reflect") }, durationMs: 1234.6 },
			context,
		);
		const rows = ledgerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			ts_ms: expect.any(Number),
			event_type: "skill.run",
			// No remote: the rule hashes the lowercased absolute workspace path.
			project_id: `p_${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16)}`,
			lane: "skill",
			payload: {
				harness: "openclaw",
				skill_name: "rem-reflect",
				skill_version: "local",
				category: "R",
				duration_ms: 1235,
				outcome: "ok",
			},
		});
	});

	it("a failed read of a SKILL.md is recorded as a failed run", async () => {
		await afterToolCall()(
			{ toolName: "read", params: { path: skillFile("rem-reflect") }, durationMs: 12, error: "EACCES" },
			context,
		);
		expect(ledgerRows().map((row) => (row.payload as { outcome: string }).outcome)).toEqual(["fail"]);
	});

	it("other tools and reads of other files append nothing", async () => {
		const handler = afterToolCall();
		skillFile("rem-reflect");
		const notes = join(root, "skills", "rem-reflect", "notes.md");
		writeFileSync(notes, "notes\n");
		await handler({ toolName: "web_search", params: { query: "rem-reflect" }, durationMs: 5 }, context);
		await handler({ toolName: "read", params: { path: notes }, durationMs: 5 }, context);
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "SKILL.md"), "---\nname: docs\n---\n");
		mkdirSync(join(root, "skills", "a", "b"), { recursive: true });
		writeFileSync(join(root, "skills", "a", "b", "SKILL.md"), "---\nname: b\n---\n");
		await handler({ toolName: "read", params: { path: join(root, "docs", "SKILL.md") }, durationMs: 5 }, context);
		await handler({ toolName: "read", params: { path: join(root, "skills", "a", "b", "SKILL.md") }, durationMs: 5 }, context);
		expect(ledgerRows()).toEqual([]);
	});
});
