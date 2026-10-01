import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createUUIDv7 } from "../../../../../packages/common-core/src/index.ts";
import type { TestConfig } from "./types";

const helperDir = dirname(fileURLToPath(import.meta.url));
export const e2eAgentDir = resolve(helperDir, "..");
export const repoRoot = resolve(e2eAgentDir, "../../../..");
export const deployScript = process.env.SNO_AGENT_E2E_DEPLOY_SCRIPT ?? "";
export const agentE2eProductMode = "rem-enhanced" as const;
export const agentE2eDeployModeArgs = ["--ensure-rem-enhanced"] as const;
export const agentE2eProfile = "sno-e2e" as const;

export function assertLiveAgentE2EEnabled(): void {
	if (process.env.SNO_AGENT_E2E !== "1") {
		throw new Error(
			"Agent 1:1 tests are live. Use `npm run test:e2e:agent` from apps/mem-claw.",
		);
	}
}

export async function loadConfig(artifactDir?: string): Promise<TestConfig> {
	const requestedProfile = process.env.SNO_AGENT_E2E_PROFILE ?? agentE2eProfile;
	if (requestedProfile !== agentE2eProfile) {
		throw new Error(`Agent E2E is pinned to OpenClaw profile ${agentE2eProfile}`);
	}
	const openClawProfile = agentE2eProfile;
	const openClawVm = process.env.SNO_AGENT_E2E_VM ?? "localhost";
	const openClawHost = process.env.SNO_AGENT_E2E_HOST ?? "127.0.0.1";
	const port = process.env.SNO_AGENT_E2E_PORT ?? "19789";
	const gatewayUrl =
		process.env.SNO_AGENT_E2E_GATEWAY_URL ?? `https://${openClawHost}:${port}`;
	const remoteStateDir =
		process.env.SNO_AGENT_E2E_REMOTE_STATE_DIR ??
		join(homedir(), `.openclaw-${openClawProfile}`);
	const remoteDataDir =
		process.env.SNO_AGENT_E2E_REMOTE_DATA_DIR ??
		join(homedir(), ".snoai/sno-station/mem-claw/data");
	const openClawToken =
		process.env.SNO_AGENT_E2E_GATEWAY_TOKEN ?? process.env.OPENCLAW_TOKEN;

	if (!openClawToken) {
		throw new Error(
			"Missing OpenClaw Gateway token. Set SNO_AGENT_E2E_GATEWAY_TOKEN or OPENCLAW_TOKEN.",
		);
	}

	return {
		artifactDir:
			artifactDir ??
			process.env.SNO_AGENT_E2E_ARTIFACT_DIR ??
			join(tmpdir(), "sno-agent-e2e", `${Date.now()}-${createUUIDv7()}`),
		gatewayModel: process.env.SNO_AGENT_E2E_MODEL ?? "openclaw",
		gatewayTimeoutMs: numberEnv("SNO_AGENT_E2E_GATEWAY_TIMEOUT_MS", 120_000),
		gatewayUrl: gatewayUrl.replace(/\/$/, ""),
		observeBaseUrl: (
			process.env.SNO_OBSERVE_BASE_URL ?? "https://www.sno.ai"
		).replace(/\/$/, ""),
		observePollMs: numberEnv("SNO_AGENT_E2E_OBSERVE_POLL_MS", 5_000),
		observeTimeoutMs: numberEnv("SNO_AGENT_E2E_OBSERVE_TIMEOUT_MS", 120_000),
		openClawHost,
		openClawProfile,
		openClawToken,
		openClawVm,
		rejectUnauthorized: process.env.SNO_AGENT_E2E_TLS_VERIFY === "1",
		// The sidecar owns the audit log; the plugin data dir copy stopped moving on 2026-09-19.
		remoteAuditPath:
			process.env.SNO_AGENT_E2E_REMOTE_AUDIT_PATH ??
			join(homedir(), `.sno-${openClawProfile}/sno-station-mem/audit.jsonl`),
		remoteDbPath:
			process.env.SNO_AGENT_E2E_REMOTE_DB_PATH ??
			`${remoteDataDir}/mem-claw.sqlite`,
		remoteIdentityPath:
			process.env.SNO_AGENT_E2E_REMOTE_SNO_IDENTITY_PATH ??
			join(homedir(), `.sno-${openClawProfile}/identity.json`),
		remoteStateDir,
	};
}

export function numberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function shouldClearVmDb(
	profile: string,
	host: string,
	vm: string,
): boolean {
	const expected = `clear-db:${profile}@${host}/${vm}`;
	return process.env.SNO_AGENT_E2E_CONFIRM_CLEAR_DB === expected;
}
