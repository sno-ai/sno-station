import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("an empty profile override keeps memory, agents and a new test identity in the working directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "sno-empty-profile-"));
	try {
		const modules = Object.fromEntries([
			["identity", "packages/observability/src/internal/identity.ts"],
			["observe", "packages/observability/src/internal/paths.ts"],
			["memory", "packages/memory/src/contract/profile.ts"],
			["claude", "apps/mem-claude/src/paths.ts"],
			["codex", "apps/mem-codex/src/paths.ts"],
			["cursor", "apps/mem-cursor/src/paths.ts"],
		].map(([key, file]) => [key, new URL(`../../../../${file}`, import.meta.url).href]));
		const script = `
import { resolve } from "node:path";
import assert from "node:assert/strict";
const paths = ${JSON.stringify(modules)};
const memory = await import(paths.memory);
const agents = await Promise.all([paths.claude, paths.codex, paths.cursor].map(p => import(p)));
const observe = await import(paths.observe);
const { bootstrapIdentity } = await import(paths.identity);
const roots = [memory.getStateDir(), ...agents.map(m => m.profileRoot()), resolve(observe.getSnoProfileDir())];
assert.deepEqual(roots, Array(5).fill(process.cwd()));
console.log(JSON.stringify({ identity: bootstrapIdentity() }));`;
		const loader = new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
		const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
			cwd: dir, encoding: "utf8", env: { ...process.env, SNO_PROFILE_DIR: "" },
		});
		assert.equal(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout);
		assert.match(output.identity.user_cuid, /^snotest[0-9a-z]{17}$/);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")), output.identity);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
