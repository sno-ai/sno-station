import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const prefix = process.argv[2];
assert.ok(prefix && isAbsolute(prefix), "pass the absolute npm install prefix");
const memory = join(prefix, "node_modules", "@snoai", "memory");
const profile = mkdtempSync(join(tmpdir(), "sno-installed-memory-"));
const project = join(profile, "project");
mkdirSync(project);
const settings = JSON.parse(readFileSync(join(memory, "settings.default.json"), "utf8"));
settings.mode = "local-first";
settings.store = {
	...settings.store,
	path: join(profile, "memory.sqlite"),
	encryptionKey: randomBytes(32).toString("hex"),
};
settings.memoryPackage = { path: memory, node: process.execPath };
settings.embedding = { ...settings.embedding, cacheDir: join(profile, "models") };
settings.rerank = { ...settings.rerank, mode: "none" };
settings.rem = { ...settings.rem, tick: false };
settings.telemetry = {
	...settings.telemetry,
	observe: { ...settings.telemetry.observe, enabled: false },
};
settings.capture = { ...settings.capture, ambient: false };
writeFileSync(join(profile, "settings.json"), `${JSON.stringify(settings)}\n`, { mode: 0o600 });
process.env.SNO_PROFILE_DIR = profile;

const { connect } = await import(pathToFileURL(join(memory, "dist", "client.js")));
let client;
try {
	client = await connect({ skinId: "codex" });
	assert.equal(client.degraded, false, client.error ?? client.reason);
	const scope = { principal: client.principal, project, session: randomUUID(), host: { workspace: project } };
	const initialized = await client.init(scope, { skinId: "codex" });
	assert.equal(initialized.degraded, false, initialized.error ?? initialized.reason);
	const fact = `The installed memory release marker is ${randomUUID()}.`;
	const stored = await client.mutate({ op: "store", content: fact }, scope);
	assert.equal(stored.degraded, false, stored.error ?? stored.reason);
	assert.notEqual(stored.result.isError, true, JSON.stringify(stored.result));
	const id = stored.result.details.id;
	assert.match(id, /^[0-9a-f-]{36}$/i);
	const fresh = await connect({ skinId: "codex" });
	assert.equal(fresh.degraded, false, fresh.error ?? fresh.reason);
	const nextScope = { ...scope, session: randomUUID() };
	const byId = await fresh.inspect({ op: "get", id }, nextScope);
	assert.equal(byId.degraded, false, byId.error ?? byId.reason);
	assert.equal(byId.result.entry?.text, fact);
	const recalled = await fresh.getRecall("installed memory release marker", nextScope, { source: "manual", minScore: 0 });
	assert.equal(recalled.degraded, false, recalled.error ?? recalled.reason);
	assert.ok(recalled.contextText.includes(fact), JSON.stringify(recalled));
	console.log(JSON.stringify({ status: "PASS", package: "@snoai/memory", installed: memory, profile }));
} finally {
	if (client && !client.degraded) {
		try { process.kill(client.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
}
