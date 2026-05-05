import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { resolveConfigPaths } from "./config.js";
import {
	KeychainUnavailableError,
	ManifestCorrupted,
	ManifestMissing,
	MissingDekError,
	WrongKeyError,
} from "./errors.js";
import { readHiddenLineFromTty } from "./hidden-input.js";
import {
	atomicReplaceSecretFile,
	readSecretFile,
	readSecretFileSync,
	writeNewSecretFile,
} from "./key-file.js";
import { liveKeychain } from "./keychain.js";
import {
	isManifestPresent,
	isMarkerPresent,
	readManifestIfPresent,
} from "./manifest.js";
import {
	type Dek,
	KEY_STATE_VERSION,
	type KeyStateFile,
	type KeyStateFilePlain,
	type KeyStateFileWrapped,
} from "./types.js";
import { unwrapDek, type WrappedDek } from "./wrap.js";

let dekPromise: Promise<Dek> | undefined;
let warnedFallback = false;
let warnedRemoveCrash = false;

const trackedDekBuffers: Set<Buffer> = new Set();
let beforeExitHooked = false;

function registerForZeroize(buf: Buffer): void {
	trackedDekBuffers.add(buf);
	if (!beforeExitHooked) {
		beforeExitHooked = true;
		const handler = (): void => {
			for (const b of trackedDekBuffers) {
				try {
					b.fill(0);
				} catch {
					// ignore
				}
			}
		};
		process.on("beforeExit", handler);
		process.on("exit", handler);
	}
}

function asDek(buf: Buffer): Dek {
	if (buf.length !== 32) {
		throw new Error(`DEK must be 32 bytes; got ${buf.length}`);
	}
	registerForZeroize(buf);
	return buf as Dek;
}

function readPlainKeyFileSync(content: Buffer): KeyStateFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.toString("utf8"));
	} catch (err) {
		throw new ManifestCorrupted("key state file is not valid JSON", {
			cause: err,
		});
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new ManifestCorrupted("key state file is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	if (obj["version"] !== KEY_STATE_VERSION) {
		throw new ManifestCorrupted(
			`key state file has unsupported version ${String(obj["version"])}`,
		);
	}
	const mode = obj["mode"];
	if (mode !== "plain" && mode !== "wrapped") {
		throw new ManifestCorrupted(
			`key state file has unrecognized mode ${String(mode)}`,
		);
	}
	return obj as unknown as KeyStateFile;
}

async function readKeyState(): Promise<KeyStateFile | undefined> {
	const { keyFile } = resolveConfigPaths();
	if (!existsSync(keyFile)) return undefined;
	const buf = await readSecretFile(keyFile);
	return readPlainKeyFileSync(buf);
}

function readKeyStateSync(): KeyStateFile | undefined {
	const { keyFile } = resolveConfigPaths();
	if (!existsSync(keyFile)) return undefined;
	const buf = readSecretFileSync(keyFile);
	return readPlainKeyFileSync(buf);
}

function makePlainKeyState(dek: Buffer): KeyStateFilePlain {
	return {
		version: KEY_STATE_VERSION,
		mode: "plain",
		dek: dek.toString("hex"),
		wrappedDek: null,
		wrapNonce: null,
		wrapTag: null,
		kdfParams: null,
		salt: null,
		createdAt: new Date().toISOString(),
		host: hostname(),
	};
}

function emitFallbackWarning(): void {
	if (warnedFallback) return;
	warnedFallback = true;
	const { keyFile } = resolveConfigPaths();
	process.stderr.write(
		`[nodix] WARN: OS keychain unavailable. Falling back to ${keyFile} (mode 0600).\n` +
			`[nodix]      Encryption is on, but the DEK is now protected only by file-system permissions.\n` +
			`[nodix]      To upgrade: run \`nodix lock --set-passphrase\`.\n`,
	);
}

function emitRemovePassphraseCrashWarning(): void {
	if (warnedRemoveCrash) return;
	warnedRemoveCrash = true;
	process.stderr.write(
		`[nodix] WARN: detected an interrupted \`--remove-passphrase\`. Re-running it is recommended.\n`,
	);
}

async function promptPassphrase(): Promise<Buffer> {
	const useStdin = process.env["NODIX_PASSPHRASE_STDIN"] === "1";
	if (!useStdin && process.stdin.isTTY) {
		const line = await readHiddenLineFromTty("Enter nodix passphrase: ");
		return Buffer.from(line, "utf8");
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: false,
	});
	process.stderr.write("Enter nodix passphrase: ");
	try {
		const line = await new Promise<string>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				rl.off("line", onLine);
				rl.off("close", onClose);
			};
			const onLine = (line: string): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(line);
			};
			const onClose = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(
					new WrongKeyError("passphrase input closed before a line was read"),
				);
			};
			rl.once("line", onLine);
			rl.once("close", onClose);
		});
		return Buffer.from(line, "utf8");
	} finally {
		rl.close();
	}
}

interface DekResolution {
	dek: Buffer;
	persistedAsPlain: boolean;
}

async function generateAndPersistFresh(): Promise<DekResolution> {
	const dek = randomBytes(32);
	try {
		liveKeychain.set(dek.toString("hex"));
		return { dek, persistedAsPlain: false };
	} catch (err) {
		if (err instanceof KeychainUnavailableError) {
			emitFallbackWarning();
			const { keyFile } = resolveConfigPaths();
			writeNewSecretFile(keyFile, JSON.stringify(makePlainKeyState(dek)));
			return { dek, persistedAsPlain: true };
		}
		throw err;
	}
}

function readKeychainHex(): string | null {
	try {
		return liveKeychain.get();
	} catch (err) {
		if (err instanceof KeychainUnavailableError) return null;
		throw err;
	}
}

function readPlainDekFromKeyState(state: KeyStateFilePlain): Buffer {
	return Buffer.from(state.dek, "hex");
}

async function unwrapWithPrompt(state: KeyStateFileWrapped): Promise<Buffer> {
	const passphrase = await promptPassphrase();
	try {
		const wrapped: WrappedDek = {
			version: state.version,
			salt: state.salt,
			kdfParams: state.kdfParams,
			nonce: state.wrapNonce,
			ciphertext: state.wrappedDek,
			tag: state.wrapTag,
		};
		return await unwrapDek(wrapped, passphrase);
	} finally {
		passphrase.fill(0);
	}
}

/**
 * Step A → Step B → Step C → Step D state machine per spec.
 *
 * @param skipManifestGate when true, bypasses the marker-without-manifest
 *   check. The CLI's `lock --rebuild-manifest` path uses this so it can read
 *   the DEK while the manifest is missing — that is exactly the recovery
 *   scenario it implements.
 */
async function resolveDek(skipManifestGate = false): Promise<Buffer> {
	// Step A — manifest/marker inventory.
	const manifestPresent = isManifestPresent();
	const markerPresent = isMarkerPresent();
	if (!manifestPresent && markerPresent && !skipManifestGate) {
		throw new ManifestMissing();
	}
	const manifest = manifestPresent ? readManifestIfPresent() : undefined;
	const registeredDbs = manifest?.dbs.length ?? 0;

	// Step B — key-source inventory.
	const keychainHex = readKeychainHex();
	const keyState = await readKeyState();

	// Step B.conflict — keychain hit AND wrapped key file present (post `--remove-passphrase` crash).
	if (keychainHex && keyState?.mode === "wrapped") {
		emitRemovePassphraseCrashWarning();
		// We cannot run a canary-verify here without a registered DB to test against;
		// in v0.1 we trust the keychain when both are present (its presence is the
		// late-stage state in `--remove-passphrase`'s two-phase commit per spec
		// scenario "Both keychain and wrapped state present"). The spurious wrapped
		// file is left untouched per spec.
		return Buffer.from(keychainHex, "hex");
	}

	// Step C — source priority.
	if (keychainHex) {
		return Buffer.from(keychainHex, "hex");
	}
	if (keyState?.mode === "wrapped") {
		return await unwrapWithPrompt(keyState);
	}
	if (keyState?.mode === "plain") {
		// Per spec: emit the plain-mode warning at every process's first `getDek()`
		// call, not only on fresh fallback generation. Idempotent — guarded by
		// `warnedFallback` so subsequent calls in the same process are silent.
		emitFallbackWarning();
		return readPlainDekFromKeyState(keyState);
	}

	// Step D — generation gate.
	if (registeredDbs >= 1) {
		throw new MissingDekError();
	}
	if (manifestPresent && registeredDbs === 0) {
		// manifest exists but is empty — equivalent to fresh-install for DEK gen
		const r = await generateAndPersistFresh();
		return r.dek;
	}
	// Fresh install: no manifest, no marker, no DEK source.
	const r = await generateAndPersistFresh();
	return r.dek;
}

export async function getDek(): Promise<Dek> {
	if (!dekPromise) {
		dekPromise = (async () => {
			const buf = await resolveDek();
			if (buf.length !== 32) {
				throw new WrongKeyError("resolved DEK has wrong length");
			}
			return asDek(buf);
		})();
	}
	return dekPromise;
}

/**
 * Recovery-only DEK resolver — skips the marker-without-manifest gate.
 * Internal use by `nodix lock --rebuild-manifest`. Does not populate the
 * shared dekPromise cache (the production gate is still authoritative for
 * normal callers).
 */
export async function _getDekForRecovery(): Promise<Dek> {
	const buf = await resolveDek(true);
	if (buf.length !== 32) {
		throw new WrongKeyError("resolved DEK has wrong length");
	}
	return asDek(buf);
}

export function _resetDekCache(): void {
	dekPromise = undefined;
	cachedSyncDek = undefined;
	warnedFallback = false;
	warnedRemoveCrash = false;
}

let cachedSyncDek: Dek | undefined;

function generateAndPersistFreshSync(): Buffer {
	const dek = randomBytes(32);
	try {
		liveKeychain.set(dek.toString("hex"));
		return dek;
	} catch (err) {
		if (err instanceof KeychainUnavailableError) {
			emitFallbackWarning();
			const { keyFile } = resolveConfigPaths();
			writeNewSecretFile(keyFile, JSON.stringify(makePlainKeyState(dek)));
			return dek;
		}
		throw err;
	}
}

function resolveDekSync(): Buffer {
	const manifestPresent = isManifestPresent();
	const markerPresent = isMarkerPresent();
	if (!manifestPresent && markerPresent) {
		throw new ManifestMissing();
	}
	const manifest = manifestPresent ? readManifestIfPresent() : undefined;
	const registeredDbs = manifest?.dbs.length ?? 0;

	const keychainHex = readKeychainHex();
	const keyState = readKeyStateSync();

	if (keychainHex && keyState?.mode === "wrapped") {
		emitRemovePassphraseCrashWarning();
		return Buffer.from(keychainHex, "hex");
	}
	if (keychainHex) {
		return Buffer.from(keychainHex, "hex");
	}
	if (keyState?.mode === "wrapped") {
		throw new WrongKeyError(
			"WrongKeyError: passphrase-mode DEK requires async getDek() with interactive prompt",
		);
	}
	if (keyState?.mode === "plain") {
		emitFallbackWarning();
		return readPlainDekFromKeyState(keyState);
	}

	if (registeredDbs >= 1) {
		throw new MissingDekError();
	}
	return generateAndPersistFreshSync();
}

/**
 * Synchronous DEK resolver for sync entry points (e.g. plugin `register()`
 * contracts that cannot await). Returns the same DEK as {@link getDek} for
 * non-passphrase modes; throws on passphrase mode (which requires an
 * interactive prompt that is inherently async).
 */
export function getDekSync(): Dek {
	if (cachedSyncDek) return cachedSyncDek;
	const buf = resolveDekSync();
	if (buf.length !== 32) {
		throw new WrongKeyError("resolved DEK has wrong length");
	}
	cachedSyncDek = asDek(buf);
	// Keep the async cache in sync so subsequent getDek() awaits resolve to
	// the same value without re-running resolution.
	const same = cachedSyncDek;
	dekPromise = Promise.resolve(same);
	return cachedSyncDek;
}

export async function _persistPlainKeyState(dek: Buffer): Promise<void> {
	const { keyFile } = resolveConfigPaths();
	await atomicReplaceSecretFile(
		keyFile,
		JSON.stringify(makePlainKeyState(dek)),
	);
}
