/**
 * Cursor hooks against a real sidecar (local-first, the machine's embedding model cache): the conversation-start
 * brief, the first-prompt fallback for an IDE chat that had no sessionStart, the brief coming back after compaction,
 * and an IDE turn captured by the real detached worker and found again by recall.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, type MemoryClient } from "../../../packages/memory/src/contract/client";
import { startRemSidecar } from "../../../packages/memory/src/sidecar/server";
import { afterAgentResponse, preCompact, sessionStart, stop, userPromptSubmit } from "../../../apps/mem-cursor/src/hooks.ts";
import { createTestDb } from "../mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");
const FACT = "Release builds are cut from the main branch every Tuesday at 10:00 Pacific.";

let root: string;
let repo: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
let client: MemoryClient;
const saved = { profile: process.env.SNO_PROFILE_DIR, invokedAs: process.env.CURSOR_INVOKED_AS, entry: process.argv[1] };

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "mem-cursor-inject-"));
	mkdirSync(join(root, "billing-service"));
	execFileSync("git", ["init", "-q", join(root, "billing-service")]);
	repo = execFileSync("git", ["-C", join(root, "billing-service"), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	writeSettingsFixture(root, { mode: "local-first", rerank: { mode: "none" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey }, embedding: { cacheDir: MODEL_CACHE } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	sidecar = await startRemSidecar();
	const connected = await connect({ skinId: "cursor" });
	if (connected.degraded) throw new Error(connected.reason);
	client = connected;
	const scope = { principal: "caller", project: repo, session: "manual", host: { sessionId: "manual", workspace: repo } };
	await client.init(scope, { skinId: "cursor" });
	const stored = await client.mutate({ op: "store", content: FACT, category: "episodic" }, scope);
	if (stored.degraded || stored.result.isError) throw new Error("seed memory not stored");
}, 120_000);

afterAll(async () => {
	const lock = join(root, "sno-mem-cursor", "worker.lock");
	if (existsSync(lock)) {
		const pid = Number(readFileSync(lock, "utf8").split(" ")[0]);
		try { process.kill(pid); } catch { /* already gone */ }
	}
	await sidecar?.stop();
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (saved.profile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = saved.profile;
	if (saved.invokedAs === undefined) delete process.env.CURSOR_INVOKED_AS;
	else process.env.CURSOR_INVOKED_AS = saved.invokedAs;
	process.argv[1] = saved.entry ?? "";
});

const input = (conversation: string, generation: string, roots = [repo]) => ({
	conversation_id: conversation, session_id: conversation, generation_id: generation, model: "default",
	cursor_version: "2026.10.01-e373342", workspace_roots: roots, transcript_path: null,
});
const context = (answer: string): string => (JSON.parse(answer) as { additional_context?: string }).additional_context ?? "";

describe("Cursor injection against a real sidecar", () => {
	it("CLI: brief at start, a relevant prompt does not repeat it, compaction brings it back once", async () => {
		process.env.CURSOR_INVOKED_AS = "cursor-agent";
		const id = "15104767-7c90-4efa-abab-ddea828901cc";
		const question = "When are release builds cut from the main branch?";
		const brief = context(await sessionStart(input(id, id)));
		expect(brief).toContain(FACT);
		expect(await userPromptSubmit({ ...input(id, "g1"), prompt: question })).toBe("{}");
		expect(await preCompact({ ...input(id, "g2"), trigger: "manual", context_tokens: 14869 })).toBe("{}");
		expect(context(await userPromptSubmit({ ...input(id, "g3"), prompt: question }))).toContain(FACT);
		expect(await userPromptSubmit({ ...input(id, "g4"), prompt: question })).toBe("{}");
	}, 60_000);

	it("control: the per-prompt recall for that question finds the fact in a fresh session", async () => {
		const recalled = await client.getRecall("When are release builds cut from the main branch?", { principal: "caller", project: repo,
			session: "control-fresh", host: { sessionId: "control-fresh", workspace: repo } }, { source: "auto", injectionPhase: "prompt" });
		expect(recalled.degraded ? "" : recalled.contextText).toContain(FACT);
	}, 60_000);

	it("IDE first chat of a window (no sessionStart): the first prompt carries the brief, the next does not", async () => {
		delete process.env.CURSOR_INVOKED_AS;
		const id = "57f21e8c-0ee9-4a8d-ab08-26157e000989";
		expect(context(await userPromptSubmit({ ...input(id, "g1"), prompt: "Hi" }))).toContain(FACT);
		expect(await userPromptSubmit({ ...input(id, "g2"), prompt: "Hi again" })).toBe("{}");
	}, 60_000);

	it("outside a git repository nothing is injected", async () => {
		const plain = join(root, "plain");
		mkdirSync(plain, { recursive: true });
		expect(await sessionStart(input("7add2559-e89a-409e-bd8c-35faf464b60c", "g", [plain]))).toBe("{}");
	}, 60_000);

	it("IDE: a completed turn is captured by the real worker and recalled", async () => {
		delete process.env.CURSOR_INVOKED_AS;
		// The worker is started as `<entry> worker`: point the entry at the built command, as Cursor's hook would run it.
		process.argv[1] = join(repoRoot, "apps/mem-cursor/dist/cli.js");
		const id = "f9f06d13-6295-44e4-9c0b-7e9d0a842455";
		const decision = "Invoices in the billing service always round half-even to the cent.";
		await userPromptSubmit({ ...input(id, "g1"), prompt: `Decision for this repo: ${decision}` });
		await afterAgentResponse({ ...input(id, "g1"), text: `Recorded. ${decision}` });
		expect(await stop({ ...input(id, "g1"), status: "completed", loop_count: 0 })).toBe("{}");
		const spool = join(root, "sno-mem-cursor", "spool");
		await vi.waitFor(() => expect(readdirSync(spool)).toEqual([]), { timeout: 60_000, interval: 500 });
		const recalled = await client.getRecall("how are invoices rounded", { principal: "caller", project: repo, session: "manual",
			host: { sessionId: "manual", workspace: repo } }, { source: "manual", limit: 5 });
		expect(recalled.degraded ? "" : recalled.contextText).toContain("half-even");
	}, 90_000);
});
