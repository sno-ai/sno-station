import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { createTestDb, type TestDb } from "./test-db.ts";

type JsonRecord = Record<string, unknown>;

interface Discovery {
	pid: number;
	port: number;
	token: string;
}

export interface ProductionEntryFixture {
	database: TestDb;
	profileRoot: string;
	killSidecar(): Promise<void>;
	restartSidecar(): Promise<void>;
	stateRoot: string;
	stderr(): string;
	stop(): Promise<void>;
	submit(operation: "rem-replace" | "rem-update", scope: string, correlationId: string): Promise<JsonRecord>;
	submitWave(
		operations: Array<"rem-replace" | "rem-update">,
		scope: string,
		correlationId: string,
	): Promise<JsonRecord>;
	waitForTerminal(identity: string, timeoutMs?: number): Promise<JsonRecord>;
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const appRoot = join(repoRoot, "packages/memory");
const sourceSidecarEntry = join(appRoot, "src/sidecar/main.ts");
const builtSidecarEntry = join(appRoot, "dist/sidecar/main.js");
const tsxBinary = join(repoRoot, "node_modules/.bin/tsx");

export async function startRemProductionEntryFixture(input: {
	entry?: "source" | "built";
	legacyJobs?: JsonRecord[];
	gpuBaseUrl?: string;
	/** Real endpoint key. Without it the sidecar is pointed at ccproxy, which ignores its key. */
	llmApiKey?: string;
	remOperations?: Array<"rem-update" | "rem-replace">;
	withoutExpectedDbPath?: boolean;
} = {}): Promise<ProductionEntryFixture> {
	const root = mkdtempSync(join(tmpdir(), "rem-production-entry-"));
	const stateRoot = join(root, "state");
	const profileRoot = stateRoot;
	mkdirSync(stateRoot, { recursive: true });
	mkdirSync(profileRoot, { recursive: true });
	const database = createTestDb();
	// The service reads the store, its key, the Sno GPU address and key and the log level from settings.json.
	writeSettingsFixture(profileRoot, {
		mode: "local-first",
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		embedding: { cacheDir: "" },
		rerank: { mode: "none" },
		snoGpu: {
			baseUrl: input.gpuBaseUrl ?? "http://localhost:8070/codex/v1/chat/completions",
			apiKey: input.llmApiKey ?? "ccproxy-ignored",
		},
		logging: { level: "info" },
		...(input.remOperations ? { rem: { operations: input.remOperations } } : {}),
	});
	if (input.legacyJobs !== undefined) {
		const stateDir = join(stateRoot, "sno-station-mem");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "rem-jobs.jsonl"),
			input.legacyJobs.map((row) => JSON.stringify(row)).join("\n") + "\n",
		);
	}

	// REM runs only with a connected host model; the host is the same endpoint the fixture uses for model calls.
	const hostModel = {
		baseUrl: input.gpuBaseUrl ?? "http://localhost:8070/codex/v1/chat/completions",
		credential: input.llmApiKey ?? "ccproxy-ignored",
		model: "gpt-5.6-terra",
	};

	const entry = input.entry ?? "source";
	const entryPath = entry === "built" ? builtSidecarEntry : sourceSidecarEntry;
	if (!existsSync(entryPath)) {
		database.cleanup();
		rmSync(root, { recursive: true, force: true });
		throw new Error(`REM production sidecar entry is missing: ${entryPath}`);
	}
	if (entry === "source" && !existsSync(tsxBinary)) {
		database.cleanup();
		rmSync(root, { recursive: true, force: true });
		throw new Error(`tsx binary is missing: ${tsxBinary}`);
	}

	const stderrChunks: Buffer[] = [];
	const discoveryPath = join(profileRoot, "station", "sidecar.json");
	let child: ChildProcess | undefined;
	let discovery: Discovery | undefined;
	const launchSidecar = async (): Promise<void> => {
		rmSync(discoveryPath, { force: true });
		const sidecarEnv: NodeJS.ProcessEnv = {
			...process.env,
			SNO_STATION_MEM_REM_EXPECTED_DB_PATH: database.dbPath,
			NODE_ENV: "test",
			SNO_PROFILE_DIR: profileRoot,
			SNO_STATION_MEM_REM_TRACE: "1",
		};
		if (input.withoutExpectedDbPath === true) {
			delete sidecarEnv.SNO_STATION_MEM_REM_EXPECTED_DB_PATH;
		}
		const launched = spawn(entry === "built" ? process.execPath : tsxBinary, [entryPath], {
			cwd: appRoot,
			detached: process.platform !== "win32",
			env: sidecarEnv,
			stdio: ["ignore", "ignore", "pipe"],
		});
		launched.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			process.stderr.write(chunk);
		});
		child = launched;
		try {
			discovery = await waitFor(
				() => readDiscovery(discoveryPath),
				3_000,
				() =>
					`sidecar discovery missing; stderr=${Buffer.concat(stderrChunks).toString("utf8")}`,
			);
			const registered = await fetch(`http://127.0.0.1:${discovery.port}/v1/init`, {
				method: "POST",
				headers: { "x-sno-station-mem-skin": "rem-fixture-host" },
				body: JSON.stringify({
					scope: { principal: "caller", project: "global", session: "rem-fixture-host" },
					registration: { skinId: "rem-fixture-host", model: hostModel },
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (registered.status !== 200) {
				throw new Error(`REM fixture host registration failed: status=${registered.status} body=${await registered.text()}`);
			}
		} catch (error) {
			await stopChild(launched);
			throw error;
		}
	};
	try {
		await launchSidecar();
	} catch (error) {
		database.cleanup();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}

	let stopped = false;
	return {
		database,
		profileRoot,
		stateRoot,
		stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
		async killSidecar(): Promise<void> {
			if (child !== undefined) await stopChild(child);
			child = undefined;
			discovery = undefined;
		},
		async restartSidecar(): Promise<void> {
			if (child !== undefined) throw new Error("REM sidecar is already running");
			await launchSidecar();
		},
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			if (child !== undefined) await stopChild(child);
			database.cleanup();
			rmSync(root, { recursive: true, force: true });
		},
		async submit(operation, scope, correlationId): Promise<JsonRecord> {
			if (discovery === undefined) throw new Error("REM sidecar is not running");
			const response = await fetch(`http://127.0.0.1:${discovery.port}/rem/run`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Rem-Correlation-Id": correlationId,
					"X-Sidecar-Token": discovery.token,
				},
				body: JSON.stringify({ scope, type: operation }),
				signal: AbortSignal.timeout(3_000),
			});
			const body = (await response.json()) as JsonRecord;
			if (response.status !== 202) {
				throw new Error(`REM production request failed: status=${response.status} body=${JSON.stringify(body)}`);
			}
			return body;
		},
		async submitWave(operations, scope, correlationId): Promise<JsonRecord> {
			if (discovery === undefined) throw new Error("REM sidecar is not running");
			const response = await fetch(`http://127.0.0.1:${discovery.port}/rem/run`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Rem-Correlation-Id": correlationId,
					"X-Sidecar-Token": discovery.token,
				},
				body: JSON.stringify({ scope, types: operations }),
				signal: AbortSignal.timeout(3_000),
			});
			const body = (await response.json()) as JsonRecord;
			if (response.status !== 202) {
				throw new Error(`REM production request failed: status=${response.status} body=${JSON.stringify(body)}`);
			}
			return body;
		},
		async waitForTerminal(identity, timeoutMs = 90_000): Promise<JsonRecord> {
			if (discovery === undefined) throw new Error("REM sidecar is not running");
			const activeDiscovery = discovery;
			return waitFor(
				async () => {
					const response = await fetch(
						`http://127.0.0.1:${activeDiscovery.port}/rem/jobs/${encodeURIComponent(identity)}`,
						{
							headers: { "X-Sidecar-Token": activeDiscovery.token },
							signal: AbortSignal.timeout(3_000),
						},
					);
					if (response.status === 404) return undefined;
					if (!response.ok) throw new Error(`REM status failed: ${response.status}`);
					const value = (await response.json()) as JsonRecord;
					return ["done", "failed", "refused"].includes(String(value["state"]))
						? value
						: undefined;
				},
				timeoutMs,
				() => `REM wave ${identity} did not become terminal; stderr=${Buffer.concat(stderrChunks).toString("utf8")}`,
			);
		},
	};
}

export function runInstalledSno(input: {
	args: string[];
	extraEnv?: Record<string, string>;
	profileRoot: string;
	stateRoot: string;
}): { status: number | null; stderr: string; stdout: string } {
	const installedCli = process.env["SNO_CLI_BIN"];
	if (!installedCli || !existsSync(installedCli)) {
		throw new Error("SNO_CLI_BIN must name an installed sno binary");
	}
	const result = spawnSync(installedCli, input.args, {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			SNO_PROFILE_DIR: input.profileRoot,
			...input.extraEnv,
		},
		timeout: 90_000,
	});
	if (result.error !== undefined) throw result.error;
	return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

export function seedProductionMemory(
	database: BetterSqlite3.Database,
	input: {
		id?: string;
		metadata?: JsonRecord;
		scope: string;
		text: string;
		timestamp?: string;
	},
): string {
	const id = input.id ?? `clrem${randomUUID().replaceAll("-", "")}`;
	const timestamp = Date.parse(input.timestamp ?? "2026-08-09T08:00:00.000Z");
	database
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?)`,
		)
		.run(
			id,
			input.text,
			input.scope,
			timestamp,
			JSON.stringify(input.metadata ?? { section_name: "preferences.production-reachability" }),
			createHash("sha256").update(input.text).digest("hex"),
			`fact-${id}`,
			JSON.stringify({ evidence: input.text }),
		);
	return id;
}

export function readJsonLines(path: string): JsonRecord[] {
	if (!existsSync(path)) throw new Error(`required JSONL evidence is missing: ${path}`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JsonRecord);
}

export function prepareGrammarInputs(
	stateRoot: string,
	candidateSource: string,
	condition:
		| "changed-invalid"
		| "changed-valid"
		| "missing-accepted"
		| "missing-corpus"
		| "valid-unchanged",
): void {
	const snoStationMemRoot = join(stateRoot, "sno-station-mem");
	const corpusRoot = join(snoStationMemRoot, "rem-grammar-corpus");
	const acceptedPath = join(snoStationMemRoot, "rem-operational-config.accepted.json");
	const candidate = JSON.parse(candidateSource) as JsonRecord;
	const before = structuredClone(candidate);
	if (condition === "changed-invalid" || condition === "changed-valid") {
		const facetPolicy = before["facetPolicy"] as JsonRecord;
		facetPolicy["aggregationGrammar"] = "current-first-before-production-reachability";
	}
	if (condition !== "missing-accepted") {
		writeFileSync(acceptedPath, JSON.stringify(before), { mode: 0o600 });
		chmodSync(acceptedPath, 0o600);
	} else {
		rmSync(acceptedPath, { force: true });
	}
	const corpusBytes = `${JSON.stringify({
			input: "The user no longer prefers tea.",
			expected: "negated-current",
		})}\n`;
	if (condition !== "missing-corpus") {
		mkdirSync(corpusRoot, { recursive: true });
		writeFileSync(join(corpusRoot, "production-reachability.jsonl"), corpusBytes, {
			mode: 0o600,
		});
	} else {
		rmSync(corpusRoot, { recursive: true, force: true });
	}
	if (condition === "changed-invalid" || condition === "changed-valid") {
		const gateRoot = join(snoStationMemRoot, "rem-gates");
		const beforeDigest = configurationDigest(before);
		const afterDigest = configurationDigest(candidate);
		writeFileSync(
			join(gateRoot, "facet-policy-grammar-ab.json"),
			`${JSON.stringify({
				beforeConfigurationSha256: beforeDigest,
				afterConfigurationSha256:
					condition === "changed-valid" ? afterDigest : "0".repeat(64),
				corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
				metricDefinitions: ["exact target recall"],
				result: "pass",
			})}\n`,
			{ mode: 0o600 },
		);
	}
}

function configurationDigest(configuration: JsonRecord): string {
	const { enableGateDigests: _excluded, ...identity } = configuration;
	return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") throw new Error("unsupported canonical JSON value");
	const record = value as JsonRecord;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function readDiscovery(path: string): Discovery | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Discovery>;
		if (
			typeof value.pid !== "number" ||
			typeof value.port !== "number" ||
			typeof value.token !== "string"
		) {
			return undefined;
		}
		return value as Discovery;
	} catch {
		return undefined;
	}
}

async function waitFor<T>(
	check: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	failure: () => string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== undefined) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(failure());
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
	}
	await Promise.race([
		once(child, "exit"),
		new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
	]);
}
