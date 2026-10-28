import { CODING_SKIN_CAPTURE_MAX_INPUT_TOKENS } from "@snoai/memory/coding-skin";
import { describe, expect, it } from "vitest";
import { nextCapture } from "../../../apps/mem-claude/src/worker.js";

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
