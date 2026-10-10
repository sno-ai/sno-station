// Adapted from apps/mem-claude/src/worker.ts (spool drain, host-model callback, one child at a time);
// the import path is dropped and the child is an isolated `cursor-agent -p` (build-contract.md "Agent-native child").
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryClient } from "@snoai/memory/client";
import {
	CODING_SKIN_CHILD_DEADLINE_MS,
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
	user: z.string(),
	assistant: z.string(),
	at: z.number(),
	attempts: z.number().int().nonnegative(),
	state: z.enum(["pending", "failed"]),
	retryAt: z.number().int().nonnegative().optional(),
});

export type ChildResult =
	| { kind: "ok"; text: string }
	| { kind: "cancelled"; reason: string }
	| { kind: "error"; category: "transport" | "auth" | "exhausted"; message: string };

export interface WorkerDependencies {
	connect(): Promise<MemoryClient>;
	runChild(prompt: string, timeoutMs?: number): Promise<ChildResult>;
	now?(): number;
	sleep?(delayMs: number): Promise<void>;
}

function productionDependencies(): WorkerDependencies {
	return {
		async connect() {
			const client = await connectMemory();
			if (isDegradedConnection(client)) throw new Error(client.error ?? client.reason);
			return client;
		},
		runChild: runCursorChild,
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

/** Maps one `cursor-agent -p --output-format json` run to a result; failure texts are the ones measured on Linux and macOS. */
export function cursorChildResult(status: number | null, stdout: string, stderr: string): ChildResult {
	const output = `${stdout}\n${stderr}`;
	if (output.includes("keychain is locked")) return { kind: "error", category: "auth", message: "Cursor CLI login unreadable (keychain locked)" };
	if (output.includes("hit your usage limit")) return { kind: "error", category: "exhausted", message: "Cursor usage limit reached" };
	if (status !== 0) return { kind: "error", category: "transport", message: `cursor-agent-exit-${status ?? "signal"}` };
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch { return { kind: "error", category: "transport", message: "invalid-json" }; }
	const result = z.object({ is_error: z.boolean(), result: z.string().optional() }).safeParse(parsed);
	if (!result.success) return { kind: "error", category: "transport", message: "invalid-result" };
	if (result.data.is_error) return { kind: "error", category: "transport", message: "cursor-is-error" };
	const text = result.data.result?.trim();
	return text ? { kind: "ok", text } : { kind: "error", category: "transport", message: "empty-output" };
}

/**
 * Runs the child with HOME set to a fresh folder holding only the CLI login (Linux: a copy of auth.json;
 * macOS: a link to the login keychains) and a link to ~/.local/share, in an empty folder: measured to fire
 * none of the user's or a project's hooks. The Cursor variables of the hook that started this worker are removed.
 */
export async function runCursorChild(prompt: string, timeoutMs = CODING_SKIN_CHILD_DEADLINE_MS): Promise<ChildResult> {
	if (timeoutMs <= 0) return { kind: "cancelled", reason: "deadline" };
	const realHome = homedir();
	const root = await mkdtemp(join(tmpdir(), "sno-cursor-child-"));
	try {
		const home = join(root, "home");
		const work = join(root, "work");
		await mkdir(join(home, ".local"), { recursive: true, mode: 0o700 });
		await mkdir(join(home, ".config", "cursor"), { recursive: true, mode: 0o700 });
		await mkdir(work, { mode: 0o700 });
		await symlink(join(realHome, ".local", "share"), join(home, ".local", "share"));
		await copyFile(join(realHome, ".config", "cursor", "auth.json"), join(home, ".config", "cursor", "auth.json")).catch(error => {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		});
		if (process.platform === "darwin") {
			await mkdir(join(home, "Library"), { mode: 0o700 });
			await symlink(join(realHome, "Library", "Keychains"), join(home, "Library", "Keychains"));
		}
		const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
			.filter(([key]) => !key.startsWith("CURSOR_") && key !== "SNO_REACH_ADDR"));
		env["HOME"] = home;
		const result = await new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean; error?: Error }>(resolve => {
			// Its own process group: the CLI starts helpers (a TypeScript language server through npx) that outlive it
			// and kept running after every run (observed 2026-10-10), so the whole group is killed once it exits.
			const child = spawn("cursor-agent", ["-p", "--trust", "--mode", "ask", "--output-format", "json"], { cwd: work, env, detached: true });
			let stdout = "";
			let stderr = "";
			let status: number | null = null;
			let timedOut = false;
			const killGroup = (): void => {
				try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
			};
			const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
			child.stdin.on("error", () => { /* a child that exits before reading its prompt is reported by its exit status */ });
			child.on("error", error => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut, error }); });
			child.on("exit", code => { status = code; killGroup(); });
			child.on("close", () => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
			child.stdin.end(prompt);
		});
		if (result.timedOut) return { kind: "cancelled", reason: "deadline" };
		if (result.error) return { kind: "error", category: "transport", message: `cursor-agent-${result.error.message}` };
		const child = cursorChildResult(result.status, result.stdout, result.stderr);
		console.log(JSON.stringify({ event: "cursor-child", status: result.status, result: child.kind === "ok" ? "ok" : child }));
		return child;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function promptFromMessages(value: unknown): { model: string; prompt: string } | undefined {
	const parsed = z.object({ model: z.string(), messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })) }).safeParse(value);
	if (!parsed.success) return undefined;
	return { model: parsed.data.model, prompt: parsed.data.messages.map(message => `${message.role}: ${message.content}`).join("\n\n") };
}

async function callbackServer(credential: string, onCall: () => void, runChild: (prompt: string) => Promise<ChildResult>): Promise<{ server: Server; baseUrl: string }> {
	let serial = Promise.resolve();
	const server = createServer((request, response) => {
		serial = serial.then(async () => {
			if (request.method !== "POST" || request.url !== HOST_MODEL_CALLBACK_PATH) { response.writeHead(404).end(); return; }
			if (request.headers.authorization !== `Bearer ${credential}`) { response.writeHead(401).end(); return; }
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; }
			const requestBody = promptFromMessages(body);
			if (!requestBody) { response.writeHead(400).end(); return; }
			onCall();
			const result = await runChild(requestBody.prompt);
			const status = result.kind === "ok" ? 200 : result.kind === "cancelled" ? 504 : 503;
			console.log(JSON.stringify({ event: "model-callback", model: requestBody.model, status }));
			response.setHeader("content-type", "application/json");
			if (result.kind === "ok") { response.writeHead(200).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: result.text } }] })); return; }
			response.writeHead(status).end(JSON.stringify({ error: result }));
		}).catch(() => { if (!response.headersSent) response.writeHead(503).end(); });
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, HOST_MODEL_CALLBACK_HOST, () => resolve()); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("callback-listen-failed");
	return { server, baseUrl: `http://${HOST_MODEL_CALLBACK_HOST}:${address.port}/v1` };
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
	const credential = randomUUID();
	let lastCallbackAt = workerStartedAt;
	let drainedAt: number | undefined;
	let server: Server | undefined;
	let handoff = false;
	try {
		const callback = await callbackServer(credential, () => { lastCallbackAt = now(); },
			prompt => dependencies.runChild(prompt, Math.min(CODING_SKIN_CHILD_DEADLINE_MS, CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt))));
		server = callback.server;
		const client = await dependencies.connect();
		const principal = client.principal || userInfo().username;
		await client.init({ principal, project: "global", session: "cursor-worker", host: { sessionId: "cursor-worker" } }, {
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
					try {
						const messages = [
							{ role: "user" as const, content: record.user, at: record.at },
							{ role: "assistant" as const, content: record.assistant, at: record.at },
						];
						const result = await withinDeadline(
							client.capture({ turnId: record.turnId, rewindEpoch: 0, messages }, { principal, project: record.project, session: record.sessionId, host: { sessionId: record.sessionId, workspace: record.project } }),
							CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt),
						);
						if (result.degraded) throw new Error(result.reason);
						if (!result.committed && !result.accepted && !result.skipped && !result.partial) throw new Error("capture not committed");
						console.log(JSON.stringify({ event: result.partial ? "capture-partial" : result.committed ? "capture-committed" : result.accepted ? "capture-accepted" : "capture-skipped", turnId: record.turnId, committed: result.committed }));
						await unlink(path);
						break;
					} catch (error) {
						const attempts = record.attempts + 1;
						console.log(JSON.stringify({ event: "capture-failed", turnId: record.turnId, attempts, reason: error instanceof Error ? error.message : String(error) }));
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
		await lock.release();
		if (handoff && await hasActionableSpool()) startWorkerDetached();
	}
}
