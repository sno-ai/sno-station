import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCuid2 } from "../../../../packages/common-core/dist/index.js";
import { bootstrapIdentity, isValidIdentity, updateIdentity } from "../../../../packages/observability/dist/internal/identity.js";
import * as identityModule from "../../../../packages/observability/dist/internal/identity.js";

const accountHome = userInfo().homedir;

describe("test identity prefix", () => {
	it("mints and persists valid prefixed identities through both entry points", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-identity-prefix-"));
		try {
			for (const mint of [bootstrapIdentity, (env) => updateIdentity((value) => value, env)]) {
				const path = join(dir, `${mint === bootstrapIdentity ? "bootstrap" : "update"}.json`);
				const identity = mint({ SNO_IDENTITY_PATH: path });
				assert.match(identity.user_cuid, /^snotest[0-9a-z]{17}$/u);
				assert.ok(isValidIdentity(identity));
				assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), identity);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats only the account home profile as ordinary", () => {
		assert.equal(identityModule.isTestProfile(join(accountHome, ".sno", "identity.json")), false);
		for (const path of [
			join(accountHome, ".sno-sno-e2e", "identity.json"),
			join(accountHome, ".cache", "sno-run", ".sno", "identity.json"),
			join(tmpdir(), ".sno", "identity.json"),
		]) assert.equal(identityModule.isTestProfile(path), true);
	});

	it("uses the account record even when HOME points to a test directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-identity-home-"));
		try {
			const script = `import assert from "node:assert/strict";
import { isTestProfile } from ${JSON.stringify(new URL("../../../../packages/observability/dist/internal/identity.js", import.meta.url).href)};
assert.equal(isTestProfile(${JSON.stringify(join(accountHome, ".sno", "identity.json"))}), false);
assert.equal(isTestProfile(${JSON.stringify(join(dir, ".sno", "identity.json"))}), true);`;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
				env: { ...process.env, HOME: dir }, encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to HOME when the operating system has no user record", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-identity-no-user-"));
		try {
			const script = `import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.userInfo = () => { throw new Error("no account record"); };
syncBuiltinESMExports();
const { bootstrapIdentity, isTestProfile, isValidIdentity } = await import(${JSON.stringify(new URL("../../../../packages/observability/dist/internal/identity.js", import.meta.url).href)});
assert.equal(isTestProfile(${JSON.stringify(join(dir, ".sno", "identity.json"))}), false);
assert.equal(isTestProfile(${JSON.stringify(join(dir, "test", "identity.json"))}), true);
const normal = bootstrapIdentity({ SNO_PROFILE_DIR: ${JSON.stringify(join(dir, ".sno"))} });
assert.ok(isValidIdentity(normal));
assert.equal(normal.user_cuid.startsWith("snotest"), false);
const test = bootstrapIdentity({ SNO_PROFILE_DIR: ${JSON.stringify(join(dir, "test"))} });
assert.match(test.user_cuid, /^snotest[0-9a-z]{17}$/u);`;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
				env: { ...process.env, HOME: dir, USERPROFILE: dir }, encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an existing ordinary identity unchanged in a test profile", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-identity-existing-"));
		const path = join(dir, "identity.json");
		const env = { SNO_IDENTITY_PATH: path };
		try {
			const existing = { ...bootstrapIdentity(env), user_cuid: createCuid2() };
			writeFileSync(path, JSON.stringify(existing));
			assert.deepEqual(bootstrapIdentity(env), existing);
			assert.deepEqual(updateIdentity((value) => value, env), existing);
			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), existing);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
