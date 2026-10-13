import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type MemoryClient } from "@snoai/memory/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claude from "../../../apps/mem-claude/src/worker";
import * as codex from "../../../apps/mem-codex/src/worker";
import * as cursor from "../../../apps/mem-cursor/src/worker";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const savedProfile = process.env.SNO_PROFILE_DIR;
let root: string;
let client: MemoryClient | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (client) {
		try { process.kill(client.pid, "SIGTERM"); } catch { /* already stopped */ }
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try { process.kill(client.pid, 0); } catch { break; }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		client = undefined;
	}
	if (root) await rm(root, { recursive: true, force: true });
	if (savedProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = savedProfile;
});

describe.each([
	["claude", claude], ["codex", codex], ["cursor", cursor],
] as const)("%s spool recovery", (skin, worker) => {
	async function setup() {
		root = await mkdtemp(join(tmpdir(), "worker-spool-recovery-"));
		process.env.SNO_PROFILE_DIR = root;
		writeSettingsFixture(root, { mode: "local-first", capture: { ambient: false }, rem: { tick: false },
			rerank: { mode: "none" }, telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } } });
		const directory = join(root, `sno-mem-${skin}`, "spool");
		await mkdir(directory, { recursive: true });
		const record = { sessionId: "session-recovery", turnId: "later", project: root, childCwd: root,
			user: "The project release label is Indigo.", assistant: "Recorded.", at: 1, attempts: 0, state: "pending" };
		return { directory, record };
	}

	it.each(["invalid-json", "invalid-schema", "exhausted"])("removes %s while looking for later work", async kind => {
		const { directory, record } = await setup();
		await writeFile(join(directory, "0001.json"), kind === "invalid-json" ? "{broken" : kind === "invalid-schema" ? "{}" : JSON.stringify({ ...record, attempts: 3, state: "failed" }));
		await writeFile(join(directory, "0004.json"), JSON.stringify(record));
		expect(await worker.hasActionableSpool()).toBe(true);
		expect((await readdir(directory)).sort()).toEqual(["0004.json"]);
	});

	it.each(["{broken", "{}", undefined])("captures later work after %s and deletes a third failure", async malformed => {
		const { directory, record } = await setup();
		if (malformed !== undefined) await writeFile(join(directory, "0001.json"), malformed);
		await writeFile(join(directory, "0004.json"), JSON.stringify({ ...record, sessionId: "session-rejected", turnId: "rejected", at: -1 }));
		await writeFile(join(directory, "0005.json"), JSON.stringify(record));
		const connected = await connect({ skinId: skin });
		if (connected.degraded) throw new Error(connected.error ?? connected.reason);
		client = connected;
		let clock = Date.now();
		const logged = vi.spyOn(console, "log");
		expect(await worker.runWorker({ async connect() { return connected; }, now: () => clock,
			async sleep(ms) { clock += ms; }, async runChild() { throw new Error("disabled capture must not call a model"); } })).toBe("drained");
		expect(await readdir(directory)).toEqual([]);
		expect(existsSync(join(root, `sno-mem-${skin}`, "worker.lock"))).toBe(false);
		const events = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(events.filter(event => event.event === "capture-failed").map(event => event.turnId)).toEqual(["rejected", "rejected", "rejected"]);
		expect(events.filter(event => event.event === "capture-accepted").map(event => event.turnId)).toEqual(["later"]);
	}, 30_000);
});
