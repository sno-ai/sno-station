// Adapted from apps/mem-claude/src/worker.ts (spool drain, host-model callback, one child at a time);
// the import path is dropped and the child is an isolated `cursor-agent -p` (build-contract.md "Agent-native child").
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MemoryClient } from "@snoai/memory/client";
import {
	CODING_SKIN_CAPTURE_MAX_INPUT_TOKENS,
	CODING_SKIN_CAPTURE_QUIET_MS,
	CODING_SKIN_CHILD_DEADLINE_MS,
	CODING_SKIN_MAX_ATTEMPTS,
	CODING_SKIN_MAX_PENDING_CAPTURES,
	CODING_SKIN_RETRY_DELAYS_MS,
	CODING_SKIN_WORKER_LIFETIME_MS,
	HOST_MODEL_CALLBACK_HOST,
	HOST_MODEL_CALLBACK_PATH,
} from "@snoai/memory/coding-skin";
import { z } from "zod";
import { MODEL_ID, SKIN_ID } from "./constants.js";
import { acquirePidFileLock, writeJsonAtomic } from "./files.js";
import { connectMemory, isDegradedConnection } from "./memory-client.js";
import { appStateRoot, endedSessionPath, endedSessionsDirectory, profileRoot, spoolDirectory, workerLockPath, workerLogPath } from "./paths.js";

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
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch { /* Report invalid JSON after checking CLI failure texts. */ }
	const result = z.object({ is_error: z.boolean(), result: z.string().optional() }).safeParse(parsed);
	const text = result.success && !result.data.is_error ? result.data.result?.trim() : undefined;
	if (status === 0 && text) return { kind: "ok", text };
	const output = `${stdout}\n${stderr}`;
	if (output.includes("keychain is locked")) return { kind: "error", category: "auth", message: "Cursor CLI login unreadable (keychain locked)" };
	if (output.includes("hit your usage limit")) return { kind: "error", category: "exhausted", message: "Cursor usage limit reached" };
	if (status !== 0) return { kind: "error", category: "transport", message: `cursor-agent-exit-${status ?? "signal"}` };
	if (parsed === undefined) return { kind: "error", category: "transport", message: "invalid-json" };
	if (!result.success) return { kind: "error", category: "transport", message: "invalid-result" };
	if (result.data.is_error) return { kind: "error", category: "transport", message: "cursor-is-error" };
	return { kind: "error", category: "transport", message: "empty-output" };
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
			const startedAt = Date.now();
			const result = await runChild(requestBody.prompt);
			const status = result.kind === "ok" ? 200 : result.kind === "cancelled" ? 504 : 503;
			console.log(JSON.stringify({ event: "model-callback", model: requestBody.model, status, outcome: result.kind, duration_ms: Date.now() - startedAt, ...(result.kind === "ok" ? {} : { reason: result.kind === "cancelled" ? result.reason : `${result.category}: ${result.message}` }) }));
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

async function readSpool(path: string): Promise<z.infer<typeof spoolSchema> | undefined> {
	const contents = await readFile(path, "utf8").catch(error => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (contents === undefined) return undefined;
	let record: z.infer<typeof spoolSchema>;
	try { record = spoolSchema.parse(JSON.parse(contents)); }
	catch (error) {
		await rm(path, { force: true });
		console.log(JSON.stringify({ event: "spool-discarded", path, reason: "invalid-record", error: String(error) }));
		return undefined;
	}
	if (record.attempts >= CODING_SKIN_MAX_ATTEMPTS) {
		await rm(path, { force: true });
		console.log(JSON.stringify({ event: "spool-discarded", path, turnId: record.turnId, reason: "attempts-exhausted" }));
		return undefined;
	}
	return record;
}

async function readSpoolNames(): Promise<string[]> {
	const names = (await readdir(spoolDirectory()).catch(() => [])).filter(name => name.endsWith(".json")).sort();
	const removed = names.splice(0, Math.max(0, names.length - CODING_SKIN_MAX_PENDING_CAPTURES));
	for (const name of removed) await rm(join(spoolDirectory(), name), { force: true });
	if (removed.length > 0) console.log(JSON.stringify({ event: "spool-pruned", removed: removed.length,
		remaining: names.length, reason: "capacity" }));
	return names;
}

type SpoolEntry = { path: string; record: z.infer<typeof spoolSchema> };

async function readSpoolEntries(): Promise<SpoolEntry[]> {
	const entries: SpoolEntry[] = [];
	for (const name of await readSpoolNames()) {
		const path = join(spoolDirectory(), name);
		const record = await readSpool(path);
		if (record) entries.push({ path, record });
	}
	return entries;
}

/** The queued sessions that have ended; markers of sessions with nothing queued are removed. */
async function readEndedSessions(entries: readonly SpoolEntry[]): Promise<Set<string>> {
	const queued = new Map(entries.map(({ record }) => [basename(endedSessionPath(record.sessionId)), record.sessionId]));
	const ended = new Set<string>();
	for (const name of await readdir(endedSessionsDirectory()).catch(() => [])) {
		const sessionId = queued.get(name);
		if (sessionId === undefined) await rm(join(endedSessionsDirectory(), name), { force: true });
		else ended.add(sessionId);
	}
	return ended;
}

/**
 * The next capture: a session's turns once it has ended or been quiet for the window, then its consecutive records that
 * share the first one's scope and tries, up to the input budget. `nextDueAt` is when the earliest waiting session turns due.
 */
export function nextCapture(entries: readonly SpoolEntry[], ended: ReadonlySet<string>, now: number): { batch: SpoolEntry[]; nextDueAt: number | undefined } {
	const newest = new Map<string, number>();
	for (const { record } of entries) newest.set(record.sessionId, Math.max(newest.get(record.sessionId) ?? record.at, record.at));
	const dueAt = (sessionId: string): number => ended.has(sessionId) ? now : (newest.get(sessionId) ?? now) + CODING_SKIN_CAPTURE_QUIET_MS;
	const waiting = [...newest.keys()].map(dueAt).filter(at => at > now);
	const nextDueAt = waiting.length > 0 ? Math.min(...waiting) : undefined;
	const head = entries.find(({ record }) => dueAt(record.sessionId) <= now);
	if (!head) return { batch: [], nextDueAt };
	const batch: SpoolEntry[] = [];
	let tokens = 0;
	for (const entry of entries) {
		const { record } = entry;
		if (record.sessionId !== head.record.sessionId || record.project !== head.record.project
			|| record.attempts !== head.record.attempts || record.retryAt !== head.record.retryAt) continue;
		const size = Buffer.byteLength(record.user + record.assistant) / 3;
		if (batch.length > 0 && tokens + size > CODING_SKIN_CAPTURE_MAX_INPUT_TOKENS) break;
		batch.push(entry);
		tokens += size;
	}
	return { batch, nextDueAt };
}

/** True when a capture is due now or a queued session turns due later, so a worker started now has work or waits for it. */
export async function hasActionableSpool(now: number = Date.now()): Promise<boolean> {
	const entries = await readSpoolEntries();
	const { batch, nextDueAt } = nextCapture(entries, await readEndedSessions(entries), now);
	return batch.length > 0 || nextDueAt !== undefined;
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
			prompt => dependencies.runChild(prompt, CODING_SKIN_CHILD_DEADLINE_MS));
		server = callback.server;
		await readSpoolNames();
		const client = await dependencies.connect();
		const principal = client.principal || userInfo().username;
		await client.init({ principal, project: "global", session: "cursor-worker", host: { sessionId: "cursor-worker" } }, {
			skinId: SKIN_ID, model: { baseUrl: callback.baseUrl, credential, model: MODEL_ID },
		});
		console.log(JSON.stringify({ event: "worker-registered" }));
		while (true) {
			const entries = await readSpoolEntries();
			console.log(JSON.stringify({ event: "spool-scan", count: entries.length }));
			const { batch, nextDueAt } = nextCapture(entries, await readEndedSessions(entries), now());
			let actionable = 0;
			for (const head of batch.slice(0, 1)) {
				let record = head.record;
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
						const messages = batch.flatMap(({ record: turn }) => [
							{ role: "user" as const, content: turn.user, at: turn.at },
							{ role: "assistant" as const, content: turn.assistant, at: turn.at },
						]);
						// A capture in flight is never abandoned for the lifetime: the sidecar would go on extracting it while this
						// worker's model callback is gone. Its route deadline bounds it, and the lifetime is checked before the next one.
						const result = await client.capture({ turnId: record.turnId, rewindEpoch: 0, messages }, { principal, project: record.project, session: record.sessionId, host: { sessionId: record.sessionId, workspace: record.project } });
						if (result.degraded) throw new Error(result.reason);
						if (!result.committed && !result.accepted && !result.skipped && !result.partial) throw new Error("capture not committed");
						for (const entry of batch) {
							console.log(JSON.stringify({ event: result.partial ? "capture-partial" : result.committed ? "capture-committed" : result.accepted ? "capture-accepted" : "capture-skipped", turnId: entry.record.turnId, committed: result.committed }));
							await rm(entry.path, { force: true });
						}
						break;
					} catch (error) {
						const attempts: number = record.attempts + 1;
						for (const entry of batch) console.log(JSON.stringify({ event: "capture-failed", turnId: entry.record.turnId, attempts, final: attempts >= CODING_SKIN_MAX_ATTEMPTS, reason: error instanceof Error ? error.message : String(error) }));
						// A batch shares its tries, so only its first turn is given up; the rest keep their own counts on disk.
						if (attempts >= CODING_SKIN_MAX_ATTEMPTS) { const [first] = batch; if (first) await rm(first.path, { force: true }); break; }
						const retryDelay = CODING_SKIN_RETRY_DELAYS_MS[attempts - 1];
						record = {
							...record,
							attempts,
							state: "pending",
							...(retryDelay !== undefined ? { retryAt: now() + retryDelay } : {}),
						};
						for (const entry of batch) {
							entry.record = { ...entry.record, attempts, state: "pending", retryAt: record.retryAt };
							await writeJsonAtomic(entry.path, entry.record);
						}
						if (now() - workerStartedAt >= CODING_SKIN_WORKER_LIFETIME_MS) { handoff = true; return "drained"; }
					}
				}
			}
			if (actionable === 0) {
				drainedAt ??= now();
				const remainingLifetime = CODING_SKIN_WORKER_LIFETIME_MS - (now() - workerStartedAt);
				const remainingIdle = 2 * 60_000 - (now() - Math.max(drainedAt, lastCallbackAt));
				// A waiting session is waited for however far off, so it is captured when its quiet window ends; the lifetime
				// bounds busy work only, and a capture turning due past it is handed to a fresh worker.
				if (nextDueAt === undefined && (remainingLifetime <= 0 || remainingIdle <= 0)) { handoff = true; return "drained"; }
				// Short slices, so a turn spooled while idle is captured within seconds instead of after the window.
				await sleep(Math.min(nextDueAt === undefined ? Math.min(remainingLifetime, remainingIdle) : nextDueAt - now(), 5_000));
			}
		}
	} finally {
		if (server) {
			server.closeAllConnections();
			await new Promise<void>(resolve => server?.close(() => resolve()));
		}
		await lock.release();
		if (handoff && await hasActionableSpool(now())) startWorkerDetached();
	}
}
