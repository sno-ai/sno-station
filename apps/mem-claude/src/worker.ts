import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryClient } from "@snoai/memory/client";
import {
	CODING_SKIN_CHILD_DEADLINE_MS,
	CODING_SKIN_CHILD_MAX_BUFFER_BYTES,
	CODING_SKIN_IMPORT_INTERVAL_MS,
	CODING_SKIN_MAX_ATTEMPTS,
	CODING_SKIN_RETRY_DELAYS_MS,
	CODING_SKIN_WORKER_LIFETIME_MS,
	HOST_MODEL_CALLBACK_HOST,
	HOST_MODEL_CALLBACK_PATH,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { MODEL_ID, SKIN_ID } from "./constants.js";
import { acquirePidFileLock, writeJsonAtomic } from "./files.js";
import { connectMemory, isDegradedConnection } from "./memory-client.js";
import { withinDeadline } from "./recall.js";
import { appStateRoot, profileRoot, spoolDirectory, workerLockPath, workerLogPath } from "./paths.js";

const spoolSchema = z.object({
	sessionId: z.string().min(1),
	turnId: z.string().min(1),
	project: z.string().min(1),
	childCwd: z.string().min(1),
	user: z.string(),
	assistant: z.string().optional(),
	kind: z.enum(["turn", "import"]).optional(),
	importReceipt: z.object({ path: z.string().min(1), file: z.string().min(1) }).optional(),
	at: z.number(),
	attempts: z.number().int().nonnegative(),
	state: z.enum(["pending", "failed"]),
	retryAt: z.number().int().nonnegative().optional(),
});

export interface WorkerDependencies {
	connect(): Promise<MemoryClient>;
	runChild(prompt: string, cwd: string, timeoutMs?: number): Promise<{ kind: "ok"; text: string } | { kind: "cancelled"; reason: string } | { kind: "error"; category: "transport"; message: string }>;
	now?(): number;
	sleep?(delayMs: number): Promise<void>;
	beforeLockRelease?(): Promise<void>;
	handoff?(): Promise<void>;
}

function productionDependencies(): WorkerDependencies {
	return {
		async connect() {
			const client = await connectMemory();
			if (isDegradedConnection(client)) throw new Error(client.error ?? client.reason);
			return client;
		},
		runChild: runClaudeChild,
	};
}

export function startWorkerDetached(): void {
	const entry = process.argv[1];
	if (!entry) return;
	mkdirSync(appStateRoot(), { recursive: true, mode: 0o700 });
	const log = openSync(workerLogPath(), "a", 0o600);
	try {
		const child = spawn(process.execPath, [entry, "worker"], {
			detached: true,
			stdio: ["ignore", log, log],
			env: { ...process.env, SNO_PROFILE_DIR: profileRoot() },
		});
		child.unref();
	} finally {
		closeSync(log);
	}
}

async function runClaudeChild(prompt: string, cwd: string, timeoutMs = CODING_SKIN_CHILD_DEADLINE_MS): Promise<{ kind: "ok"; text: string } | { kind: "cancelled"; reason: string } | { kind: "error"; category: "transport"; message: string }> {
	if (timeoutMs <= 0) return { kind: "cancelled", reason: "deadline" };
	const env = { ...process.env };
	env["GIT_CEILING_DIRECTORIES"] = appStateRoot();
	delete env["CLAUDECODE"];
	const result = spawnSync("claude", ["-p", "--output-format", "json", "--max-turns", "1", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--no-session-persistence", "--permission-mode", "dontAsk", "--tools", ""], {
		cwd,
		env,
		input: prompt,
		encoding: "utf8",
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: CODING_SKIN_CHILD_MAX_BUFFER_BYTES,
	});
	if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") return { kind: "cancelled", reason: "deadline" };
	if (result.status !== 0) return { kind: "error", category: "transport", message: `claude-exit-${result.status ?? "signal"}` };
	let output: unknown;
	try { output = JSON.parse(result.stdout); } catch { return { kind: "error", category: "transport", message: "invalid-json" }; }
	const parsed = z.object({
		result: z.string().optional(),
		is_error: z.boolean(),
		usage: z.object({ cache_creation_input_tokens: z.number().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
	}).safeParse(output);
	if (!parsed.success) return { kind: "error", category: "transport", message: "invalid-result" };
	console.log(JSON.stringify({ event: "claude-child", cwd, usage: parsed.data.usage, claudeCodeUnset: true }));
	if (parsed.data.is_error) return { kind: "error", category: "transport", message: "claude-is-error" };
	const text = parsed.data.result?.trim();
	if (!text) return { kind: "error", category: "transport", message: "empty-output" };
	return { kind: "ok", text };
}

function promptFromMessages(value: unknown): { model: string; prompt: string } | undefined {
	const parsed = z.object({ model: z.string(), messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })) }).safeParse(value);
	if (!parsed.success) return undefined;
	return { model: parsed.data.model, prompt: parsed.data.messages.map(message => `${message.role}: ${message.content}`).join("\n\n") };
}

async function callbackServer(credential: string, activeCwd: () => string, isImport: () => boolean, onCall: () => void, runChild: WorkerDependencies["runChild"]): Promise<{ server: Server; baseUrl: string }> {
	let serial = Promise.resolve();
	let lastImportChildAt = 0;
	const server = createServer((request, response) => {
		serial = serial.then(async () => {
			if (request.method !== "POST" || request.url !== HOST_MODEL_CALLBACK_PATH) { response.writeHead(404).end(); return; }
			if (request.headers.authorization !== `Bearer ${credential}`) { response.writeHead(401).end(); return; }
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; }
			const requestBody = promptFromMessages(body);
			const cwd = activeCwd();
			if (!requestBody) { response.writeHead(400).end(); return; }
			onCall();
			if (isImport() && lastImportChildAt > 0) {
				const remaining = CODING_SKIN_IMPORT_INTERVAL_MS - (Date.now() - lastImportChildAt);
				if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
			}
			if (isImport()) {
				lastImportChildAt = Date.now();
				console.log(JSON.stringify({ event: "import-child-start", at: lastImportChildAt }));
			}
			const result = await runChild(requestBody.prompt, cwd);
			const status = result.kind === "ok" ? 200 : result.kind === "cancelled" ? 504 : 503;
			console.log(JSON.stringify({ event: "model-callback", model: requestBody.model, status }));
			response.setHeader("content-type", "application/json");
			if (result.kind === "ok") { response.writeHead(200).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: result.text } }] })); return; }
			response.writeHead(result.kind === "cancelled" ? 504 : 503).end(JSON.stringify({ error: result }));
		}).catch(() => { if (!response.headersSent) response.writeHead(503).end(); });
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, HOST_MODEL_CALLBACK_HOST, () => resolve()); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("callback-listen-failed");
	return { server, baseUrl: `http://${HOST_MODEL_CALLBACK_HOST}:${address.port}/v1` };
}

async function updateImportReceipt(reference: { path: string; file: string } | undefined, field: "committed" | "skipped" | "failures"): Promise<void> {
	if (!reference) return;
	try {
		const receipt = JSON.parse(await readFile(reference.path, "utf8")) as { files?: Record<string, { committed?: number; skipped?: number; failures?: number }> };
		const file = receipt.files?.[reference.file];
		if (!file) return;
		file[field] = (file[field] ?? 0) + 1;
		await writeJsonAtomic(reference.path, receipt);
	} catch (error) {
		console.log(JSON.stringify({ event: "import-receipt-failed", path: reference.path, file: reference.file, field, error: String(error) }));
	}
}

export async function hasActionableSpool(): Promise<boolean> {
	const names = (await readdir(spoolDirectory()).catch(() => [])).filter(name => name.endsWith(".json"));
	for (const name of names) {
		const contents = await readFile(join(spoolDirectory(), name), "utf8").catch(error => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!contents) continue;
		const record = spoolSchema.parse(JSON.parse(contents));
		if (record.attempts < CODING_SKIN_MAX_ATTEMPTS) return true;
	}
	return false;
}

export async function runWorker(dependencies: WorkerDependencies = productionDependencies()): Promise<"drained" | "locked" | "failed"> {
	const lock = await acquirePidFileLock(workerLockPath(), CODING_SKIN_WORKER_LIFETIME_MS);
	if (!lock) return "locked";
	const now = dependencies.now ?? Date.now;
	const sleep = dependencies.sleep ?? (async (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
	const workerStartedAt = now();
	const childCwd = join(appStateRoot(), "child");
	const credential = randomUUID();
	let currentCwd: string | undefined;
	let lastCallbackAt = workerStartedAt;
	let drainedAt: number | undefined;
	let currentImport = false;
	let server: Server | undefined;
	let handoff = false;
	try {
		mkdirSync(childCwd, { recursive: true, mode: 0o700 });
		const callback = await callbackServer(credential, () => currentCwd ?? childCwd, () => currentImport, () => { lastCallbackAt = now(); }, (prompt, cwd) => dependencies.runChild(prompt, cwd, Math.min(CODING_SKIN_CHILD_DEADLINE_MS, CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt))));
		server = callback.server;
		const client = await dependencies.connect();
		const principal = client.principal || userInfo().username;
		await client.init({ principal, project: "global", session: "claude-worker", host: { sessionId: "claude-worker" } }, {
			skinId: SKIN_ID, model: { baseUrl: callback.baseUrl, credential, model: MODEL_ID },
		});
		console.log(JSON.stringify({ event: "worker-registered" }));
		while (true) {
			const spoolNames = (await readdir(spoolDirectory()).catch(() => [])).filter(name => name.endsWith(".json")).sort();
			console.log(JSON.stringify({ event: "spool-scan", count: spoolNames.length }));
			let actionable = 0;
			for (const name of spoolNames) {
				const path = join(spoolDirectory(), name);
				let record = spoolSchema.parse(JSON.parse(await readFile(path, "utf8")));
				if (record.attempts >= CODING_SKIN_MAX_ATTEMPTS) continue;
				actionable += 1;
				drainedAt = undefined;
				while (record.attempts < CODING_SKIN_MAX_ATTEMPTS) {
					if (now() - workerStartedAt >= CODING_SKIN_WORKER_LIFETIME_MS) { handoff = true; return "drained"; }
					if (record.retryAt && record.retryAt > now()) {
						const remainingLifetime = CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt);
						if (remainingLifetime <= 0) { handoff = true; return "drained"; }
						await sleep(Math.min(record.retryAt - now(), remainingLifetime));
						if (record.retryAt > now() || now() - workerStartedAt >= CODING_SKIN_WORKER_LIFETIME_MS) { handoff = true; return "drained"; }
					}
					currentCwd = childCwd;
					currentImport = record.kind === "import";
					try {
						const messages = record.kind === "import"
							? [{ role: "user" as const, content: record.user, at: record.at }]
							: [
								{ role: "user" as const, content: record.user, at: record.at },
								{ role: "assistant" as const, content: record.assistant ?? "", at: record.at },
							];
						const result = await withinDeadline(
							client.capture({ turnId: record.turnId, rewindEpoch: 0, messages }, { principal, project: record.project, session: record.sessionId, host: { sessionId: record.sessionId, workspace: record.project } }),
							CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt),
						);
						if (result.degraded) throw new Error(result.reason);
						if (!result.committed && !result.accepted && !result.skipped && !result.partial) throw new Error("capture not committed");
						await updateImportReceipt(record.importReceipt, result.committed || result.accepted || result.partial ? "committed" : "skipped");
						console.log(JSON.stringify({ event: result.partial ? "capture-partial" : result.committed ? "capture-committed" : result.accepted ? "capture-accepted" : "capture-skipped", turnId: record.turnId, committed: result.committed }));
						await unlink(path);
						break;
					} catch {
						await updateImportReceipt(record.importReceipt, "failures");
						const attempts = record.attempts + 1;
						const retryDelay = CODING_SKIN_RETRY_DELAYS_MS[attempts - 1];
						record = {
							...record,
							attempts,
							state: attempts >= CODING_SKIN_MAX_ATTEMPTS ? "failed" : "pending",
							...(attempts < CODING_SKIN_MAX_ATTEMPTS && retryDelay !== undefined ? { retryAt: now() + retryDelay } : {}),
						};
						await writeJsonAtomic(path, record);
						if (now() - workerStartedAt >= CODING_SKIN_WORKER_LIFETIME_MS) { handoff = true; return "drained"; }
						if (record.attempts >= CODING_SKIN_MAX_ATTEMPTS) break;
					} finally {
						currentCwd = undefined;
						currentImport = false;
					}
				}
			}
			if (actionable === 0) {
				drainedAt ??= now();
				const remainingLifetime = CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt);
				const remainingIdle = 2 * 60_000 - (now() - Math.max(drainedAt, lastCallbackAt));
				if (remainingLifetime <= 0 || remainingIdle <= 0) { handoff = true; return "drained"; }
				// Short slices, so a turn spooled while idle is captured within seconds instead of after the window.
				await sleep(Math.min(remainingLifetime, remainingIdle, 5_000));
			}
		}
	} finally {
		if (server) {
			server.closeAllConnections();
			await new Promise<void>(resolve => server?.close(() => resolve()));
		}
		if (handoff) await dependencies.beforeLockRelease?.();
		await lock.release();
		if (handoff && await hasActionableSpool()) {
			if (dependencies.handoff) await dependencies.handoff();
			else startWorkerDetached();
		}
	}
}
