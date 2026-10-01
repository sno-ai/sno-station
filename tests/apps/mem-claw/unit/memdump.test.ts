import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildMemdumpQuery,
	parseMemdumpOptions,
	serializeMemoryRow,
} from "../../../../packages/memory/src/engine/diagnostics/memdump.ts";
import { createTestDb } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const snoStationMemRoot = join(repoRoot, "apps/mem-claw");
const memdumpSource = join(repoRoot, "packages/memory/src/engine/diagnostics/memdump.ts");
const tsxBinary = join(repoRoot, "node_modules/.bin/tsx");

function runMemdump(args: string[]) {
	return spawnSync(tsxBinary, [memdumpSource, ...args], {
		cwd: snoStationMemRoot,
		env: { ...process.env },
		encoding: "utf8",
	});
}

describe("sno-memdump", () => {
	it("builds a parameterized query for the listed filters", () => {
		const options = parseMemdumpOptions([
			"--db",
			"/tmp/store.sqlite",
			"--scope",
			"research",
			"--id",
			"memory-1",
			"--grep",
			"update",
			"--limit",
			"2",
		]);

		expect(buildMemdumpQuery(options)).toEqual({
			sql: expect.stringContaining(
				"WHERE project_id = ? AND id = ? AND instr(text, ?) > 0 ORDER BY timestamp DESC, id DESC LIMIT 2",
			),
			params: ["research", "memory-1", "update"],
		});
	});

	it("reads tier from metadata and disposition reason from its row column", () => {
		expect(
			serializeMemoryRow({
				id: "memory-1",
				scope: "research",
				text: "The update landed.",
				category: "profile",
				timestamp: 123,
				timezone: "user",
				metadata: JSON.stringify({ tier: "core", disposition_reason: "wrong place" }),
				lane: "active",
				disposition_reason: "merged",
				dispositioned_at_ms: 456,
			}),
		).toMatchObject({
			tier: "core",
			timestamp: 123,
			timezone: "user",
			disposition_reason: "merged",
		});
	});

	it("emits the whole metadata object only when --metadata is asked for", () => {
		const row = {
			id: "memory-2",
			scope: "research",
			text: "The retirement landed.",
			category: "profile" as const,
			timestamp: 123,
			timezone: "user",
			metadata: JSON.stringify({
				tier: "core",
				l2_content: "The retirement landed.",
				retire_by_name_receipt: { retired: ["memory-1"] },
			}),
			lane: "active",
			disposition_reason: null,
			dispositioned_at_ms: null,
		};

		expect(serializeMemoryRow(row)).not.toHaveProperty("metadata");
		expect(serializeMemoryRow(row, true).metadata).toEqual({
			tier: "core",
			l2_content: "The retirement landed.",
			retire_by_name_receipt: { retired: ["memory-1"] },
		});
		expect(parseMemdumpOptions(["--db", "/tmp/store.sqlite", "--metadata"]).metadata).toBe(true);
		expect(parseMemdumpOptions(["--db", "/tmp/store.sqlite"]).metadata).toBeUndefined();
	});

	it("carries --metadata through the real command, and withholds it without the flag", () => {
		const fixture = createTestDb();
		try {
			writeSettingsFixture(resolve(fixture.dbPath, ".."), { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
			fixture.sqlite
				.prepare(
					"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'profile', ?, 0.7, ?, ?, ?, ?)",
				)
				.run(
					"019memdumpmetadataflag000001",
					"019memdumpmetadatafact000001",
					"The user retired their old editor preference.",
					"persona:researcher",
					1_786_147_200_000,
					"America/Los_Angeles",
					JSON.stringify({ tier: "core", retire_by_name_receipt: { retired: ["x"] } }),
					"memdump-metadata-flag-content-hash",
				);
			fixture.sqlite.pragma("wal_checkpoint(TRUNCATE)");

			const withFlag = runMemdump(["--db", fixture.dbPath, "--metadata"]);
			expect(withFlag.status, withFlag.stderr).toBe(0);
			expect(withFlag.stdout.trim().split("\n").map(line => JSON.parse(line))).toContainEqual(
				expect.objectContaining({
					metadata: expect.objectContaining({ retire_by_name_receipt: { retired: ["x"] } }),
				}),
			);

			const without = runMemdump(["--db", fixture.dbPath]);
			expect(without.status, without.stderr).toBe(0);
			for (const row of without.stdout.trim().split("\n").map(line => JSON.parse(line))) {
				expect(row).not.toHaveProperty("metadata");
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses a filter that was given an empty value", () => {
		expect(() => parseMemdumpOptions(["--db", "/tmp/store.sqlite", "--scope", ""])).toThrow(
			"--scope was given an empty value",
		);
	});


});
