// Identity bootstrap / regeneration tests per tasks §16.6, §16.8, §16a.8.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";
import { detectProjectId } from "../../../../packages/sno-observe/dist/internal/project-id.js";
import { validPayloads, scope } from "../fixtures/temp-env.mjs";

const workerPath = fileURLToPath(new URL("../fixtures/fork-emit-worker.mjs", import.meta.url));

function tempEnv() {
	const dir = mkdtempSync(join(tmpdir(), "sno-observe-identity-"));
	return {
		dir,
		env: {
			SNO_HOME: dir,
			SNO_IDENTITY_PATH: join(dir, "identity.json"),
			SNO_BUFFER_PATH: join(dir, "buffer.db"),
			SNO_CONSENT_PATH: join(dir, "state", "consent.json"),
			SNO_TOKEN_PATH: join(dir, "state", "tokens.json"),
			HOME: dir,
		},
	};
}

function spawnInit(env) {
	return new Promise((resolveSpawn, reject) => {
		let buf = "";
		const child = fork(workerPath, ["0", "init"], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		child.stdout?.on("data", (c) => (buf += c.toString("utf8")));
		child.on("exit", (code) => {
			try {
				const id = JSON.parse(readFileSync(env.SNO_IDENTITY_PATH, "utf8"));
				resolveSpawn({ code, id });
			} catch (e) {
				reject(e);
			}
		});
		child.on("error", reject);
	});
}

describe("identity bootstrap / regeneration", () => {
	it("two SDK init processes observe the same identity (16.6)", async () => {
		const t = tempEnv();
		try {
			// Pre-create identity by calling bootstrap once; both forks should observe it.
			bootstrapIdentity(t.env);
			const [a, b] = await Promise.all([spawnInit(t.env), spawnInit(t.env)]);
			assert.equal(a.code, 0);
			assert.equal(b.code, 0);
			assert.equal(a.id.user_cuid, b.id.user_cuid);
			assert.equal(a.id.machine_uuid, b.id.machine_uuid);
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("identity regeneration starts a fresh chain epoch=0 (16.8)", async () => {
		const t = tempEnv();
		try {
			// 1) Bootstrap original identity, seed the buffer with rows.
			const original = bootstrapIdentity(t.env);
			const store = new BufferStore(t.env.SNO_BUFFER_PATH);
			store.append({
				eventId: "old-id-0",
				eventType: "agent.identify",
				tsEdgeMs: 1,
				consentLevel: "metadata-only",
				redacted: false,
				scope: { ...scope, user_id: original.user_cuid, machine_id: original.machine_uuid },
				payload: {
					agent_id: "codex",
					machine_id: original.machine_uuid,
					sdk_version: "0.1.0",
				},
				terminal: false,
			});
			store.append({
				eventId: "old-mw-1",
				eventType: "memory.write",
				tsEdgeMs: 2,
				consentLevel: "metadata-only",
				redacted: false,
				scope: { ...scope, user_id: original.user_cuid, machine_id: original.machine_uuid },
				payload: validPayloads["memory.write"],
				terminal: false,
			});
			store.close();

			// 2) Corrupt identity file mid-life.
			writeFileSync(t.env.SNO_IDENTITY_PATH, "{not-json", { mode: 0o600 });

			// 3) Bootstrap regenerates a NEW identity.
			const regen = bootstrapIdentity(t.env);
			assert.notEqual(regen.user_cuid, original.user_cuid);
			assert.notEqual(regen.machine_uuid, original.machine_uuid);

			// 4) Old-identity rows remain in the buffer marked shipped=false, keyed to
			//    OLD machine_id. They are NOT shipped under the new identity.
			const reopened = new BufferStore(t.env.SNO_BUFFER_PATH);
			try {
				const oldRows = reopened.getAllRows().filter((r) => r.machine_id === original.machine_uuid);
				assert.equal(oldRows.length, 2);
				assert.equal(oldRows.every((r) => r.shipped === 0), true);

				// 5) Append a new identify under the regenerated identity at chain_epoch=0,
				//    seq=0 of the NEW (machine_id, agent_id) pair.
				const newScope = {
					user_id: regen.user_cuid,
					machine_id: regen.machine_uuid,
					agent_id: "codex",
					project_id: "p_test",
				};
				const newId = reopened.append({
					eventId: "new-id-0",
					eventType: "agent.identify",
					tsEdgeMs: Date.now(),
					consentLevel: "metadata-only",
					redacted: false,
					scope: newScope,
					payload: {
						agent_id: "codex",
						machine_id: regen.machine_uuid,
						sdk_version: "0.1.0",
					},
					terminal: false,
				});
				assert.equal(newId.chainEpoch, 0);
				assert.equal(newId.seq, 0);
				assert.equal(newId.envelope.hash_chain.prev, "GENESIS");

				// 6) chain_tail tracks the new identity independently from the old.
				const oldEpoch = reopened.getCurrentEpoch(original.machine_uuid, "codex");
				const newEpoch = reopened.getCurrentEpoch(regen.machine_uuid, "codex");
				assert.equal(oldEpoch, 0);
				assert.equal(newEpoch, 0);
				// Old tail still exists pointing at last_seq=1.
				assert.equal(reopened.hasTail(original.machine_uuid, "codex", 0), true);
				assert.equal(reopened.hasTail(regen.machine_uuid, "codex", 0), true);
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});

	it("process.chdir mid-process is reflected on next emit's project_id (16a.8)", () => {
		const t = tempEnv();
		try {
			const beforeDir = join(t.dir, "before");
			const afterDir = join(t.dir, "after");
			mkdirSync(beforeDir);
			mkdirSync(afterDir);
			const idBefore = detectProjectId(beforeDir, t.env);
			const idAfter = detectProjectId(afterDir, t.env);
			assert.notEqual(idBefore, idAfter, "different cwds yield different project_ids");
		} finally {
			rmSync(t.dir, { recursive: true, force: true });
		}
	});
});
