#!/usr/bin/env node
/**
 * Fixture for task 2.7. Calls into @snoai/sqlite-crypto using the production
 * test hooks (SNO_STATION_CORE_CRASH_AFTER, SNO_STATION_CORE_DB_PATH) and lets
 * the production code's SNO_STATION_CORE_CRASH_AFTER fault-injector terminate
 * the process at the named transition point. The key is passed as argv[2];
 * the manifest resolves from the inherited HOME.
 *
 * The actual crash hook is implemented inside the production package (M1
 * task 3.5/3.5.b). This fixture is intentionally trivial — its only job is
 * to exercise the same code path a real plugin would.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.SNO_STATION_CORE_DB_PATH;
const keyHex = process.argv[2];
if (!dbPath || !keyHex) {
	console.error("SNO_STATION_CORE_DB_PATH and a key argument must be set");
	process.exit(2);
}

mkdirSync(dirname(dbPath), { recursive: true });

const { getDek, openEncryptedDb } = await import("@snoai/sqlite-crypto");

const dek = getDek(keyHex);
const db = openEncryptedDb(dbPath, dek);
db.exec("CREATE TABLE IF NOT EXISTS payload (v TEXT)");
db.prepare("INSERT INTO payload (v) VALUES (?)").run("hello");
db.close();
process.exit(0);
