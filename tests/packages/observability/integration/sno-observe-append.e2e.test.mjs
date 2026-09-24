// QCG-16: the installed `sno-observe append` types argv by the SDK schema, sets agent and project,
// sends through the real SDK runtime into buffer.db, and turns bad input into exit 2 plus one
// `error` event. The bin comes from `npm pack` + one `npm install -g --prefix` of the SDK and its
// two @snoai dependencies, exactly as a user machine gets it; the server is a closed loopback port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import DatabaseConstructor from "better-sqlite3";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const expectedProject = `p_${createHash("sha256").update("github.com/example/project").digest("hex").slice(0, 16)}`;

let work;
let bin;

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...options });
	assert.equal(result.status, 0, `${cmd} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

before(() => {
	work = mkdtempSync(join(tmpdir(), "sno-observe-e2e-"));
	const packs = join(work, "packs");
	mkdirSync(packs);
	run("npm", ["--workspace", "@snoai/observability", "run", "build"], { cwd: repoRoot });
	const tarballs = ["observability", "utils", "common-core"].map((pkg) => {
		const name = run("npm", ["pack", "--silent", "--pack-destination", packs], {
			cwd: join(repoRoot, "packages", pkg),
		})
			.trim()
			.split("\n")
			.at(-1);
		return join(packs, name);
	});
	const prefix = join(work, "global");
	run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", ...tarballs]);
	bin = join(prefix, "bin", "sno-observe");
	assert.equal(existsSync(bin), true, "npm linked the sno-observe bin");
});

after(() => {
	if (work) rmSync(work, { recursive: true, force: true });
});

function profile() {
	const dir = mkdtempSync(join(work, "profile-"));
	const checkout = join(dir, "checkout");
	mkdirSync(checkout);
	run("git", ["init", "-q"], { cwd: checkout });
	run("git", ["remote", "add", "origin", "git@github.com:example/project.git"], { cwd: checkout });
	const env = {
		PATH: `${join(work, "global", "bin")}:${process.env.PATH}`,
		HOME: dir,
		SNO_PROFILE_DIR: dir,
		SNO_OBSERVE_ENABLED: "true",
		SNO_OBSERVE_BASE_URL: "http://127.0.0.1:9",
	};
	return { dir, checkout, env };
}

function append(p, args) {
	return spawnSync("sno-observe", ["append", ...args], {
		cwd: p.checkout,
		env: p.env,
		encoding: "utf8",
		timeout: 60_000,
	});
}

function envelopes(p) {
	const path = join(p.dir, "buffer.db");
	if (!existsSync(path)) return [];
	const db = new DatabaseConstructor(path, { readonly: true });
	try {
		return db
			.prepare("SELECT payload FROM events ORDER BY rowid")
			.all()
			.map((row) => JSON.parse(String(row.payload)))
			.filter((e) => e.event_type !== "agent.identify");
	} finally {
		db.close();
	}
}

describe("sno-observe append, installed", () => {
	it("sends a typed review.run with agent and the checkout's project", () => {
		const p = profile();
		const result = append(p, [
			"review.run",
			"--agent=codex",
			"--author_harness=codex",
			"--reviewer_harness=claude-code",
			"--findings_p1=1",
			"--findings_p2=0",
			"--findings_p3=0",
			"--empty=false",
			"--duration_ms=1200",
		]);
		assert.equal(result.status, 0, result.stderr);
		const [event, ...rest] = envelopes(p);
		assert.equal(rest.length, 0);
		assert.equal(event.event_type, "review.run");
		assert.equal(event.lane, "squad");
		assert.equal(event.scope.agent_id, "codex");
		assert.equal(event.scope.project_id, expectedProject);
		assert.deepEqual(event.payload, {
			author_harness: "codex",
			reviewer_harness: "claude-code",
			findings_p1: 1,
			findings_p2: 0,
			findings_p3: 0,
			empty: false,
			duration_ms: 1200,
		});
	});

	it("applies the level and project rules to rsi.lesson", () => {
		const p = profile();
		for (const args of [
			["--level=user"],
			["--level=project", "--project_id=p_0123456789abcdef"],
			["--level=project", "--project=github.com/Example/Project"],
		]) {
			const result = append(p, ["rsi.lesson", "--agent=codex", "--count=1", ...args]);
			assert.equal(result.status, 0, result.stderr);
		}
		const lessons = envelopes(p);
		assert.deepEqual(
			lessons.map((e) => [e.event_type, e.payload.level, e.payload.count, e.scope.project_id]),
			[
				["rsi.lesson", "user", 1, undefined],
				["rsi.lesson", "project", 1, "p_0123456789abcdef"],
				["rsi.lesson", "project", 1, expectedProject],
			],
		);
	});

	it("turns a bad rsi value into exit 2 and exactly one error event", () => {
		const p = profile();
		const result = append(p, ["rsi.lesson", "--agent=codex", "--count=x", "--level=user"]);
		assert.equal(result.status, 2);
		const stderrLine = result.stderr.trim();
		assert.notEqual(stderrLine, "");
		const all = envelopes(p);
		assert.equal(all.filter((e) => e.event_type === "rsi.lesson").length, 0);
		assert.equal(all.length, 1);
		const [error] = all;
		assert.equal(error.event_type, "error");
		assert.equal(error.payload.component, "rsi");
		assert.equal(error.payload.context, "rsi.lesson");
		assert.equal(error.payload.kind, "rsi:observe_append_failed");
		assert.equal(error.payload.recoverable, true);
		assert.match(error.payload.message_hash, /^[0-9a-f]{64}$/);
	});

	it("sends nothing for bad skill input or a missing agent", () => {
		const p = profile();
		assert.equal(append(p, ["skill.install", "--agent=codex", "--skill_name=x"]).status, 2);
		assert.equal(append(p, ["rsi.lesson", "--count=1", "--level=user"]).status, 2);
		assert.equal(append(p, ["rsi.lesson", "--agent=sno-cli", "--count=1", "--level=user"]).status, 2);
		assert.deepEqual(envelopes(p), []);
	});
});
