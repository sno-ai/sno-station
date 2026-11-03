import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { copyFile, mkdir, readFile, writeFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { spawn as spawnTerminal } from "@lydell/node-pty";

function model(command, args, env, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => {
			try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); }
		}, 180_000);
		child.stdout.on("data", value => { stdout += value; });
		child.stderr.on("data", value => { stderr += value; });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

export async function claudeFixture({ home, env, root, run, snapshot, sno }) {
	await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
	await copyFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude"), ".credentials.json"),
		join(env.CLAUDE_CONFIG_DIR, ".credentials.json"));
	await writeFile(join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, autoUpdates: false }));
	await writeFile(join(env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
		statusLine: { type: "command", command: "printf '\\033[32muser status\\033[0m\\n'" },
	}));
	run([join(root, "apps/mem-claude/dist/cli.js"), "install", "--config-dir", env.CLAUDE_CONFIG_DIR], undefined,
		{ SNO_EXECUTABLE: sno });
	const nativeEnv = { ...env };
	for (const key of Object.keys(nativeEnv)) if (key.startsWith("CLAUDE") && key !== "CLAUDE_CONFIG_DIR") delete nativeEnv[key];
	const sessions = { question: randomUUID(), finished: randomUUID() };
	const settings = join(env.CLAUDE_CONFIG_DIR, "settings.json");
	const call = async (session, prompt, resume = false) => {
		const result = await model(process.env.CLAUDE_BIN ?? "claude", ["-p", resume ? "--resume" : "--session-id", session,
			"--setting-sources", "", "--settings", settings, "--tools", "", "--permission-mode", "dontAsk",
			"--output-format", "json", prompt], nativeEnv, home);
		await writeFile(join(home, `${session}-${resume ? "resume" : "initial"}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
		assert.equal(result.code, 0, result.stderr || result.stdout);
		const answer = JSON.parse(result.stdout);
		assert.equal(answer.is_error, false, answer.result);
		return answer;
	};
	await Promise.all([
		call(sessions.question, "Reply with exactly this one sentence and no tools: Ready to continue?"),
		call(sessions.finished, "Reply with exactly this one sentence and no tools: Finished the isolated observation check."),
	]);
	const view = snapshot();
	assert.equal(view.agents.length, 2, "two real Claude sessions must stay distinct");
	assert(view.agents.every(row => row.harness === "claude"));
	const waiting = view.agents.find(row => row.sessionId === sessions.question);
	const finished = view.agents.find(row => row.sessionId === sessions.finished);
	assert.equal(waiting?.waitingForHuman, "yes");
	assert.equal(waiting?.waitingReason, "asked a question");
	assert.equal(waiting?.group, "Needs you");
	assert.equal(finished?.group, "Finished");
	assert.equal(finished?.humanSeen, false);
	assert.equal(finished?.finalReply, "Finished the isolated observation check.");
	const events = await Promise.all(Object.values(sessions).map(async session => {
		const path = join(env.SNO_PROFILE_DIR, "station/agents", `claude--${session}.jsonl`);
		const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		for (const event of ["session-start", "user-prompt-submit", "stop", "session-end"]) assert(records.some(row => row.event === event), `native ${event} must append`);
		return { session, events: records.map(row => row.event), actualPid: records.find(row => row.pid)?.pid ?? "unknown" };
	}));
	await writeFile(join(home, "native-observations.json"), JSON.stringify({ sessions, events, view }, null, 2), { mode: 0o600 });
	return { sessions, events, waiting, finished, async answer() {
		await call(sessions.question, "Yes, continue. Reply exactly: The answered turn is finished.", true);
		const answered = snapshot().agents.find(row => row.sessionId === sessions.question);
		assert.equal(answered?.finalReply, "The answered turn is finished.");
		assert.equal(answered?.waitingForHuman, "no");
		assert.equal(answered?.group, "Finished");
		return answered;
	} };
}

export async function cursorFixture({ home, env, root, run, snapshot, sno }) {
	const config = join(home, ".cursor");
	await mkdir(config, { recursive: true });
	await mkdir(join(home, ".config/cursor"), { recursive: true });
	await copyFile(join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"), "cursor/auth.json"), join(home, ".config/cursor/auth.json"));
	await writeFile(join(config, "cli-config.json"), JSON.stringify({
		statusLine: { type: "command", command: "printf '\\033[32muser status\\033[0m\\n'" },
	}));
	run([join(root, "apps/mem-cursor/dist/cli.js"), "install", "--cursor-home", config], undefined, { SNO_EXECUTABLE: sno });
	const nativeEnv = { ...env, CURSOR_CONFIG_DIR: config };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete nativeEnv[key];
	const result = await model(process.env.CURSOR_AGENT_BIN ?? "cursor-agent", ["-p", "--force", "--trust", "--workspace", home,
		"--output-format", "json", "--mode", "ask", "Reply exactly: Ready to continue?"], nativeEnv, home);
	await writeFile(join(home, "cursor-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
	assert.equal(result.code, 0, result.stderr || result.stdout);
	const answer = JSON.parse(result.stdout);
	assert.equal(answer.is_error, false, answer.result);
	const rows = snapshot().agents.filter(row => row.harness === "cursor");
	assert.equal(rows.length, 1, "real Cursor conversation must append state");
	const row = rows[0];
	assert.equal(row.finalReply, "Ready to continue?");
	assert.equal(row.group, "Needs you");
	assert.equal(row.waitingReason, "asked a question");
	const records = (await readFile(join(env.SNO_PROFILE_DIR, "station/agents", `cursor--${encodeURIComponent(row.sessionId)}.jsonl`), "utf8"))
		.trim().split("\n").map(line => JSON.parse(line));
	assert(records.every(item => item.input.conversation_id === row.sessionId));
	await writeFile(join(home, "cursor-observations.json"), JSON.stringify({ row, events: records.map(item => item.event) }, null, 2));
	return { row, events: records.map(item => item.event), config };
}

export async function claudeUi({ home, env, snapshot, fixture }) {
	const configPath = join(env.CLAUDE_CONFIG_DIR, ".claude.json");
	const config = JSON.parse(await readFile(configPath, "utf8"));
	config.projects ??= {};
	config.projects[home] = { hasTrustDialogAccepted: true };
	await writeFile(configPath, JSON.stringify(config));
	const nativeEnv = { ...env };
	for (const key of Object.keys(nativeEnv)) if (key.startsWith("CLAUDE") && key !== "CLAUDE_CONFIG_DIR") delete nativeEnv[key];
	const session = randomUUID();
	let output = "", exited;
	const listeners = new Set();
	const terminal = spawnTerminal(process.env.CLAUDE_BIN ?? "claude", ["--session-id", session, "--setting-sources", "",
		"--settings", join(env.CLAUDE_CONFIG_DIR, "settings.json"), "--permission-mode", "default", "--tools", "Bash"],
	{ cwd: home, env: nativeEnv, cols: 200, rows: 65 });
	terminal.onData(data => { output += data; for (const listener of listeners) listener(); });
	terminal.onExit(event => { exited = event; for (const listener of listeners) listener(); });
	const normalized = () => stripVTControlCharacters(output.replaceAll("\x1b", " \x1b")).replace(/\s+/g, " ");
	const waitFor = (predicate, label) => new Promise((resolve, reject) => {
		const finish = error => { clearTimeout(timer); listeners.delete(check); error ? reject(error) : resolve(); };
		const check = () => {
			if (predicate(normalized())) finish();
			else if (exited) finish(new Error(`Claude exited before ${label}: ${exited.exitCode}`));
		};
		const timer = setTimeout(() => finish(new Error(`Claude UI timed out waiting for ${label}`)), 90_000);
		listeners.add(check); check();
	});
	const waitForEvent = async event => {
		const directory = join(env.SNO_PROFILE_DIR, "station/agents");
		const path = join(directory, `claude--${session}.jsonl`);
		const changes = watch(directory, { signal: AbortSignal.timeout(45_000) });
		const observed = async () => (await readFile(path, "utf8")).trim().split("\n").some(line => JSON.parse(line).event === event);
		try {
			if (await observed()) return;
			for await (const change of changes) if (change.filename === `claude--${session}.jsonl` && await observed()) return;
		} finally { await changes.return(); }
	};
	try {
		await waitFor(text => text.includes("user status") && /❄ 1 need you/.test(text), "computed other-agent question in the actual status line");
		const prompt = "Run exactly this Bash command: touch permission-proof.txt. When it succeeds, reply exactly: Approved operation complete.";
		terminal.write(prompt);
		await waitFor(text => text.includes("permission-proof.txt"), "typed command filename");
		terminal.write("\r");
		await waitFor(text => /Do you want to proceed|Do you want to allow|Allow this|Allow Claude/.test(text), "actual permission prompt");
		await waitForEvent("permission-request");
		const waiting = snapshot().agents.find(row => row.sessionId === session);
		assert.equal(waiting?.waitingForHuman, "yes");
		assert.equal(waiting?.waitingReason, "permission to approve");
		assert.equal(snapshot().agents.find(row => row.sessionId === fixture.sessions.question)?.waitingReason, "asked a question");
		terminal.write("\r");
		await waitForEvent("post-tool-use");
		await waitForEvent("stop");
		await readFile(join(home, "permission-proof.txt"));
		const finished = snapshot().agents.find(row => row.sessionId === session);
		assert.equal(finished?.finalReply, "Approved operation complete.");
		assert.equal(finished?.waitingForHuman, "no");
		assert.equal(finished?.waitingReason, "unknown");
		return { session, actualStatusLine: true, permissionBeforeApproval: waiting, afterApproval: finished };
	} finally {
		await writeFile(join(home, "claude-ui.txt"), output, { mode: 0o600 });
		terminal.kill();
	}
}
