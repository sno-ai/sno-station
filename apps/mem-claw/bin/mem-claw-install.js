#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
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
