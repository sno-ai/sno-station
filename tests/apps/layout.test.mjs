import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname);
const apps = ["mem-claw", "mem-codex", "mem-claude", "mem-hermes"];

for (const app of apps) {
	for (const suite of ["e2e", "e2e-agent"]) {
		const directory = resolve(root, app, suite);
		assert.ok(existsSync(directory), `${app} is missing ${suite}/`);
		assert.ok(
			readdirSync(directory).some(name => /\.(?:mjs|py|sh|ts)$/.test(name)),
			`${app}/${suite} has no runnable test`,
		);
	}
}

assert.equal(existsSync(resolve(root, "results")), false, "results must live under its app");
assert.equal(existsSync(resolve(root, "mem-claw", "e2e-minus")), false, "use e2e/ consistently");
