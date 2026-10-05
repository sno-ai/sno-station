// QCG-17 (REQ-1, REQ-24): a `sno reach call` whose `--expect` names a handoff token and matches
// ends as a `reach.message` envelope with that receipt in a real buffer.db. The real `sno-reach`
// runs against a private tmux server and records through the real `sno observe append` (SNO_BINARY),
// which runs the SDK packed and installed with `npm install -g --prefix`; the server is a closed loopback port, so events stay
// in buffer.db. Seat B is a plain shell pane: the call types a printf, the pane prints the line.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { realSno } from "../support/real-sno.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const REACH = join(repoRoot, "apps/reach/bin/sno-reach");
const work = mkdtempSync(join(tmpdir(), "reach-receipt-"));
const server = `reach-receipt-${process.pid}`;
const home = join(work, "home");
const root = join(work, "state");
const profile = join(work, "profile");
let globalBin;
let globalPrefix;
let tmuxEnv = "";

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...options });
	assert.equal(result.status, 0, `${cmd} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

const tmux = (...args) => run("tmux", ["-L", server, ...args], { timeout: 10_000 }).trim();

before(() => {
	mkdirSync(home, { recursive: true });
	mkdirSync(profile, { recursive: true });
	const packs = join(work, "packs");
	mkdirSync(packs);
	run("npm", ["--workspace", "@snoai/observability", "run", "build"], { cwd: repoRoot });
	const tarballs = ["observability", "utils", "common-core"].map((pkg) =>
		join(packs, run("npm", ["pack", "--silent", "--pack-destination", packs], {
			cwd: join(repoRoot, "packages", pkg),
		}).trim().split("\n").at(-1)));
	const prefix = join(work, "global");
	run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", ...tarballs]);
	globalPrefix = prefix;
	globalBin = join(work, "sno-bin");
	mkdirSync(globalBin);
	symlinkSync(realSno(), join(globalBin, "sno"));
	assert.equal(existsSync(join(prefix, "lib", "node_modules", "@snoai", "observability", "dist", "bin", "sno-observe.js")), true);
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "proof", "-x", "160", "-y", "30", "bash --norc");
	tmuxEnv = tmux("display-message", "-p", "#{socket_path},#{pid},0");
});

after(() => {
	spawnSync("tmux", ["-L", server, "kill-server"]);
	rmSync(work, { recursive: true, force: true });
});

function reach(args) {
	const env = { ...process.env };
	for (const key of ["CLAUDECODE", "SNO_REACH_ADDR", "TMUX_PANE"]) delete env[key];
	Object.assign(env, {
		PATH: `${globalBin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local/state"), SNO_REACH_ROOT: root, TMUX: tmuxEnv,
		SNO_PROFILE_DIR: profile, SNO_OBSERVE_ENABLED: "true", SNO_OBSERVE_BASE_URL: "http://127.0.0.1:9",
		npm_config_prefix: globalPrefix,
	});
	const result = spawnSync(REACH, args, { env, encoding: "utf8", timeout: 60_000 });
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// reach.message envelopes in buffer.db, waiting for the background sno observe to land `count`.
function messages(count) {
	const path = join(profile, "buffer.db");
	const until = Date.now() + 20_000;
	for (;;) {
		let rows = [];
		if (existsSync(path)) {
			const db = new DatabaseConstructor(path, { readonly: true });
			try {
				rows = db.prepare("SELECT payload FROM events ORDER BY rowid").all()
					.map((row) => JSON.parse(String(row.payload)));
			} finally {
				db.close();
			}
		}
		const found = rows.filter((e) => e.event_type === "reach.message" || e.event_type === "error");
		if (found.length >= count || Date.now() > until) return found;
		spawnSync("sleep", ["0.2"]);
	}
}

test("a matched handoff --expect records its receipt; a ready nonce or a timeout records none", () => {
	const pane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "proof", "bash --norc");
	const b = `b.receipt@${hostname()}`;
	assert.equal(reach(["init", "--as", b, "--name", "b"]).code, 0);
	const register = reach(["register", "--as", b, "--channel", "tmux", "--handle", pane]);
	assert.equal(register.code, 0, register.out);

	const released = reach(["call", b, "printf 'HANDOFF_RELEASED %s\\n' n1",
		"--expect", "HANDOFF_RELEASED n1", "--timeout", "30", "--every", "1"]);
	assert.equal(released.code, 0, released.out);
	const [first, ...extra] = messages(1);
	assert.equal(extra.length, 0);
	assert.equal(first.event_type, "reach.message", JSON.stringify(first));
	assert.equal(first.payload.kind, "call");
	assert.equal(first.payload.receipt, "handoff_released");

	const ready = reach(["call", b, "printf 'READY-%s\\n' n2",
		"--expect", "READY-n2", "--timeout", "30", "--every", "1"]);
	assert.equal(ready.code, 0, ready.out);
	const late = reach(["call", b, "true # no reply",
		"--expect", "HANDOFF_RELEASED n3", "--timeout", "1", "--every", "1"]);
	assert.equal(late.code, 4, `a timed-out call exits 4: ${late.out}`);
	const all = messages(3);
	assert.deepEqual(all.map((e) => [e.event_type, e.payload.kind, e.payload.outcome, e.payload.receipt]), [
		["reach.message", "call", "ok", "handoff_released"],
		["reach.message", "call", "ok", undefined],
		["reach.message", "call", "timeout", undefined],
	]);
});
