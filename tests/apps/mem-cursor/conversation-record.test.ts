import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConversationRecord, cursorSurface, nextRecord, touchConversation } from "../../../apps/mem-cursor/src/conversation.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const T0 = "2026-10-10T01:00:00.000Z";
const T1 = "2026-10-10T01:02:03.000Z";

function event(overrides: Partial<Parameters<typeof nextRecord>[1]> = {}) {
	return { conversation_id: ID, model: "default", workspace_roots: ["/w/repoA", "/w/repoB"], transcript_path: null, ...overrides };
}

describe("conversation record update rules", () => {
	it("surface is cli only when the hook runs under the Cursor CLI", () => {
		expect(cursorSurface({ CURSOR_INVOKED_AS: "cursor-agent" })).toBe("cli");
		expect(cursorSurface({ CURSOR_EXTENSION_HOST_ROLE: "user", CURSOR_VERSION: "3.24.9" })).toBe("ide");
	});

	it("opens with default model, null transcript and reach address, and the given project", () => {
		const record = nextRecord(undefined, event(), "primary", "/w/repoA", T0, {});
		expect(record).toEqual({
			conversation_id: ID, surface: "ide", project: "/w/repoA", workspace_roots: ["/w/repoA", "/w/repoB"],
			model: "default", model_at: T0, transcript_path: null, reach_addr: null,
			first_seen: T0, last_event: T0, ended_at: null,
		});
	});

	it("a named model replaces any model and default/auto never replace a named one", () => {
		const opened = nextRecord(undefined, event(), "primary", "/w/repoA", T0, {});
		const named = nextRecord(opened, event({ model: "cursor-grok-4.5-high" }), "other", null, T1, {});
		expect(named).toMatchObject({ model: "cursor-grok-4.5-high", model_at: T1, last_event: T1, first_seen: T0 });
		for (const vague of ["default", "auto", "", undefined]) {
			const later = nextRecord(named, event({ model: vague }), "primary", null, "2026-10-10T02:00:00.000Z", {});
			expect(later.model).toBe("cursor-grok-4.5-high");
			expect(later.model_at).toBe(T1);
		}
		const switched = nextRecord(named, event({ model: "claude-4.5-sonnet" }), "other", null, "2026-10-10T03:00:00.000Z", {});
		expect(switched.model).toBe("claude-4.5-sonnet");
	});

	it("keeps the newest non-null transcript path, the reach address from the environment, and the first project", () => {
		const path = "/home/u/.cursor/projects/w-repoA/agent-transcripts/x/x.jsonl";
		const opened = nextRecord(undefined, event(), "primary", "/w/repoA", T0, { SNO_REACH_ADDR: "seat-7" });
		const withPath = nextRecord(opened, event({ transcript_path: path }), "other", "/elsewhere", T1, {});
		const afterNull = nextRecord(withPath, event({ transcript_path: null }), "other", null, T1, {});
		expect(afterNull).toMatchObject({ transcript_path: path, reach_addr: "seat-7", project: "/w/repoA" });
		const newer = path.replace("/x/x.jsonl", "/y/y.jsonl");
		expect(nextRecord(afterNull, event({ transcript_path: newer }), "other", null, T1, {}).transcript_path).toBe(newer);
	});

	it("sessionEnd sets ended_at and a later primary event (resume) makes the conversation live again", () => {
		const opened = nextRecord(undefined, event(), "primary", "/w/repoA", T0, {});
		const ended = nextRecord(opened, event(), "end", null, T1, {});
		expect(ended.ended_at).toBe(T1);
		expect(nextRecord(ended, event(), "other", null, T1, {}).ended_at).toBe(T1);
		expect(nextRecord(ended, event(), "primary", null, T1, {}).ended_at).toBeNull();
	});
});

describe("touchConversation on disk", () => {
	let root: string;
	let previousProfile: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mem-cursor-record-"));
		previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = join(root, "profile");
	});

	afterEach(() => {
		if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previousProfile;
		rmSync(root, { recursive: true, force: true });
	});

	const recordPath = (id: string) => join(root, "profile", "cursor", "conversations", `${id}.json`);
	const read = (id: string): ConversationRecord => JSON.parse(readFileSync(recordPath(id), "utf8"));

	it("attributes the conversation to the git root of the first workspace root", async () => {
		const repo = join(root, "repoA");
		mkdirSync(join(repo, "src"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		const other = join(root, "repoB");
		mkdirSync(other);
		await touchConversation({ conversation_id: ID, model: "default", workspace_roots: [join(repo, "src"), other], transcript_path: null }, "primary");
		expect(read(ID).project).toBe(execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
	});

	it("picks up the project when a conversation first seen without a git root later reports one", async () => {
		const repo = join(root, "repoA");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q", repo]);
		await touchConversation({ conversation_id: ID, workspace_roots: [], transcript_path: null }, "primary");
		expect(read(ID).project).toBeNull();
		await touchConversation({ conversation_id: ID, workspace_roots: [repo], transcript_path: null }, "primary");
		expect(read(ID).project).toBe(execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
	});

	it("records project null outside a git work tree", async () => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const record = await touchConversation({ conversation_id: ID, workspace_roots: [plain], transcript_path: null }, "primary");
		expect(record?.project).toBeNull();
		expect(read(ID).project).toBeNull();
	});

	it("gives no record to a conversation first seen on a non-primary event (a subagent's)", async () => {
		const subagent = "0b353f61-1111-4222-8333-944445555666";
		expect(await touchConversation({ conversation_id: subagent, model: "default", workspace_roots: [root], transcript_path: null }, "other")).toBeUndefined();
		expect(await touchConversation({ conversation_id: subagent, workspace_roots: [root], transcript_path: null }, "end")).toBeUndefined();
		expect(existsSync(recordPath(subagent))).toBe(false);
	});
});
