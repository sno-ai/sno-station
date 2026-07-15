#!/usr/bin/env node
/**
 * Fixture for task 2.7. Calls into @snoai/sno-station-core-crypto using the production
 * env hooks (XDG_CONFIG_HOME, SNO_STATION_CORE_KEYCHAIN_SERVICE, SNO_STATION_CORE_CRASH_AFTER, SNO_STATION_CORE_DB_PATH)
 * and lets the production code's SNO_STATION_CORE_CRASH_AFTER fault-injector terminate
 * the process at the named transition point.
 *
 * The actual crash hook is implemented inside the production package (M1
 * task 3.5/3.5.b). This fixture is intentionally trivial — its only job is
 * to exercise the same code path a real plugin would.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.SNO_STATION_CORE_DB_PATH;
if (!dbPath) {
	console.error("SNO_STATION_CORE_DB_PATH must be set");
	process.exit(2);
}

mkdirSync(dirname(dbPath), { recursive: true });

const { getDek, openEncryptedDb } = await import("@snoai/sno-station-core-crypto");

const dek = await getDek();
const db = openEncryptedDb(dbPath, dek);
db.exec("CREATE TABLE IF NOT EXISTS payload (v TEXT)");
db.prepare("INSERT INTO payload (v) VALUES (?)").run("hello");
db.close();
process.exit(0);
