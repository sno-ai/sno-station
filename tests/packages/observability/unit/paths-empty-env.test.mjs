import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	getSnoProfileDir, getIdentityPath, getIdentityLockPath, getBufferPath, getConsentPath, getPausePath, getLogPath,
} from "../../../../packages/observability/dist/internal/paths.js";

test("an empty profile directory uses the ordinary default paths", () => {
	const env = { SNO_PROFILE_DIR: "" };
	const profile = join(homedir(), ".sno");
	assert.deepEqual([
		getSnoProfileDir(env), getIdentityPath(env), getIdentityLockPath(env), getBufferPath(env),
		getConsentPath(env), getPausePath(env), getLogPath(env),
	], [profile, join(profile, "identity.json"), join(profile, "identity.lock"), join(profile, "buffer.db"),
		join(profile, "state", "consent.json"), join(profile, "state", "consent-prior.json"), join(profile, "observe.log")]);
});

test("empty file overrides use the selected profile while nonempty overrides remain exact", () => {
	const profile = join(tmpdir(), "sno-selected-profile");
	const env = { SNO_PROFILE_DIR: profile, SNO_IDENTITY_PATH: "", SNO_BUFFER_PATH: "", SNO_CONSENT_PATH: "" };
	assert.deepEqual([getIdentityPath(env), getBufferPath(env), getConsentPath(env)],
		[join(profile, "identity.json"), join(profile, "buffer.db"), join(profile, "state", "consent.json")]);
	assert.deepEqual([getIdentityPath({ ...env, SNO_IDENTITY_PATH: "custom-identity.json" }),
		getBufferPath({ ...env, SNO_BUFFER_PATH: "custom-buffer.db" }),
		getConsentPath({ ...env, SNO_CONSENT_PATH: "custom-consent.json" })],
		["custom-identity.json", "custom-buffer.db", "custom-consent.json"]);
});

test("bootstrap persists an identity in the selected profile when its file override is empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "sno-empty-identity-"));
	try {
		const profile = join(dir, "profile");
		const module = new URL("../../../../packages/observability/dist/internal/identity.js", import.meta.url).href;
		const script = `import { bootstrapIdentity } from ${JSON.stringify(module)};
console.log(JSON.stringify(bootstrapIdentity({ SNO_PROFILE_DIR: ${JSON.stringify(profile)}, SNO_IDENTITY_PATH: "" })));`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(profile, "identity.json"), "utf8")), JSON.parse(result.stdout));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
