import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIRECTORY = ".sno-station";
const SALT_FILE = "diagnostic-reference.salt";
const MAX_REFERENCE_LENGTH = 128;
const contextStorage = new AsyncLocalStorage<Readonly<LogContext>>();
const isolatedSalt = randomBytes(32);
let configuredHome: string | undefined;

export interface LogReference {
	value: string | null;
	visibility: "public" | "hashed" | "unavailable";
	reason?: string;
}

export interface LogContextInput {
	operation_id?: string;
	attempt_id?: string;
	job_id?: string;
	session_reference?: string;
	external_reference?: string;
	external_reference_visibility?: "public" | "private";
	trace_id?: string;
	span_id?: string;
}

export interface LogContext {
	operation_id: string | null;
	operation_reason?: string;
	attempt_id?: string;
	job_id?: string;
	session_reference: LogReference;
	external_reference: LogReference;
	trace_id?: string;
	span_id?: string;
}

export function logStateRoot(): string {
	return configuredHome ?? join(homedir(), STATE_DIRECTORY);
}

export function configureLogStateRoot(home: string | undefined): void {
	configuredHome = home;
}

function referenceSalt(): Buffer {
	if (process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true"
		|| process.env["VITEST_WORKER_ID"] !== undefined) return isolatedSalt;
	const root = logStateRoot();
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = join(root, SALT_FILE);
	let fd: number;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
			| constants.O_NOFOLLOW, 0o600);
		try { writeSync(fd, randomBytes(32)); } finally { closeSync(fd); }
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Invalid diagnostic salt file");
		const salt = readFileSync(fd);
		if (salt.length !== 32) throw new Error("Invalid diagnostic salt length");
		return salt;
	} finally { closeSync(fd); }
}

export function externalLogReference(raw?: string, visibility?: "public" | "private"): LogReference {
	if (raw === undefined) return { value: null, visibility: "unavailable", reason: "not_supplied" };
	if (!raw.trim() || raw.length > MAX_REFERENCE_LENGTH) {
		return { value: null, visibility: "unavailable", reason: "invalid_reference_length" };
	}
	if (visibility === "public") return { value: raw, visibility: "public" };
	try {
		return { value: createHmac("sha256", referenceSalt()).update(raw).digest("hex"), visibility: "hashed" };
	} catch {
		return { value: null, visibility: "unavailable", reason: "salt_unavailable" };
	}
}

export function privateLogReference(raw?: string): LogReference {
	return externalLogReference(raw, "private");
}

function publicId(raw?: string): string | undefined {
	return raw && /^[\w.:-]{1,128}$/.test(raw) ? raw : undefined;
}

export function withLogContext<T>(input: LogContextInput, callback: () => T): T {
	const parent = contextStorage.getStore();
	const operationId = publicId(input.operation_id) ?? parent?.operation_id ?? null;
	const context: LogContext = {
		...parent,
		operation_id: operationId,
		...(!operationId ? { operation_reason: "not_supplied" } : {}),
		session_reference: input.session_reference !== undefined
			? privateLogReference(input.session_reference) : parent?.session_reference ?? privateLogReference(),
		external_reference: input.external_reference !== undefined
			? externalLogReference(input.external_reference, input.external_reference_visibility)
			: parent?.external_reference ?? externalLogReference(),
	};
	for (const key of ["attempt_id", "job_id"] as const) {
		const value = publicId(input[key]);
		if (value) context[key] = value;
	}
	for (const [key, length] of [["trace_id", 32], ["span_id", 16]] as const) {
		const value = input[key];
		if (value && new RegExp(`^[a-f0-9]{${length}}$`).test(value) && /[1-9a-f]/.test(value)) {
			context[key] = value;
		}
	}
	return contextStorage.run(Object.freeze(context), callback);
}

export function currentLogContext(): Readonly<LogContext> {
	return contextStorage.getStore() ?? {
		operation_id: null, operation_reason: "not_supplied",
		session_reference: privateLogReference(), external_reference: externalLogReference(),
	};
}
