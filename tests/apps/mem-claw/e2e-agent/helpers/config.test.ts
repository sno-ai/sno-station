import { describe, expect, test } from "vitest";
import {
	agentE2eDeployModeArgs,
	agentE2eProfile,
	agentE2eProductMode,
	loadConfig,
	shouldClearVmDb,
} from "./config";

const envKeys = [
	"SNO_AGENT_E2E_CONFIRM_CLEAR_DB",
	"SNO_AGENT_E2E_GATEWAY_TOKEN",
	"SNO_AGENT_E2E_HOST",
	"SNO_AGENT_E2E_PORT",
	"SNO_AGENT_E2E_PROFILE",
	"SNO_AGENT_E2E_TLS_VERIFY",
	"SNO_AGENT_E2E_VM",
] as const;

describe("Agent 1:1 config", () => {
	test("pins the live Agent E2E product mode to REM Enhanced", () => {
		expect(agentE2eProfile).toBe("sno-e2e");
		expect(agentE2eProductMode).toBe("rem-enhanced");
		expect(agentE2eDeployModeArgs).toEqual(["--ensure-rem-enhanced"]);
	});

	test("allows the local VM self-signed certificate by default", async () => {
		await withEnv({}, async () => {
			const config = await loadConfig("/tmp/sno-agent-e2e-test");

			expect(config.rejectUnauthorized).toBe(false);
		});
	});

	test("does not clear the VM DB unless the exact target is confirmed", async () => {
		await withEnv({}, async () => {
			expect(shouldClearVmDb("sno-e2e", "192.0.2.10", "test-vm")).toBe(
				false,
			);
		});
		await withEnv(
			{
				SNO_AGENT_E2E_CONFIRM_CLEAR_DB:
					"clear-db:sno-e2e@192.0.2.10/test-vm",
			},
			async () => {
				expect(
					shouldClearVmDb("sno-e2e", "192.0.2.10", "test-vm"),
				).toBe(true);
			},
		);
	});

	test("loads the default OpenClaw target without reset confirmation", async () => {
		await withEnv({}, async () => {
			const config = await loadConfig("/tmp/sno-agent-e2e-test");

			expect(config.openClawProfile).toBe("sno-e2e");
		});
	});

	test("rejects any Agent E2E profile other than the pinned sno-e2e profile", async () => {
		await withEnv(
			{ SNO_AGENT_E2E_PORT: "20000", SNO_AGENT_E2E_PROFILE: "other-profile" },
			async () => {
				await expect(loadConfig("/tmp/sno-agent-e2e-test")).rejects.toThrow(
					"Agent E2E is pinned to OpenClaw profile sno-e2e",
				);
			},
		);
	});

	test("allows explicit TLS verification opt-in", async () => {
		await withEnv(
			{
				SNO_AGENT_E2E_TLS_VERIFY: "1",
			},
			async () => {
				const config = await loadConfig("/tmp/sno-agent-e2e-test");

				expect(config.rejectUnauthorized).toBe(true);
			},
		);
	});

	test("requires exact confirmation before clearing non-default profiles", async () => {
		await withEnv(
			{
				SNO_AGENT_E2E_CONFIRM_CLEAR_DB:
					"clear-db:sno-e2e@192.0.2.10/test-vm",
				SNO_AGENT_E2E_PROFILE: "other-profile",
			},
			async () => {
				expect(
					shouldClearVmDb("other-profile", "192.0.2.10", "test-vm"),
				).toBe(false);
			},
		);
	});
});

async function withEnv(
	overrides: Partial<Record<(typeof envKeys)[number], string>>,
	run: () => Promise<void>,
): Promise<void> {
	const previous = new Map(
		envKeys.map((key) => [key, process.env[key]] as const),
	);
	process.env.SNO_AGENT_E2E_GATEWAY_TOKEN = "test-token";
	delete process.env.SNO_AGENT_E2E_CONFIRM_CLEAR_DB;
	delete process.env.SNO_AGENT_E2E_HOST;
	delete process.env.SNO_AGENT_E2E_PORT;
	delete process.env.SNO_AGENT_E2E_PROFILE;
	delete process.env.SNO_AGENT_E2E_TLS_VERIFY;
	delete process.env.SNO_AGENT_E2E_VM;
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
