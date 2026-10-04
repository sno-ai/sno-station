import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const prefix = process.argv[2];
assert.ok(prefix && isAbsolute(prefix), "pass the absolute npm install prefix");
const memory = join(prefix, "node_modules", "@snoai", "memory");
const profile = mkdtempSync(join(tmpdir(), "installed-project-reporting-"));
const workspace = join(profile, "one", "same-name");
const emptyWorkspace = join(profile, "two", "same-name");
const unknownWorkspace = join(profile, "unseen");
const stagedCache = join(homedir(), ".cache", "sno-station", "models");
const settings = JSON.parse(readFileSync(join(memory, "settings.default.json"), "utf8"));
settings.mode = "local-first";
settings.user.id = "01930000-0000-7000-8000-000000000001";
settings.store = { ...settings.store, path: join(profile, "memory.sqlite"), encryptionKey: randomBytes(32).toString("hex") };
settings.memoryPackage = { path: memory, node: process.execPath };
settings.embedding.cacheDir = stagedCache;
settings.embedding.offline = true;
settings.rerank.mode = "none";
settings.rem.tick = false;
settings.telemetry.observe.enabled = false;
settings.capture.ambient = false;
settings.logging = { ...settings.logging, level: "debug", file: join(profile, "runtime.log") };
writeFileSync(join(profile, "settings.json"), `${JSON.stringify(settings)}\n`, { mode: 0o600 });
process.env.SNO_PROFILE_DIR = profile;
process.env.HOME = join(profile, "home");
mkdirSync(process.env.HOME);
const { connect, connectReporting } = await import(pathToFileURL(join(memory, "dist", "client.js")));
const { getDek, openEncryptedDb, openEncryptedDbReadonly } = await import(pathToFileURL(join(prefix, "node_modules", "@snoai", "sqlite-crypto", "dist", "index.js")));
const serverModule = pathToFileURL(join(memory, "dist", "sidecar", "main.js")).href;
const discoveryPath = join(profile, "station", "sidecar.json");
let child;
let automaticPid;

function discovery() {
	return existsSync(discoveryPath) ? JSON.parse(readFileSync(discoveryPath, "utf8")) : undefined;
}
function alive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		if (process.platform !== "linux") return true;
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
	} catch { return false; }
}
async function start() {
	const log = openSync(join(profile, "sidecar.log"), "a", 0o600);
	try {
		child = spawn(process.execPath, ["--input-type=module", "-e", `
			await import(${JSON.stringify(serverModule)});
			process.send({ ready: true });
		`], { stdio: ["ignore", log, log, "ipc"], env: process.env });
	} finally { closeSync(log); }
	await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`sidecar exited ${code}; see ${profile}/sidecar.log`); })]);
}
async function stop() {
	if (child && child.exitCode === null) {
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		await exited;
	}
	child = undefined;
	const pid = automaticPid ?? discovery()?.pid;
	if (alive(pid)) {
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + 30_000;
		while (alive(pid) && Date.now() < deadline) await delay(50);
		assert.equal(alive(pid), false, "owned service did not stop within 30 seconds");
	}
	automaticPid = undefined;
}
function logs() {
	return existsSync(settings.logging.file) ? readFileSync(settings.logging.file, "utf8") : "";
}
function workEvents(text) {
	return text.split("\n").flatMap(line => {
		const name = line.match(/"event_name"\s*:\s*"([^"]+)"/)?.[1];
		// Closing an uninitialized provider emits dispose without loading or preparing its model.
		return name && name !== "embedder.local.provider.dispose" && (name.startsWith("embedder.") || name === "memory.sidecar.model.prepare.failed" || name.includes(".maintenance.")) ? [name] : [];
	});
}
function readDb(read) {
	const db = openEncryptedDbReadonly(settings.store.path, getDek(settings.store.encryptionKey));
	try { return read(db); } finally { db.close(); }
}
function snapshot() {
	return readDb(db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name").all()
		.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })));
}
function chunks() {
	return readDb(db => db.prepare("SELECT count(*) AS count FROM nodix_memory_chunks WHERE memory_id = 'legacy-reporting-fixture'").get().count);
}
async function directInspect(op, scope) {
	const service = discovery();
	const response = await fetch(`http://127.0.0.1:${service.port}/v1/inspect`, {
		method: "POST", headers: { "content-type": "application/json", "x-sidecar-token": service.token },
		body: JSON.stringify({ op, scope }), signal: AbortSignal.timeout(30_000),
	});
	assert.equal(response.status, 200);
	return response.json();
}

try {
	// Only fixture setup uses normal initialization. No reporting query warms the restarted service.
	await start();
	const ordinary = await connect({ skinId: "ordinary-installed-control" });
	assert.equal(ordinary.degraded, false, ordinary.error ?? ordinary.reason);
	const scope = { principal: ordinary.principal, project: workspace, session: "installed-report", host: { workspace } };
	await ordinary.init(scope, { skinId: ordinary.skinId });
	await ordinary.init({ ...scope, project: emptyWorkspace, host: { workspace: emptyWorkspace } }, { skinId: ordinary.skinId });
	await stop();
	const setupEvents = workEvents(logs());
	assert.ok(setupEvents.some(name => name.startsWith("embedder.")), "normal init must expose real model preparation events");
	assert.ok(setupEvents.includes("sno_station_mem.maintenance.maintenance.timer.started"), "normal init must start ordinary maintenance");
	const setupDb = openEncryptedDb(settings.store.path, getDek(settings.store.encryptionKey));
	try {
		setupDb.prepare("INSERT INTO nodix_memories(id, fact_id, text, category, project_id, timestamp, timezone, metadata, content_hash, lane) VALUES ('legacy-reporting-fixture', 'legacy-reporting-fixture', 'The legacy project keeps its release notes in README.md.', 'lesson', 'global', 1, 'UTC', '{}', 'legacy-reporting-fixture', 'active')").run();
	} finally { setupDb.close(); }
	assert.equal(chunks(), 0, "fixture must contain an unprocessed legacy memory");
	const before = snapshot();
	const logStart = logs().length;
	await start();
	// First HTTP request after real restart: no connect, health, init, storage or model read ahead of it.
	const catalog = await directInspect({ op: "projects" }, scope);
	assert.equal(catalog.degraded, false);
	assert.deepEqual(catalog.result.projects.filter(row => row.workspace).map(row => row.workspace).sort(), [workspace, emptyWorkspace].sort());
	assert.ok(catalog.result.projects.filter(row => row.workspace).every(row => row.memoryCount === 0));
	// The asynchronous log sink must have persisted this request before zero-work is meaningful.
	const logged = () => logs().slice(logStart).split("\n").some(line => line.includes('"event_name":"sno_station_mem.server.http.request"') && line.includes(`"process_id":${child.pid}`));
	const logDeadline = Date.now() + 5_000;
	while (!logged() && Date.now() < logDeadline) await delay(20);
	assert.ok(logged(), "cold HTTP request was not recorded in the observed log sink");
	const coldEvents = workEvents(logs().slice(logStart));
	console.log(JSON.stringify({ entry: "cold first direct HTTP projects", projectCount: catalog.result.projects.length, workEvents: coldEvents, legacyChunks: chunks() }));
	assert.deepEqual(coldEvents, [], "cold reporting must not prepare the model or start maintenance");
	assert.equal(chunks(), 0, "cold reporting must not process legacy memory chunks");
	assert.deepEqual(snapshot(), before, "cold reporting mutated existing SQLite data");
	assert.equal(typeof connectReporting, "function", "installed package must export connectReporting");
	const reader = await connectReporting({ skinId: "reporting-installed" });
	assert.equal(reader.degraded, false, reader.error ?? reader.reason);
	const unknownScope = { ...scope, project: unknownWorkspace, host: { workspace: unknownWorkspace } };
	const unknown = await reader.inspect({ op: "currentProject", workspace: unknownWorkspace }, unknownScope);
	assert.deepEqual(unknown, { degraded: false, result: { op: "currentProject", workspace: unknownWorkspace, status: "unknown", project: null } });
	assert.deepEqual(await reader.inspect({ op: "projects" }, unknownScope), catalog);
	const known = await reader.inspect({ op: "currentProject", workspace: emptyWorkspace }, unknownScope);
	assert.equal(known.result.status, "known");
	assert.equal(known.result.project.memoryCount, 0);
	const stats = await reader.inspect({ op: "stats" }, unknownScope);
	assert.equal(stats.degraded, false);
	assert.equal(stats.result.total, 1);
	const stoppedPid = discovery().pid;
	await stop();
	// Standalone shutdown drains its logger, including any delayed reporting-triggered work.
	assert.deepEqual(workEvents(logs().slice(logStart)), []);
	assert.equal(chunks(), 0);
	assert.deepEqual(snapshot(), before, "client reporting mutated existing SQLite data");
	assert.equal(alive(stoppedPid), false);
	assert.equal(discovery(), undefined);
	const fresh = await connectReporting({ skinId: "reporting-absent-service" });
	assert.equal(fresh.degraded, true);
	assert.equal(fresh.reason, "sidecar-unreachable");
	for (const client of [reader, ordinary]) {
		for (const op of [{ op: "projects" }, { op: "currentProject", workspace }, { op: "stats" }]) {
			const unavailable = await client.inspect(op, scope);
			assert.equal(unavailable.degraded, true);
			assert.equal(unavailable.reason, "sidecar-unreachable");
			assert.equal(discovery(), undefined, "reporting restarted the stopped service");
		}
	}
	assert.deepEqual(snapshot(), before);
	console.log(JSON.stringify({ entry: "fresh reporting connect and both existing clients after stop", stoppedPid, live: alive(stoppedPid), discoveryCreated: existsSync(discoveryPath) }));
	// Positive control: the ordinary skin still autostarts, prepares its model and processes old data.
	const controlStart = logs().length;
	const resumed = await connect({ skinId: "ordinary-autostart-control" });
	automaticPid = discovery()?.pid;
	assert.equal(resumed.degraded, false, resumed.error ?? resumed.reason);
	assert.equal(alive(automaticPid), true, "ordinary connect must still start a stopped service");
	await resumed.init(scope, { skinId: resumed.skinId });
	const deadline = Date.now() + 30_000;
	while (chunks() === 0 && Date.now() < deadline) await delay(50);
	assert.ok(chunks() > 0, "normal initialization must resume actual legacy memory processing");
	const ordinaryStartedPid = automaticPid;
	await stop();
	const controlEvents = workEvents(logs().slice(controlStart));
	assert.ok(controlEvents.some(name => name.startsWith("embedder.")));
	assert.ok(controlEvents.includes("sno_station_mem.maintenance.maintenance.timer.started"));
	console.log(JSON.stringify({ status: "PASS", version: JSON.parse(readFileSync(join(memory, "package.json"), "utf8")).version,
		installed: memory, profile, known, unknown, catalog, stats, coldWorkEvents: coldEvents,
		ordinaryStartedPid, ordinaryWorkEvents: controlEvents, legacyChunksAfterOrdinaryInit: chunks() }));
} finally { await stop(); }
