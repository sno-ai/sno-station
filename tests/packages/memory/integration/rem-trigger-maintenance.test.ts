/** @file rem-trigger-maintenance.test.ts
 * @purpose Proves the existing maintenance timer serializes a slow automatic REM evaluation.
 * @boundary Real encrypted SQLite, timer, filesystem discovery/audit, and local HTTP request.
 * @acceptance ACC-1, ACC-25, ACC-42
 * @class integration
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRemTriggerStateAtomic } from "../../../../packages/sno-station-mem/src/sidecar/rem-trigger-state.ts";
import {
	MAINTENANCE_FIRST_TICK_DELAY_MS,
	startMaintenanceTimer,
} from "../../../../packages/sno-station-mem/src/store/maintenance.ts";
import type { MemoryStore } from "../../../../packages/sno-station-mem/src/store/memory-store-base.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("REM trigger maintenance timer", () => {
	let database: TestDb | undefined;
	let root: string | undefined;
	let server: Server | undefined;
	const priorEnvironment = {
		OPENCLAW_STATE_DIR: process.env["OPENCLAW_STATE_DIR"],
		SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
	};

	afterEach(async () => {
		vi.useRealTimers();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		database?.cleanup();
		if (root) rmSync(root, { recursive: true, force: true });
		restoreEnvironment("OPENCLAW_STATE_DIR", priorEnvironment.OPENCLAW_STATE_DIR);
		restoreEnvironment("SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR);
		database = undefined;
		root = undefined;
		server = undefined;
	});

	it("keeps a second tick out while the first dispatch confirmation is pending", async () => {
		vi.useFakeTimers({
			toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
		database = createTestDb();
		root = mkdtempSync(path.join(tmpdir(), "rem-maintenance-"));
		const stateRoot = path.join(root, "openclaw-state");
		const stateDir = path.join(stateRoot, "mem-claw");
		const profileRoot = path.join(root, "sno-profile");
		const backupDir = path.join(root, "backups");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(path.join(profileRoot, "station"), { recursive: true });
		process.env["OPENCLAW_STATE_DIR"] = stateRoot;
		process.env["SNO_PROFILE_DIR"] = profileRoot;
		writeFileSync(
			path.join(stateRoot, "openclaw.json"),
			JSON.stringify({
				plugins: {
					entries: {
						"sno-mem-claw": {
							config: {
								dbPath: database.dbPath,
								mode: "rem-enhanced",
								remOperations: ["rem-replace", "rem-update"],
							},
						},
					},
				},
			}),
			"utf8",
		);
		const scope = "persona:maintenance-overlap";
		const id = "maintenance-overlap-candidate";
		database.runtime.raw
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata,
					content_hash, fact_id, lane, raw_candidate_json
				) VALUES (?, ?, 'profile', ?, 0.8, 1, 'UTC', '{}', ?, ?, 'active', '{}')`,
			)
			.run(id, "The user studies serialized maintenance.", scope, createHash("sha256").update(id).digest("hex"), id);
		await writeRemTriggerStateAtomic(stateDir, {
			version: 1,
			scopes: {
				[scope]: {
					last_pass_at: "2026-08-11T12:00:00.000Z",
					schedule_zone: "UTC",
					last_covered_count: 1,
					last_volume_pass_date: null,
					attempts: { identity: null, count: 0 },
				},
			},
		});

		let requests = 0;
		let decisionExistedBeforeRequest = false;
		server = createServer((request) => {
			requests += 1;
			decisionExistedBeforeRequest = readFileSync(path.join(stateDir, "audit.jsonl"), "utf8").includes(
				'"event":"rem_trigger_evaluated"',
			);
			request.resume();
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("test server did not bind");
		writeFileSync(
			path.join(profileRoot, "station", "sidecar.json"),
			JSON.stringify({ pid: process.pid, port: address.port, token: "maintenance-token" }),
			"utf8",
		);

		const store = {
			closed: false,
			db: { $client: database.runtime.raw },
			hasFtsSupport: false,
			sqlite: database.runtime.db,
		} as unknown as MemoryStore;
		const timer = startMaintenanceTimer(
			{
				store,
				dbPath: database.dbPath,
				backupDir,
				stateDir,
				integrityCheck: () => undefined,
			},
			5,
		);
		await vi.advanceTimersByTimeAsync(MAINTENANCE_FIRST_TICK_DELAY_MS);
		await waitFor(() => requests === 1);
		await vi.advanceTimersByTimeAsync(50);

		expect(requests).toBe(1);
		expect(decisionExistedBeforeRequest).toBe(true);
		timer.stop();
		await vi.advanceTimersByTimeAsync(10_000);
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("maintenance request was not observed");
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
