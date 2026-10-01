/**
 * Phase 15: encryption-at-rest proof.
 *
 * Runs after the teach phase has written at least one row into the plugin DB.
 * Probes the on-disk SQLite file on the OpenClaw VM and asserts that:
 *   1. the file exists and is non-empty,
 *   2. its first 16 bytes are NOT the plaintext "SQLite format 3\0" magic
 *      header (which a SQLCipher-v4 page-encrypted file never carries), and
 *   3. opening it with a plain `node:sqlite` reader either fails outright or
 *      cannot read `sqlite_master` (SQLITE_NOTADB / "file is not a database"
 *      / "encrypted or is not a database").
 *
 * The recall phase (20) already proves the data is decrypt-readable through
 * the chokepoint, so the inverse — that on-disk bytes resist a plaintext
 * reader — is the missing acceptance signal for the AES-256 / SQLCipher
 * deployment landed by PR #87.
 */

import { describe, expect, test } from "vitest";
import { writeJsonArtifact } from "./helpers/artifacts";
import { runRequiredCommand } from "./helpers/command";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";
import { parseJson } from "./helpers/json";
import { loadAgentRun } from "./helpers/state";

assertLiveAgentE2EEnabled();

interface EncryptedStorageProbe {
	dbPath: string;
	fileExists: boolean;
	fileSize: number;
	headerBase64: string;
	headerIsPlainSqlite: boolean;
	plainOpenSucceeded: boolean;
	plainSelectSucceeded: boolean;
	errorCode: string | null;
	errorMessage: string | null;
}

const SQLITE_MAGIC_BASE64 = Buffer.from("SQLite format 3\0", "binary").toString(
	"base64",
);

describe("Agent 1:1 phase 15 encrypted storage at rest", () => {
	test(
		"plain SQLite cannot read the plugin DB — proves SQLCipher v4 is applied at the chokepoint",
		async () => {
			const { config } = await loadAgentRun();
			const dbPath = config.remoteDbPath;
			const probeScript = `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const path = ${JSON.stringify(dbPath)};
const result = {
  dbPath: path,
  fileExists: fs.existsSync(path),
  fileSize: 0,
  headerBase64: "",
  headerIsPlainSqlite: false,
  plainOpenSucceeded: false,
  plainSelectSucceeded: false,
  errorCode: null,
  errorMessage: null,
};
if (result.fileExists) {
  const stat = fs.statSync(path);
  result.fileSize = stat.size;
  if (stat.size >= 16) {
    const fd = fs.openSync(path, "r");
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      result.headerBase64 = head.toString("base64");
      result.headerIsPlainSqlite =
        result.headerBase64 === ${JSON.stringify(SQLITE_MAGIC_BASE64)};
    } finally {
      fs.closeSync(fd);
    }
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    result.plainOpenSucceeded = true;
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    result.plainSelectSucceeded = true;
  } catch (err) {
    result.errorCode = err && err.code ? String(err.code) : null;
    result.errorMessage = err && err.message ? String(err.message) : String(err);
  } finally {
    if (db) {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }
}
console.log(JSON.stringify(result));
`;
			const sshResult = await runRequiredCommand(
				"ssh",
				[config.openClawVm, "node --experimental-sqlite --no-warnings"],
				{ input: probeScript, timeoutMs: 30_000 },
			);
			const probe = parseJson(sshResult.stdout) as EncryptedStorageProbe;
			await writeJsonArtifact(config, "encrypted-storage-probe.json", probe);

			expect(
				probe.fileExists,
				`plugin DB missing on VM at ${probe.dbPath}`,
			).toBe(true);
			expect(
				probe.fileSize,
				`plugin DB at ${probe.dbPath} is empty (size=${probe.fileSize})`,
			).toBeGreaterThan(0);
			expect(
				probe.headerIsPlainSqlite,
				`plugin DB header on disk is the plaintext "SQLite format 3" magic — encryption is NOT applied (header b64=${probe.headerBase64})`,
			).toBe(false);
			expect(
				probe.plainSelectSucceeded,
				`plain node:sqlite was able to read sqlite_master from ${probe.dbPath} — DB is plaintext, encryption is NOT applied`,
			).toBe(false);
			expect(
				`${probe.errorCode ?? ""} ${probe.errorMessage ?? ""}`,
				`plain-SQLite probe of ${probe.dbPath} did not return an encryption-shaped error (code=${probe.errorCode}, message=${probe.errorMessage})`,
			).toMatch(/SQLITE_NOTADB|file is (not a|encrypted)|encrypted or is not/i);
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 60_000),
	);
});
