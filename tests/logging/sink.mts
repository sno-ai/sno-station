import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, stat, readdir, utimes, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { LogFileSink, MAX_LOG_QUEUE_BYTES } from "../../packages/utils/src/log-file-sink.ts";

const notices: Array<{ reason: string; fields?: Record<string, unknown> }> = [];
function notice(reason: string, fields?: Record<string, unknown>): string {
	notices.push({ reason, fields });
	return JSON.stringify({ notice: reason, ...fields });
}

if (process.argv[2] === "writer") {
	const sink = new LogFileSink(process.argv[3]!, notice);
	for (let index = 0; index < 100; index++) {
		sink.enqueue(JSON.stringify({ writer: process.argv[4], index }), "info");
		if (index % 11 === 0) await new Promise(resolve => setImmediate(resolve));
	}
	await sink.close();
	assert.equal(notices.length, 0, JSON.stringify(notices));
} else {
	const directory = await mkdtemp(join(tmpdir(), "logging-sink-proof-"));
	const destination = join(directory, "mem-claw.log");
	const children = ["first", "second"].map(writer => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "writer", destination, writer], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", bytes => { stderr += bytes; });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer exit=${code}: ${stderr}`)));
	}));
	await Promise.all(children);
	const rows = (await readFile(destination, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows.length, 200, "both writers preserve all accepted records");
	assert.equal(new Set(rows.map(row => `${row.writer}:${row.index}`)).size, 200, "each record occurs exactly once");

	const queuedPath = join(directory, "queue.log");
	const queue = new LogFileSink(queuedPath, notice);
	const payload = JSON.stringify({ padding: "x".repeat(8192) });
	for (let index = 0; index < 300; index++) queue.enqueue(payload, "info");
	queue.enqueue(JSON.stringify({ critical: true }), "error");
	const started = performance.now();
	await queue.close();
	assert.ok(performance.now() - started < 2500, "owner close has a fixed bound");
	const queued = (await readFile(queuedPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	assert.equal(queued.filter(row => row.critical).length, 1, "important record survives low-severity overflow");
	const dropped = notices.filter(row => row.reason === "records_dropped").reduce((sum, row) => sum + Number(row.fields?.info ?? 0), 0);
	const persisted = queued.filter(row => row.padding).length;
	assert.equal(persisted + dropped, 300, "every dropped low-severity record is accounted for");
	assert.ok(persisted * (Buffer.byteLength(payload) + 1) <= MAX_LOG_QUEUE_BYTES, "accepted pending bytes respect the queue cap");

	const retentionPath = join(directory, "retention.log");
	await writeFile(retentionPath, "current\n");
	const current = await stat(retentionPath);
	const old = join(directory, "retention.log.2020-01-01");
	const foreign = join(directory, "retention.log.2019-01-01");
	await writeFile(old, "owned\n");
	await writeFile(foreign, "foreign\n");
	await utimes(old, new Date("2020-01-01"), new Date("2020-01-01"));
	await utimes(foreign, new Date("2019-01-01"), new Date("2019-01-01"));
	const oldStat = await stat(old);
	await writeFile(`${retentionPath}.lock`, JSON.stringify({ day: new Date().toISOString().slice(0, 10),
		current: { name: basename(retentionPath), dev: current.dev, ino: current.ino },
		rotated: [{ name: basename(old), dev: oldStat.dev, ino: oldStat.ino }] }));
	const retention = new LogFileSink(retentionPath, notice);
	retention.enqueue(JSON.stringify({ retained: true }), "info");
	await retention.close();
	assert.ok(!(await readdir(directory)).includes(basename(old)), "owned aged file is deleted");
	assert.equal(await readFile(foreign, "utf8"), "foreign\n", "foreign lookalike file is preserved");
	assert.ok((await readFile(retentionPath, "utf8")).startsWith("current\n"), "current file is not deleted by retention");

	const yesterdayPath = join(directory, "day.log");
	await writeFile(yesterdayPath, "previous-day\n");
	const yesterday = new Date(Date.now() - 86400000);
	await utimes(yesterdayPath, yesterday, yesterday);
	const day = new LogFileSink(yesterdayPath, notice);
	day.enqueue(JSON.stringify({ today: true }), "info");
	await day.close();
	assert.equal(await readFile(`${yesterdayPath}.${yesterday.toISOString().slice(0, 10)}`, "utf8"), "previous-day\n");
	assert.deepEqual(JSON.parse(await readFile(yesterdayPath, "utf8")), { today: true });

	const capacityPath = join(directory, "capacity.log");
	await writeFile(capacityPath, "stable\n");
	const largeOld = join(directory, "capacity.log.2026-08-01");
	const capacityFile = await open(largeOld, "w");
	await capacityFile.truncate(11 * 1024 ** 3);
	await capacityFile.close();
	const past = new Date(Date.now() - 120000);
	await utimes(largeOld, past, past);
	const capacityCurrent = await stat(capacityPath);
	const capacityOld = await stat(largeOld);
	await writeFile(`${capacityPath}.lock`, JSON.stringify({ day: new Date().toISOString().slice(0, 10),
		current: { name: basename(capacityPath), dev: capacityCurrent.dev, ino: capacityCurrent.ino },
		rotated: [{ name: basename(largeOld), dev: capacityOld.dev, ino: capacityOld.ino }] }));
	const capacity = new LogFileSink(capacityPath, notice);
	capacity.enqueue(JSON.stringify({ capacity: true }), "info");
	await capacity.close();
	assert.ok(!(await readdir(directory)).includes(basename(largeOld)), "capacity removes eligible owned file before age expiry");
	assert.ok((await readFile(capacityPath, "utf8")).startsWith("stable\n"), "capacity preserves current path");

	const overrunPath = join(directory, "overrun.log");
	const hugeCurrent = await open(overrunPath, "w");
	await hugeCurrent.truncate(11 * 1024 ** 3);
	await hugeCurrent.close();
	const overrun = new LogFileSink(overrunPath, notice);
	overrun.enqueue(JSON.stringify({ after_overrun: true }), "info");
	const rotationDeadline = performance.now() + 5000;
	while (!notices.some(row => row.reason === "retention_overrun") && performance.now() < rotationDeadline) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.ok(notices.some(row => row.reason === "retention_overrun"), "fresh over-cap rotation reports quiesce overrun");
	const rotatedNames = (await readdir(directory)).filter(name => name.startsWith("overrun.log.") && !name.endsWith(".lock"));
	assert.equal(rotatedNames.length, 1, "oversized current file rotates exactly once");
	assert.equal((await stat(join(directory, rotatedNames[0]!))).size, 11 * 1024 ** 3, "quiesce protects fresh rotation");
	await new Promise(resolve => setTimeout(resolve, 65000));
	assert.ok(!(await readdir(directory)).includes(rotatedNames[0]!), "product scheduled retry clears overrun without test invocation");
	await overrun.close();
	assert.ok((await readFile(overrunPath, "utf8")).includes('"after_overrun":true'), "new current file receives queued event");

	const full = new LogFileSink("/dev/full", notice, false);
	full.enqueue(JSON.stringify({ product_result: "unchanged" }), "info");
	await full.close();
	assert.equal(full.status().reason, "file_sink_failed", "non-regular or failed sink is disabled without throwing");
	assert.equal(notices.filter(row => row.reason === "file_sink_failed").length, 1, "sink failure cannot recurse");
	console.log(JSON.stringify({ passed: true, directory, checks: ["concurrent-append", "overflow-accounting", "bounded-close", "aged-owned-retention", "foreign-preservation", "day-rotation", "capacity-deletion", "automatic-overrun-retry", "failed-sink"] }));
}
