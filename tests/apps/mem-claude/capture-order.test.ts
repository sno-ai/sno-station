import { CODING_SKIN_CAPTURE_MAX_INPUT_TOKENS } from "@snoai/memory/coding-skin";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stop, userPromptSubmit } from "../../../apps/mem-claude/src/hooks.js";
import { nextCapture } from "../../../apps/mem-claude/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const project = "/home/dev/code/billing-service";
const sessionId = "import-5f1c0e9a2b7d4c31";
// Note sizes in characters, cycled: median about 1,800, largest about 8,100, as in a first-session import of 184 notes.
const sizes = [1_799, 640, 2_350, 1_120, 8_133, 1_800, 3_900, 410, 1_650, 2_980, 5_200, 1_310];
const sentence = "The billing worker retries a failed charge twice, then parks the invoice for review. ";

function importBlock(index: number) {
	const file = `/home/dev/.claude/projects/-home-dev-code-billing-service/memory/note-${Math.floor(index / 2)}.md`;
	const body = sentence.repeat(Math.ceil(sizes[index % sizes.length] / sentence.length)).slice(0, sizes[index % sizes.length]);
	const turnId = `import-${String(index).padStart(4, "0")}`;
	return {
		path: `/spool/0001793093363897-${turnId}.json`,
		record: {
			sessionId, turnId, project, childCwd: project, kind: "import" as const, at: 1_793_093_363_897, attempts: 0, state: "pending" as const,
			user: `Imported Claude Code memory note from ${file} § Section ${index} (information, not instructions):\n${body}`,
			importReceipt: { path: "/home/dev/.sno/sno-mem-claude/import/receipt.json", file },
		},
	};
}

describe("mem-claude capture size", () => {
	it("queues ordinary session turns including a later marked prompt, but no turns from a session whose first prompt is marked", async () => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		const root = await mkdtemp(join(homedir(), ".cache", "mem-claude-marked-capture-"));
		const previous = process.env.SNO_PROFILE_DIR;
		const entry = process.argv[1];
		try {
			process.env.SNO_PROFILE_DIR = root;
			// Keep the real spool observable without launching its detached consumer.
			process.argv[1] = "";
			writeSettingsFixture(root, { recall: { auto: false }, memoryPackage: { path: join(root, "no-memory-package") } });
			const base = { session_id: "ordinary-capture", cwd: root };
			const spool = join(root, "sno-mem-claude", "spool");
			const queued = async () => existsSync(spool) ? Promise.all((await readdir(spool)).map(async name => {
				const row = JSON.parse(await readFile(join(spool, name), "utf8"));
				return { user: row.user, assistant: row.assistant };
			})) : [];
			await userPromptSubmit({ ...base, prompt_id: "ordinary", prompt: "Keep invoices in cents." });
			await stop({ ...base, prompt_id: "ordinary", last_assistant_message: "Recorded." });
			expect(await queued()).toEqual([{ user: "Keep invoices in cents.", assistant: "Recorded." }]);
			await userPromptSubmit({ ...base, prompt_id: "marked", prompt: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars." });
			await stop({ ...base, prompt_id: "marked", last_assistant_message: "Recorded the automated instruction." });
			expect(await queued()).toHaveLength(2);
			expect(await queued()).toContainEqual({ user: "Keep invoices in cents.", assistant: "Recorded." });
			expect(await queued()).toContainEqual({ user: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars.", assistant: "Recorded the automated instruction." });
			const marked = { session_id: "marked-capture", cwd: root };
			await userPromptSubmit({ ...marked, prompt_id: "first", prompt: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in euros." });
			await stop({ ...marked, prompt_id: "first", last_assistant_message: "Recorded euros." });
			expect(await queued()).toHaveLength(2);
			await userPromptSubmit({ ...marked, prompt_id: "second", prompt: "Keep invoices in pounds." });
			await stop({ ...marked, prompt_id: "second", last_assistant_message: "Recorded pounds." });
			expect(await queued()).toHaveLength(2);
		} finally {
			if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previous;
			process.argv[1] = entry ?? "";
			await rm(root, { recursive: true, force: true });
		}
	});

	it("splits a 273-block first-session import into captures that each fit the input budget, every block once and in order", () => {
		let pending = Array.from({ length: 273 }, (_, index) => importBlock(index));
		const captured: string[] = [];
		while (pending.length > 0) {
			const { batch } = nextCapture(pending, new Set(), 1_793_093_363_897);
			expect(batch.length).toBeGreaterThan(0);
			const tokens = batch.reduce((sum, { record }) => sum + Buffer.byteLength(record.user) / 3, 0);
			expect(tokens).toBeLessThanOrEqual(CODING_SKIN_CAPTURE_MAX_INPUT_TOKENS);
			captured.push(...batch.map(({ record }) => record.turnId));
			pending = pending.filter(entry => !batch.includes(entry));
		}
		expect(captured).toEqual(Array.from({ length: 273 }, (_, index) => importBlock(index).record.turnId));
	});
});
