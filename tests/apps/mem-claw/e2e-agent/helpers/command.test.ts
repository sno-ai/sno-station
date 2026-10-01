import { describe, expect, test } from "vitest";
import { runCommand } from "./command";

describe("Agent 1:1 command helper", () => {
	test("waits for a timed-out child process to exit", async () => {
		const startedAt = Date.now();

		await expect(
			runCommand(
				process.execPath,
				[
					"-e",
					"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
				],
				{ timeoutMs: 50 },
			),
		).rejects.toThrow("timed out");

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
	});
});
