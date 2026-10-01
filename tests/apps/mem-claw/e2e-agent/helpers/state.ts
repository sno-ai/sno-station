import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	createCuid2,
	createUUIDv7,
} from "../../../../../packages/common-core/src/index.ts";
import { loadConfig } from "./config";
import { isRecord, parseJson, serialize } from "./json";
import type { AgentRunState, TestConfig } from "./types";

export async function createAgentRunState(): Promise<{
	config: TestConfig;
	state: AgentRunState;
}> {
	const config = await loadConfig();
	const nonce = createUUIDv7();
	const runId = currentRunId();
	const projectName = `Project Prism ${runId}`;
	const state: AgentRunState = {
		artifactDir: config.artifactDir,
		fact: `For ${projectName}, the saved handoff code is ${nonce} and the status color is cerulean-blue.`,
		nonce,
		qaSession: createUUIDv7(),
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		runId,
		teachSession: createUUIDv7(),
		userCuid: createCuid2(),
	};
	await saveAgentRunState(state);
	return { config, state };
}

export async function loadAgentRun(): Promise<{
	config: TestConfig;
	state: AgentRunState;
}> {
	const state = await readAgentRunState();
	return {
		config: await loadConfig(state.artifactDir),
		state,
	};
}

export async function saveAgentRunState(state: AgentRunState): Promise<void> {
	await mkdir(state.artifactDir, { recursive: true });
	const serialized = serialize(state);
	await atomicWriteFile(stateFilePath(), serialized);
	await atomicWriteFile(join(state.artifactDir, "run-state.json"), serialized);
	if (state.observeOriginalConsentLevel) {
		await saveObserveOriginalConsentLevel(state);
	}
}

export async function readObserveOriginalConsentLevel(): Promise<
	AgentRunState["observeOriginalConsentLevel"]
> {
	const sidecar = await readObserveOriginalConsentFile(originalConsentPath());
	if (sidecar) {
		return sidecar.level;
	}
	const state = await readAgentRunState();
	return state.observeOriginalConsentLevel;
}

function stateFilePath(): string {
	const path = process.env.SNO_AGENT_E2E_STATE_FILE;
	if (!path) {
		throw new Error(
			"Agent 1:1 phases require SNO_AGENT_E2E_STATE_FILE. Use npm run test:e2e:agent.",
		);
	}
	return path;
}

async function saveObserveOriginalConsentLevel(
	state: AgentRunState,
): Promise<void> {
	const snapshot = serialize({
		level: state.observeOriginalConsentLevel,
		runId: state.runId,
	});
	await writeImmutableFile(originalConsentPath(), snapshot);
	await writeImmutableFile(
		join(state.artifactDir, "observe-original-consent.json"),
		snapshot,
	);
}

async function atomicWriteFile(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, text);
	await rename(tempPath, path);
}

async function writeImmutableFile(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, text, { flag: "wx" });
	} catch (error) {
		if (!isNodeError(error, "EEXIST")) {
			throw error;
		}
		const existing = await readFile(path, "utf8");
		if (existing !== text) {
			throw new Error(`${path} already exists with a different consent target`);
		}
	}
}

function originalConsentPath(): string {
	return `${stateFilePath()}.observe-original-consent.json`;
}

async function readObserveOriginalConsentFile(path: string): Promise<
	| {
			level: NonNullable<AgentRunState["observeOriginalConsentLevel"]>;
	  }
	| undefined
> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}
	const parsed = parseJson(raw);
	if (
		!isRecord(parsed) ||
		parsed.runId !== currentRunId() ||
		!isObserveConsentLevel(parsed.level)
	) {
		throw new Error(`Invalid Agent 1:1 original consent file: ${path}`);
	}
	return { level: parsed.level };
}

async function readAgentRunState(): Promise<AgentRunState> {
	const raw = await readFile(stateFilePath(), "utf8");
	const parsed = parseJson(raw);
	if (!isAgentRunState(parsed)) {
		throw new Error(`Invalid Agent 1:1 state file: ${stateFilePath()}`);
	}
	if (parsed.runId !== currentRunId()) {
		throw new Error(
			`Agent 1:1 state file belongs to run ${parsed.runId}, not ${currentRunId()}`,
		);
	}
	if (Date.now() - Date.parse(parsed.startedAt) > 24 * 60 * 60 * 1_000) {
		throw new Error(`Stale Agent 1:1 state file: ${stateFilePath()}`);
	}
	return parsed;
}

function isObserveConsentLevel(
	value: unknown,
): value is NonNullable<AgentRunState["observeOriginalConsentLevel"]> {
	return value === "off" || value === "metadata-only" || value === "full";
}

function isAgentRunState(value: unknown): value is AgentRunState {
	return (
		isRecord(value) &&
		typeof value.artifactDir === "string" &&
		typeof value.fact === "string" &&
		typeof value.nonce === "string" &&
		typeof value.qaSession === "string" &&
		typeof value.runId === "string" &&
		typeof value.startedAt === "string" &&
		Number.isFinite(Date.parse(value.startedAt)) &&
		typeof value.teachSession === "string" &&
		typeof value.userCuid === "string"
	);
}

function isNodeError(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

function currentRunId(): string {
	const runId = process.env.SNO_AGENT_E2E_RUN_ID;
	if (!runId) {
		throw new Error(
			"Agent 1:1 phases require SNO_AGENT_E2E_RUN_ID. Use npm run test:e2e:agent.",
		);
	}
	return runId;
}
