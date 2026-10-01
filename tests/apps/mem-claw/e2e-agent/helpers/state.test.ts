import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readObserveOriginalConsentLevel, saveAgentRunState } from "./state";
import type { AgentRunState } from "./types";

const envKeys = ["SNO_AGENT_E2E_RUN_ID", "SNO_AGENT_E2E_STATE_FILE"] as const;

describe("Agent 1:1 state helper", () => {
	test("keeps the original Observe consent target recoverable if state is corrupt", async () => {
		const root = await mkdtemp(join(tmpdir(), "sno-agent-state-test-"));
		const statePath = join(root, "state.json");
		const state: AgentRunState = {
			artifactDir: join(root, "artifacts"),
			fact: "fact",
			nonce: "018f0000-0000-7000-8000-000000000000",
			observeOriginalConsentLevel: "off",
			qaSession: "018f0000-0000-7000-8000-000000000001",
			runId: "state-test-run",
			startedAt: new Date().toISOString(),
			teachSession: "018f0000-0000-7000-8000-000000000002",
			userCuid: "ck-state-test",
		};

		await withEnv(
			{
				SNO_AGENT_E2E_RUN_ID: state.runId,
				SNO_AGENT_E2E_STATE_FILE: statePath,
			},
			async () => {
				await saveAgentRunState(state);
				await expect(
					readFile(`${statePath}.observe-original-consent.json`, "utf8"),
				).resolves.toContain('"level": "off"');

				await writeFile(statePath, "{");

				await expect(readObserveOriginalConsentLevel()).resolves.toBe("off");
			},
		);
	});
});

async function withEnv(
	overrides: Record<(typeof envKeys)[number], string>,
	run: () => Promise<void>,
): Promise<void> {
	const previous = new Map(
		envKeys.map((key) => [key, process.env[key]] as const),
	);
	Object.assign(process.env, overrides);
	try {
		await run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}
