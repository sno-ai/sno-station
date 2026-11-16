/** Real store, real SQLite, real embedder. No mocking. */

/**
 * The one-off cleanup over a store written before the content hash identified content.
 *
 * The rows planted here are the three shapes the 2026-08-29 store census found on a real
 * 127-row store: one sentence held two or three times under distinct planted hashes, one of
 * our own extraction prompts stored as if it were a memory, and a row that names a successor
 * but was never marked invalid so recall still serves it as current.
 */

import { createHash } from "node:crypto";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readSettings } from "../../../../packages/memory/src/contract/profile";
import { runPrecisionNightly } from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { getSnoStationMemStateDir } from "../../../../packages/memory/src/contract/profile";
import { installRemSchema } from "../../../../packages/memory/src/engine/rem/index";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { cleanStore } from "../../../../packages/memory/src/store/store-cleanup-cli";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;
const SCOPE = "global";
const DUPLICATE_TEXT = "For Project Prism the handoff code is PRISM-7741.";
const PROMPT_TEXT =
	"user: You are a memory extraction assistant. Always respond with valid JSON only.\n" +
	"<<<BEGIN_UNTRUSTED[01de3248-62fa-4c06-b715-e0a43510f157]:USER>>>\nUser\n" +
	"<<<END_UNTRUSTED[01de3248-62fa-4c06-b715-e0a43510f157]:USER>>>";

interface Planted {
	id: string;
	text: string;
	hash: string;
	metadata: Record<string, unknown>;
	timestamp: number;
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store cleanup over a store written under the old content hash", () => {
	let fixture: ReturnType<typeof createTestDb>;
	let store: MemoryStore;

	const plant = (row: Planted): void => {
		(
			fixture.runtime.db as unknown as {
				prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
			}
		)
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
				) VALUES (?, ?, 'episodic', ?, 0.7, ?, 'UTC', ?, ?, ?)`,
			)
			.run(
				row.id,
				row.text,
				SCOPE,
				row.timestamp,
				JSON.stringify(row.metadata),
				row.hash,
				`fact-${row.id}`,
			);
	};

	const readRows = (): Array<{ id: string; text: string; metadata: string; content_hash: string }> =>
		(
			fixture.runtime.db as unknown as {
				prepare: (sql: string) => { all: (...p: unknown[]) => unknown };
			}
		)
			.prepare("SELECT id, text, metadata, content_hash FROM nodix_memories ORDER BY id")
			.all() as Array<{ id: string; text: string; metadata: string; content_hash: string }>;


	function precisionReply(request: { callId?: string; prompt: string }): object | undefined {
		if (request.callId === "E13") return { mode: "work" };
		if (request.callId === "E23") {
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			return data.operation === "admission deletion"
				? { rows: data.rows.map((row: { id: string }) => ({ id: row.id, confirmed: true })) }
				: { confirmed: true };
		}
		if (request.callId === "E21") {
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			return { facts: data.facts.map((fact: { index: number; rows: Array<{ id: string }> }) => ({
				index: fact.index, rows: fact.rows.map(row => ({ id: row.id, relation: "unrelated" })),
			})) };
		}
		return undefined;
	}

	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(1_794_729_600_000);
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
		vi.restoreAllMocks();
	});

	it("collapses copies, drops a stored prompt, and stamps a superseded row", async () => {
		plant({ id: "copy-a", text: DUPLICATE_TEXT, hash: "a".repeat(64), metadata: {}, timestamp: 1000 });
		plant({ id: "copy-b", text: DUPLICATE_TEXT, hash: "b".repeat(64), metadata: {}, timestamp: 2000 });
		plant({ id: "copy-c", text: DUPLICATE_TEXT, hash: "c".repeat(64), metadata: {}, timestamp: 3000 });
		plant({ id: "prompt-row", text: PROMPT_TEXT, hash: "d".repeat(64), metadata: {}, timestamp: 4000 });
		plant({
			id: "old-position",
			text: "The user's favourite band is Death Cab for Cutie.",
			hash: "e".repeat(64),
			metadata: { superseded_by: "new-position" },
			timestamp: 5000,
		});
		plant({
			id: "new-position",
			text: "The user's favourite band is Big Thief.",
			hash: "f".repeat(64),
			metadata: {},
			timestamp: 6000,
		});
		plant({
			id: "points-at-a-copy",
			text: "An unrelated note that still points at a copy.",
			hash: "0".repeat(64),
			metadata: { superseded_by: "copy-c" },
			timestamp: 7000,
		});

		const result = await cleanStore(store, { apply: true, label: "test store" });
		const rows = readRows();
		for (const row of rows) {
			console.log(`  ${row.id} ${JSON.stringify(row.text.slice(0, 60))} ${row.metadata}`);
		}

		expect(result.promptRows).toBe(1);
		expect(result.redundantCopies).toBe(2);
		expect(rows.map((row) => row.id)).toEqual([
			"copy-a",
			"new-position",
			"old-position",
			"points-at-a-copy",
		]);
		const stamped = rows.find((row) => row.id === "old-position");
		expect(JSON.parse(stamped?.metadata ?? "{}").invalidated_at).toBe(6000);
		const repointed = rows.find((row) => row.id === "points-at-a-copy");
		expect(JSON.parse(repointed?.metadata ?? "{}").superseded_by).toBe("copy-a");
	});

	it("writes nothing without --apply", async () => {
		plant({ id: "copy-a", text: DUPLICATE_TEXT, hash: "a".repeat(64), metadata: {}, timestamp: 1000 });
		plant({ id: "copy-b", text: DUPLICATE_TEXT, hash: "b".repeat(64), metadata: {}, timestamp: 2000 });

		const before = readRows();
		const result = await cleanStore(store, { apply: false, label: "test store" });
		expect(result.redundantCopies).toBe(1);
		expect(readRows()).toEqual(before);
	});
	it("runs precision work from the daily REM entry and writes file judgments and conflicts", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		plant({ id: "nightly-rule", text: "The owner requires concise reports.", hash: "1".repeat(64), timestamp: 1, metadata: { writer_agent_id: "codex" } });
		plant({ id: "nightly-activity", text: "The tests completed successfully.", hash: "2".repeat(64), timestamp: 2, metadata: { writer_agent_id: "codex" } });
		plant({ id: "nightly-asserted", text: "The project needs verbose reports.", hash: "3".repeat(64), timestamp: 3, metadata: { writer_agent_id: "codex", precision_kind: "rule", asserted_by: "assistant" } });
		const file = join(profile, "AGENTS.md");
		await writeFile(file, "Use detailed reports. This suffix was not loaded.");
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'global', '', ?, 1)")
			.run(JSON.stringify([{ path: file, bytes: 21, sha256: createHash("sha256").update("Use detailed reports.").digest("hex") }]));
		const settings = readSettings();
		await runPrecisionNightly({ settings, waveId: "nightly-no-model" });
		expect(readRows()).toHaveLength(3);
		let admissionVote = 0;
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			if (Array.isArray(data) && /["']ids["']/.test(request.prompt)) {
				return { kind: "ok" as const, text: JSON.stringify({ ids: data.map((row: { id: string }) => row.id) }) };
			}
			if (Array.isArray(data) && /\bcore\b/.test(request.prompt) && /\btopic\b/.test(request.prompt) && /\bdrop\b/.test(request.prompt)) {
				return { kind: "ok" as const, text: JSON.stringify({ rows: data.map((row: { id: string }) => ({ id: row.id, label: "core" })) }) };
			}
			if (request.callId === "E16") admissionVote += 1;
			let answer: object;
			if (Array.isArray(data)) answer = { rows: data.map((row: { id: string }) => (row.id === "nightly-asserted" || (row.id !== "nightly-activity") !== (admissionVote === 2))
				? { id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: true }
				: { id: row.id, verdict: "delete", reason: "activity record" }) };
			else answer = { rows: data.rows.map((row: { id: string }) => data.files
				? { id: row.id, quote: "Use detailed reports.", verdict: "opposite" } : { id: row.id, scope: "general" }) };
			return { kind: "ok" as const, text: JSON.stringify(answer) };
		} };
		await runPrecisionNightly({ settings, agentPort, waveId: "nightly-with-model" });

		expect(readRows().map(row => row.id)).toEqual(["nightly-asserted", "nightly-rule"]);
		expect(JSON.parse(store.getById("nightly-rule")?.metadata ?? "{}")).toMatchObject({ precision_kind: "rule", precision_judged: true });
		expect(fixture.runtime.db.prepare("SELECT memory_id, verdict FROM nodix_loaded_file_judgments").all())
			.toEqual([{ memory_id: "nightly-rule", verdict: "opposite" }]);
		const report = await readFile(join(profile, "sno-station-mem", "memory-loaded-file-conflicts.md"), "utf8");
		expect(report).toContain("nightly-rule");
		expect(report).toContain("The owner requires concise reports.");
		expect(report).toContain("AGENTS.md");
		const backup = fixture.runtime.db.prepare("SELECT payload FROM nodix_memory_migration_markers WHERE name = 'memory-precision-backup'").get() as { payload: string };
		expect(JSON.parse(backup.payload).rows).toBe(3);
		await runPrecisionNightly({ settings, agentPort, waveId: "nightly-second-project" });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_loaded_file_judgments").get()).toEqual({ rows: 1 });
		expect(JSON.parse(store.getById("nightly-asserted")?.metadata ?? "{}")).toMatchObject({
			precision_kind: "rule", asserted_by: "assistant", precision_judged: true,
		});
	});

	it("judges already-labelled rows under the current admission text while host ordering and file checks continue", async () => {
		const profile = dirname(fixture.dbPath);
		installRemSchema(fixture.runtime.db);
		plant({ id: "host-rule", text: "The owner requires concise reports.", hash: "a".repeat(64), timestamp: 1,
			metadata: { writer_agent_id: "codex", precision_kind: "rule", start_label: "core" } });
		plant({ id: "needs-label", text: "The owner requires English comments.", hash: "b".repeat(64), timestamp: 2,
			metadata: { writer_agent_id: "codex", precision_kind: "rule" } });
		const file = join(profile, "AGENTS.md");
		await writeFile(file, "Use short reports.");
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'global', '', ?, 1)")
			.run(JSON.stringify([{ path: file, bytes: 18, sha256: createHash("sha256").update("Use short reports.").digest("hex") }]));
		let rejectReadmission = false;
		const agentPort = { async complete({ prompt, callId }: { prompt: string; callId?: string }) {
			if (callId === "E23") return { kind: "ok" as const, text: '{"confirmed":true}' };
			if (callId === "E16") return { kind: "ok" as const, text: JSON.stringify({ rows: rejectReadmission ? [
				{ id: "host-rule", verdict: "delete", reason: "activity record" },
				{ id: "needs-label", verdict: "delete", reason: "activity record" },
			] : [
				{ id: "host-rule", verdict: "keep", kind: "rule", origin: "owner", about_user: false },
				{ id: "needs-label", verdict: "keep", kind: "rule", origin: "owner", about_user: false },
			] }) };
			const precision = precisionReply({ prompt, callId });
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
			if (prompt.includes("You choose what a coding agent is told at the start of every working session")) {
				return { kind: "ok" as const, text: '{"rows":[{"id":"needs-label","label":"topic"}]}' };
			}
			if (prompt.includes("These are lasting rules")) {
				return { kind: "ok" as const, text: '{"ids":["host-rule"]}' };
			}
			if (data.files) {
				return { kind: "ok" as const, text: '{"rows":[{"id":"host-rule","quote":"Use short reports.","verdict":"said"}]}' };
			}
			if (data.rule) {
				return { kind: "ok" as const, text: '{"verdict":"covered"}' };
			}
			return { kind: "ok" as const, text: '{"rows":[]}' };
		} };
		writeSettingsFixture(profile, { mode: "rem-enhanced", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		await runPrecisionNightly({ settings: readSettings(), agentPort,
			waveId: "nightly-host-precision" });
		expect.soft(fixture.runtime.db.prepare("SELECT id, json_extract(metadata, '$.precision_judged') AS judged, json_type(metadata, '$.precision_admission') AS admission FROM nodix_memories ORDER BY id").all())
			.toEqual([{ id: "host-rule", judged: 1, admission: "text" }, { id: "needs-label", judged: 1, admission: "text" }]);
		expect.soft(JSON.parse(store.getById("needs-label")?.metadata ?? "{}")).toMatchObject({ start_label: "topic" });
		expect.soft(JSON.parse(store.getById("host-rule")?.metadata ?? "{}")).toMatchObject({ start_label: "core", start_rank: 1 });
		expect.soft(fixture.runtime.db.prepare("SELECT memory_id, verdict FROM nodix_loaded_file_judgments ORDER BY memory_id").all())
			.toEqual([{ memory_id: "host-rule", verdict: "said" }]);
		rejectReadmission = true;
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		await runPrecisionNightly({ settings: readSettings(), agentPort,
			waveId: "nightly-host-admitted" });
		expect.soft(readRows().map(row => row.id)).toEqual(["host-rule", "needs-label"]);
	});

	it.each(["object", "loaded-file"])("applies nightly object admission and %s file replies without moving project rows", async arrayPath => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		plant({ id: "array-project", text: "The owner requires English comments in this project.", hash: "a".repeat(64), timestamp: 1, metadata: { writer_agent_id: "codex" } });
		plant({ id: "array-general", text: "The owner requires concise reports.", hash: "b".repeat(64), timestamp: 2, metadata: { writer_agent_id: "codex" } });
		plant({ id: "array-activity", text: "The tests completed successfully.", hash: "c".repeat(64), timestamp: 3, metadata: { writer_agent_id: "codex" } });
		fixture.runtime.db.prepare("UPDATE nodix_memories SET project_id = 'work-project'").run();
		const file = join(profile, "AGENTS.md");
		await writeFile(file, "Use short reports.");
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'work-project', '', ?, 1)")
			.run(JSON.stringify([{ path: file, bytes: 18, sha256: createHash("sha256").update("Use short reports.").digest("hex") }]));
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			if (request.callId === "E19") return { kind: "ok" as const, text: JSON.stringify({ rows: data.map((row: { id: string }) => ({ id: row.id, label: "topic" })) }) };
			if (request.callId === "E20") return { kind: "ok" as const, text: '{"ids":[]}' };
			if (data.rule) return { kind: "ok" as const, text: '{"verdict":"covered"}' };
			const path = Array.isArray(data) ? "cleanup" : data.files ? "loaded-file" : "scope";
			const rows = path === "cleanup" ? data.map((row: { id: string }) => row.id === "array-activity"
				? { id: row.id, verdict: "delete", reason: "activity record" }
				: { id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: true })
				: data.rows.map((row: { id: string }) => path === "scope"
					? { id: row.id, scope: row.id === "array-project" ? "project" : "general" }
					: { id: row.id, quote: row.id === "array-project" ? "" : "Use short reports.", verdict: row.id === "array-project" ? "not-said" : "said" });
			return { kind: "ok" as const, text: arrayPath === path ? "```json\n" + JSON.stringify(rows) + "\n```" : JSON.stringify({ rows }) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-array" });
		expect(fixture.runtime.db.prepare("SELECT id, project_id, json_extract(metadata, '$.precision_kind') AS kind, json_extract(metadata, '$.precision_judged') AS judged FROM nodix_memories ORDER BY id").all()).toEqual([
			{ id: "array-general", project_id: "work-project", kind: "rule", judged: 1 },
			{ id: "array-project", project_id: "work-project", kind: "rule", judged: 1 },
		]);
		expect(fixture.runtime.db.prepare("SELECT memory_id, verdict FROM nodix_loaded_file_judgments ORDER BY memory_id").all()).toEqual([
			{ memory_id: "array-general", verdict: "said" }, { memory_id: "array-project", verdict: "not-said" },
		]);
	});

	it("shares one nightly budget across place checks and three-vote admission batches", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		for (let index = 0; index < 2000; index += 1) {
			plant({ id: `budget-rule-${index}`, text: `The owner requires report detail ${index}.`, timestamp: index,
				hash: createHash("sha256").update(String(index)).digest("hex"), metadata: { writer_agent_id: "codex" } });
		}
		fixture.runtime.db.prepare("UPDATE nodix_memories SET project_id = CASE WHEN timestamp < 1000 THEN 'first-project' ELSE 'second-project' END").run();
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			const answer = Array.isArray(data) ? { rows: data.map((row: { id: string }) => ({ id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: true })) }
				: data.place ? { mode: "work" } : { rows: data.rows.map((row: { id: string }) => ({ id: row.id, scope: "project" })) };
			return { kind: "ok" as const, text: JSON.stringify(answer) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-budget" });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_judged') = 1").get()).toEqual({ rows: 1280 });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_kind') IS NULL").get()).toEqual({ rows: 720 });
		expect(fixture.runtime.db.prepare("SELECT project_id, count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_judged') = 1 GROUP BY project_id ORDER BY project_id").all()).toEqual([
			{ project_id: "first-project", rows: 1000 }, { project_id: "second-project", rows: 280 },
		]);
		expect(readRows()).toHaveLength(2000);
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_type(metadata, '$.precision_admission') = 'text'").get()).toEqual({ rows: 1280 });
		expect(fixture.runtime.db.prepare("SELECT json_extract(payload, '$.since') AS since FROM nodix_memory_migration_markers WHERE name = 'memory-precision-last-night'").get()).toEqual({ since: 0 });
	});

	it("nightly backup: two successful nights retain only the newer snapshot and remove old side files", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		const agentPort = { async complete() { throw new Error("Empty store must not call a model"); } };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "backup-retention-first" });
		const stateDir = getSnoStationMemStateDir();
		const first = (await readdir(stateDir)).filter(name => name.startsWith("precision-before-cleanup-") && name.endsWith(".sqlite"));
		expect(first).toHaveLength(1);
		for (const suffix of ["-wal", "-shm", "-journal"]) await writeFile(join(stateDir, `${first[0]}${suffix}`), "old side file");
		await writeFile(join(stateDir, "sno-station-mem-unrelated.sqlite"), "ordinary backup remains");
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "backup-retention-second" });
		const backup = fixture.runtime.db.prepare("SELECT payload FROM nodix_memory_migration_markers WHERE name = 'memory-precision-backup'").get() as { payload: string };
		const newest = JSON.parse(backup.payload).path as string;
		expect.soft(newest).not.toBe(join(stateDir, first[0] ?? ""));
		expect.soft((await readdir(stateDir)).filter(name => name.startsWith("precision-before-cleanup-")).sort())
			.toEqual([newest.slice(stateDir.length + 1)]);
		expect.soft(await readFile(join(stateDir, "sno-station-mem-unrelated.sqlite"), "utf8")).toBe("ordinary backup remains");
	});

	it("nightly backup: a failed new snapshot preserves all previous backup files and memory rows", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		const agentPort = { async complete() { throw new Error("Failed backup must not call a model"); } };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "backup-failed-prior" });
		const stateDir = getSnoStationMemStateDir();
		const names = (await readdir(stateDir)).filter(name => name.startsWith("precision-before-cleanup-"));
		expect(names).toHaveLength(1);
		const priorPath = join(stateDir, names[0] ?? "");
		await writeFile(`${priorPath}-wal`, "old side file");
		const priorBytes = await readFile(priorPath);
		plant({ id: "backup-unmodified", text: "The owner requires concise service reports.",
			timestamp: 1_794_556_800_000, hash: "9".repeat(64), metadata: { writer_agent_id: "codex" } });
		const rows = readRows();
		vi.mocked(Date.now).mockReturnValue(1_794_816_000_000);
		await chmod(stateDir, 0o500);
		try { await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "backup-failed-next" }); }
		finally { await chmod(stateDir, 0o700); }
		expect.soft((await readdir(stateDir)).filter(name => name.startsWith("precision-before-cleanup-")).sort())
			.toEqual([names[0], `${names[0]}-wal`].sort());
		expect.soft(await readFile(priorPath)).toEqual(priorBytes);
		expect.soft(await readFile(`${priorPath}-wal`, "utf8")).toBe("old side file");
		expect.soft(readRows()).toEqual(rows);
		expect.soft(fixture.runtime.db.prepare(`SELECT stage, outcome FROM nodix_rem_journal
			WHERE job_id = 'backup-failed-next' AND outcome = 'failed'`).all()).toEqual([{ stage: "backup", outcome: "failed" }]);
	});

	it("compares admitted project rules with loaded files and removes a confirmed obsolete commitment", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		const now = Date.now();
		plant({ id: "loaded-rule", text: "The owner requires a release documentation review.", hash: "4".repeat(64), timestamp: now,
			metadata: { precision_kind: "rule", writer_agent_id: "codex", start_label: "core", start_rank: 1 } });
		for (let index = 0; index < 9; index += 1) {
			plant({ id: `loaded-rule-${index}`, text: `The owner requires release check ${index}.`,
				hash: createHash("sha256").update(`rule-${index}`).digest("hex"), timestamp: now - index - 1,
				metadata: { precision_kind: "rule", writer_agent_id: "codex", start_label: "core", start_rank: index + 2 } });
		}
		plant({ id: "loaded-commitment", text: "The owner still owes the release documentation.", hash: "5".repeat(64), timestamp: now + 1,
			metadata: { precision_kind: "commitment", writer_agent_id: "codex" } });
		fixture.runtime.db.prepare("UPDATE nodix_memories SET project_id = 'work-project'").run();
		const file = join(profile, "AGENTS.md");
		await writeFile(file, "The owner requires a release documentation review.");
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'work-project', '', ?, 1)")
			.run(JSON.stringify([{ path: file, bytes: 50, sha256: createHash("sha256").update("The owner requires a release documentation review.").digest("hex") }]));
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			if (request.callId === "E16") return { kind: "ok" as const, text: JSON.stringify({ rows: data.map((row: { id: string }) =>
				row.id === "loaded-commitment" ? { id: row.id, verdict: "delete", reason: "not one of the kinds" }
					: { id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: false }) }) };
			if (request.callId === "E20") return { kind: "ok" as const, text: JSON.stringify({ ids: data.map((row: { id: string }) => row.id) }) };
			const answer = data.rule ? { verdict: "covered" } : { rows: data.rows.map((row: { id: string }) => ({
				id: row.id, quote: row.id === "loaded-rule" ? "The owner requires a release documentation review." : "",
				verdict: row.id === "loaded-rule" ? "said" : "not-said",
			})) };
			return { kind: "ok" as const, text: JSON.stringify(answer) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-rule" });
		expect(fixture.runtime.db.prepare("SELECT verdict FROM nodix_loaded_file_judgments WHERE memory_id = 'loaded-rule'").get())
			.toEqual({ verdict: "said" });
		expect.soft(fixture.runtime.db.prepare("SELECT verdict FROM nodix_loaded_file_judgments WHERE memory_id = 'loaded-commitment'").all()).toEqual([]);
		expect.soft(store.getById("loaded-commitment")).toBeUndefined();
		expect(fixture.runtime.db.prepare("SELECT memory_id, verdict FROM nodix_loaded_file_judgments ORDER BY memory_id").all()).toEqual([
			{ memory_id: "loaded-rule", verdict: "said" },
			{ memory_id: "loaded-rule-0", verdict: "not-said" }, { memory_id: "loaded-rule-1", verdict: "not-said" },
			{ memory_id: "loaded-rule-2", verdict: "not-said" }, { memory_id: "loaded-rule-3", verdict: "not-said" },
			{ memory_id: "loaded-rule-4", verdict: "not-said" }, { memory_id: "loaded-rule-5", verdict: "not-said" },
			{ memory_id: "loaded-rule-6", verdict: "not-said" }, { memory_id: "loaded-rule-7", verdict: "not-said" },
			{ memory_id: "loaded-rule-8", verdict: "not-said" },
		]);
	});

	it("uses the remaining whole-night budget for file checks and skips cached, changed and missing files", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		plant({ id: "loaded-rule", text: "The owner requires concise reports.", hash: "4".repeat(64), timestamp: 1, metadata: { precision_kind: "rule", writer_agent_id: "codex", start_label: "topic" } });
		const sha256 = createHash("sha256").update("Use short reports.").digest("hex");
		const changed = join(profile, "changed.md");
		await writeFile(changed, "The bytes changed.");
		for (let index = 0; index < 52; index += 1) {
			const file = join(profile, `loaded-${index}.md`);
			await writeFile(file, "Use short reports.");
			const files = [{ path: file, bytes: 18, sha256 }];
			if (index === 0) files.unshift({ path: changed, bytes: 18, sha256 }, { path: join(profile, "missing.md"), bytes: 18, sha256 });
			fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'global', ?, ?, 1)")
				.run(`place-${String(index).padStart(2, "0")}`, JSON.stringify(files));
		}
		fixture.runtime.db.prepare("INSERT INTO nodix_loaded_file_judgments(memory_id, memory_content_hash, file_path, file_sha256, verdict, judged_at) VALUES ('loaded-rule', ?, ?, ?, 'said', 1)")
			.run("4".repeat(64), join(profile, "loaded-0.md"), sha256);
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			if (request.prompt.includes("You choose what a coding agent is told at the start of every working session")) {
				return { kind: "ok" as const, text: '{"rows":[]}' };
			}
			if (request.prompt.includes("These are lasting rules")) return { kind: "ok" as const, text: '{"ids":[]}' };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			if (request.callId === "E16") return { kind: "ok" as const, text: JSON.stringify({ rows: data.map((row: { id: string }) => ({
				id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: false,
			})) }) };
			return { kind: "ok" as const, text: JSON.stringify(data.rule ? { verdict: "covered" }
				: { rows: data.rows.map((row: { id: string }) => ({ id: row.id, quote: "Use short reports.", verdict: "said" })) }) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-loaded-budget" });
		expect.soft(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_loaded_file_judgments").get()).toEqual({ rows: 33 });
		expect(fixture.runtime.db.prepare("SELECT judged_at FROM nodix_loaded_file_judgments WHERE file_path = ?").get(join(profile, "loaded-0.md"))).toEqual({ judged_at: 1 });
		expect.soft(fixture.runtime.db.prepare("SELECT verdict FROM nodix_loaded_file_judgments WHERE file_path = ?").get(join(profile, "loaded-32.md"))).toEqual({ verdict: "said" });
		expect.soft(fixture.runtime.db.prepare("SELECT verdict FROM nodix_loaded_file_judgments WHERE file_path IN (?, ?, ?, ?)").all(changed, join(profile, "missing.md"), join(profile, "loaded-33.md"), join(profile, "loaded-51.md"))).toEqual([]);
	});

	it("preserves admission and file judgments when the nightly backup fails", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		plant({ id: "backup-keep", text: "The project uses WAL mode.", hash: "5".repeat(64), timestamp: 1, metadata: { writer_agent_id: "codex" } });
		plant({ id: "backup-delete", text: "The tests completed.", hash: "6".repeat(64), timestamp: 2, metadata: { writer_agent_id: "codex" } });
		plant({ id: "backup-rule", text: "The owner requires concise reports.", hash: "7".repeat(64), timestamp: 3, metadata: { writer_agent_id: "codex", precision_kind: "rule" } });
		await writeFile(join(profile, "sno-station-mem"), "Block the backup directory with a file.");
		const file = join(profile, "loaded.md");
		await writeFile(file, "Use short reports.");
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'global', '', ?, 1)")
			.run(JSON.stringify([{ path: file, bytes: 18, sha256: createHash("sha256").update("Use short reports.").digest("hex") }]));
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			if (request.prompt.includes("You choose what a coding agent is told at the start of every working session")) {
				return { kind: "ok" as const, text: '{"rows":[]}' };
			}
			if (request.prompt.includes("These are lasting rules")) return { kind: "ok" as const, text: '{"ids":[]}' };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			const answer = Array.isArray(data) ? { rows: data.map((row: { id: string }) => row.id === "backup-keep"
				? { id: row.id, verdict: "keep", kind: "fact", origin: "assistant", about_user: false }
				: row.id === "backup-rule" ? { id: row.id, verdict: "keep", kind: "rule", origin: "owner", about_user: false }
					: { id: row.id, verdict: "delete", reason: "activity record" }) }
				: { rows: data.rows.map((row: { id: string }) => ({ id: row.id, quote: "", verdict: "not-said" })) };
			return { kind: "ok" as const, text: JSON.stringify(answer) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-backup-failure" });
		expect(readRows()).toHaveLength(3);
		expect.soft(JSON.parse(store.getById("backup-keep")?.metadata ?? "{}")).toEqual({ writer_agent_id: "codex" });
		expect.soft(JSON.parse(store.getById("backup-delete")?.metadata ?? "{}")).toEqual({ writer_agent_id: "codex" });
		expect(JSON.parse(store.getById("backup-delete")?.metadata ?? "{}")).not.toHaveProperty("precision_admission");
		expect(fixture.runtime.db.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name = 'memory-precision-backup'").get()).toBeUndefined();
		expect.soft(fixture.runtime.db.prepare("SELECT memory_id, verdict FROM nodix_loaded_file_judgments").all()).toEqual([]);
	});

	it("leaves failed cleanup rows and file answers unjudged while independent answers succeed", async () => {
		const profile = dirname(fixture.dbPath);
		writeSettingsFixture(profile, { store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey } });
		installRemSchema(fixture.runtime.db);
		for (let index = 0; index < 41; index += 1) {
			plant({ id: `failure-row-${index}`, text: `The project has durable fact ${index}.`, timestamp: index,
				hash: createHash("sha256").update(String(index)).digest("hex"), metadata: { writer_agent_id: "codex" } });
		}
		plant({ id: "file-row-a", text: "The owner requires short reports.", hash: "8".repeat(64), timestamp: 42, metadata: { precision_kind: "rule", writer_agent_id: "codex" } });
		plant({ id: "file-row-b", text: "The owner works in UTC.", hash: "9".repeat(64), timestamp: 43, metadata: { precision_kind: "person", writer_agent_id: "codex" } });
		const files = [];
		for (const name of ["accepted.md", "rejected.md"]) {
			const file = join(profile, name);
			await writeFile(file, "Use short reports. Work in UTC.");
			files.push({ path: file, bytes: 31, sha256: createHash("sha256").update("Use short reports. Work in UTC.").digest("hex") });
		}
		fixture.runtime.db.prepare("INSERT INTO nodix_place_loaded_files(skin_id, project_id, surface, files, updated_at) VALUES ('codex', 'global', '', ?, 1)").run(JSON.stringify(files));
		fixture.runtime.db.exec("CREATE TRIGGER reject_file_batch BEFORE INSERT ON nodix_loaded_file_judgments WHEN new.memory_id = 'file-row-a' AND new.file_path LIKE '%/rejected.md' BEGIN SELECT RAISE(FAIL, 'fixture judgment write failed'); END");
		const agentPort = { async complete(request: { prompt: string; callId?: string }) {
			const precision = precisionReply(request);
			if (precision !== undefined) return { kind: "ok" as const, text: JSON.stringify(precision) };
			if (request.prompt.includes("You choose what a coding agent is told at the start of every working session")) {
				return { kind: "ok" as const, text: '{"rows":[]}' };
			}
			if (request.prompt.includes("These are lasting rules")) return { kind: "ok" as const, text: '{"ids":[]}' };
			const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1));
			if (data.rule) return { kind: "ok" as const, text: '{"verdict":"covered"}' };
			const answer = Array.isArray(data) ? data.some((row: { id: string }) => row.id === "failure-row-0") ? { rows: [] }
				: { rows: data.map((row: { id: string }) => ({ id: row.id, verdict: "keep", kind: row.id === "file-row-a" ? "rule" : row.id === "file-row-b" ? "person" : "fact", origin: row.id.startsWith("file-row-") ? "owner" : "assistant", about_user: false })) }
				: { rows: data.rows.map((row: { id: string }) => ({ id: row.id,
					quote: row.id === "file-row-a" ? "Use short reports." : row.id === "file-row-b" ? "Work in UTC." : "",
					verdict: row.id.startsWith("file-row-") ? "said" : "not-said" })) };
			return { kind: "ok" as const, text: JSON.stringify(answer) };
		} };
		await runPrecisionNightly({ settings: readSettings(), agentPort, waveId: "nightly-batch-failure" });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_memories WHERE json_extract(metadata, '$.precision_judged') = 1").get()).toEqual({ rows: 3 });
		expect.soft(JSON.parse(store.getById("failure-row-0")?.metadata ?? "{}")).toMatchObject({ writer_agent_id: "codex",
			precision_night: { at: 1_794_729_600_000, text: "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9" } });
		expect(JSON.parse(store.getById("failure-row-0")?.metadata ?? "{}")).not.toHaveProperty("precision_admission");
		expect(JSON.parse(store.getById("failure-row-40")?.metadata ?? "{}")).toMatchObject({ precision_kind: "fact", asserted_by: "assistant", precision_judged: true });
		expect(fixture.runtime.db.prepare("SELECT count(*) AS rows FROM nodix_loaded_file_judgments WHERE file_path LIKE '%/rejected.md'").get()).toEqual({ rows: 2 });
		expect(fixture.runtime.db.prepare("SELECT memory_id, verdict, CASE WHEN file_path LIKE '%/rejected.md' THEN 'rejected.md' ELSE 'accepted.md' END AS file FROM nodix_loaded_file_judgments ORDER BY memory_id, file_path").all()).toEqual([
			{ memory_id: "failure-row-40", verdict: "not-said", file: "accepted.md" },
			{ memory_id: "failure-row-40", verdict: "not-said", file: "rejected.md" },
			{ memory_id: "file-row-a", verdict: "said", file: "accepted.md" },
			{ memory_id: "file-row-b", verdict: "said", file: "accepted.md" },
			{ memory_id: "file-row-b", verdict: "said", file: "rejected.md" },
		]);
	});

});
