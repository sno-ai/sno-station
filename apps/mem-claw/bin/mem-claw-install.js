#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let profile;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--profile") {
		profile = args[++i];
		if (!profile) {
			console.error("--profile requires a value");
			process.exit(2);
		}
	} else if (args[i] === "--help" || args[i] === "-h") {
		console.log("This script installs the OpenClaw plugin and is run by sno.\nRun sno setup --harness openclaw.");
		process.exit(0);
	} else {
		console.error(`Unknown option: ${args[i]}`);
		process.exit(2);
	}
}

// A running gateway keeps a second link to each file of the plugin it loaded, and OpenClaw refuses to replace an installed
// plugin holding such a file ("Refusing to move hardlinked file"). Give each such file its own copy first; the content stays
// the same. Links to other directories, such as the host OpenClaw, are not followed. A first install has nothing to inspect.
const inspected = spawnSync("openclaw", [...(profile ? ["--profile", profile] : []), "plugins", "inspect", "sno-mem-claw", "--json"], { encoding: "utf8" });
if (inspected.status === 0) {
	const separate = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) separate(path);
			else if (entry.isFile() && lstatSync(path).nlink > 1) {
				copyFileSync(path, `${path}.sno-copy`);
				renameSync(`${path}.sno-copy`, path);
			}
		}
	};
	try {
		const installedDir = JSON.parse(inspected.stdout.slice(inspected.stdout.indexOf("{"))).plugin?.rootDir;
		if (installedDir) separate(installedDir);
	} catch (error) {
		console.error(`Could not separate the installed plugin's files from the running gateway: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// sno setup runs this with nobody to answer a prompt. OpenClaw stops to ask before it installs a plugin from a local path
// (--force) and before it accepts the capabilities the plugin declares (--accept-capabilities).
const command = [...(profile ? ["--profile", profile] : []), "plugins", "install", pluginDir, "--force", "--accept-capabilities"];
const result = spawnSync("openclaw", command, { stdio: "inherit" });
if (result.error) {
	console.error(`OpenClaw installation failed: ${result.error.message}`);
	process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("OpenClaw plugin installed. Run sno setup to configure the memory service.");

// OpenClaw loads a new plugin only when its gateway restarts, and after an install the gateway can be left stopped, so the
// agent has no memory until someone starts it. Restart it here and wait until it answers.
// Hints name the same profile this install used, so the command a person copies acts on the same OpenClaw.
const profileFlag = profile ? ` --profile ${profile}` : "";
const gateway = (...rest) => spawnSync("openclaw", [...(profile ? ["--profile", profile] : []), "gateway", ...rest], { encoding: "utf8" });
const restarted = gateway("restart");
process.stdout.write(restarted.stdout ?? ""); process.stderr.write(restarted.stderr ?? "");
// `sno update` shows only the last error line, so a failure is repeated as the last line of this installer, with OpenClaw's own words.
let gatewayFailure = "";
if (restarted.status !== 0) {
	const said = (restarted.stderr?.trim() ? restarted.stderr : restarted.stdout ?? "").split("\n").map(line => line.trim()).filter(Boolean).slice(-2).join(" ");
	gatewayFailure = `OpenClaw's gateway did not restart (exit ${restarted.status ?? restarted.error?.message})${said ? `: ${said}` : ""}; once that is fixed, start it with: openclaw${profileFlag} gateway restart`;
} else {
	let ready = false;
	let lastProbe = "";
	// Each probe is cut off after 5 seconds, so the wait is 60 seconds of the clock, not 60 probes.
	for (const end = Date.now() + 60_000; !ready && Date.now() < end;) {
		const probe = spawnSync("openclaw", [...(profile ? ["--profile", profile] : []), "gateway", "health"], { encoding: "utf8", timeout: 5000 });
		ready = probe.status === 0;
		if (!ready) lastProbe = ((probe.stderr?.trim() ? probe.stderr : probe.stdout) ?? "").split("\n").map(line => line.trim()).filter(Boolean).at(-1) ?? "";
		if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	}
	if (ready) console.log("OpenClaw's gateway restarted and answers.");
	else gatewayFailure = `OpenClaw's gateway restarted but did not answer within 60 seconds${lastProbe ? ` (${lastProbe})` : ""}; check it with: openclaw${profileFlag} gateway status`;
}

// With several agents and none marked default, OpenClaw refuses a new session that names no agent, which is how Sno Reach
// seats start. The install itself worked; say how to fix this now.
const agentList = spawnSync("openclaw", [...(profile ? ["--profile", profile] : []), "agents", "list", "--json"], { encoding: "utf8" });
if (agentList.status !== 0) {
	console.error(`Could not check OpenClaw's agents (exit ${agentList.status ?? agentList.error?.message}); if it has several agents, make one the default so Sno Reach seats can start.`);
} else {
	try {
		const agents = JSON.parse(agentList.stdout.slice(agentList.stdout.indexOf("[")));
		if (Array.isArray(agents) && agents.length > 1 && !agents.some(agent => agent.isDefault === true)) {
			console.log(`OpenClaw has several agents (${agents.map(agent => agent.id).join(", ")}) and none is the default, so Sno Reach seats cannot start.\nChoose one with: openclaw${profileFlag} config set agents.defaults.systemAgent.agentId <id>`);
		}
	} catch (error) {
		console.error(`Could not read OpenClaw's agent list: ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (gatewayFailure) { console.error(gatewayFailure); process.exitCode = 1; }
