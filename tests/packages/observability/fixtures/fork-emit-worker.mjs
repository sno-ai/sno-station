// Forked worker for cross-process chain tests. Reads SNO_HOME from env, opens the
// shared buffer.db via BufferStore, and emits N memory.write events. Reports a JSON
// summary on stdout.
//
// Mirrors SnoObserveRuntime.emitParsed() semantics: at the start, if no tail exists
// for (machine, agent, epoch=0), attempt to seed agent.identify; on race-loss
// (UNIQUE constraint OR ChainSeedError on retry), skip the identify and proceed —
// the actual event then appends at seq>=1 with prev = winning identify's self_hash.

import { BufferStore } from "../../../../packages/sno-observe/dist/internal/buffer-store.js";
import { bootstrapIdentity } from "../../../../packages/sno-observe/dist/internal/identity.js";

const count = Number(process.argv[2] ?? "0");
const label = process.argv[3] ?? "w";

const env = {
	SNO_HOME: process.env.SNO_HOME,
	SNO_IDENTITY_PATH: process.env.SNO_IDENTITY_PATH,
	SNO_BUFFER_PATH: process.env.SNO_BUFFER_PATH,
	SNO_CONSENT_PATH: process.env.SNO_CONSENT_PATH,
	SNO_TOKEN_PATH: process.env.SNO_TOKEN_PATH,
	HOME: process.env.SNO_HOME,
};

const identity = bootstrapIdentity(env);
const store = new BufferStore(env.SNO_BUFFER_PATH);

const scope = {
	user_id: identity.user_cuid,
	machine_id: identity.machine_uuid,
	agent_id: "codex",
	project_id: "p_test",
};

let appended = 0;
let firstEnsureIdentify = false;

function ensureIdentifyOnce() {
	if (store.hasTail(identity.machine_uuid, "codex", 0)) {
		return;
	}
	try {
		store.append({
			eventId: `${label}-id-seed`,
			eventType: "agent.identify",
			tsEdgeMs: Date.now(),
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: {
				agent_id: "codex",
				machine_id: identity.machine_uuid,
				sdk_version: "0.1.0",
			},
			terminal: false,
			chainEpoch: 0,
		});
		firstEnsureIdentify = true;
	} catch (err) {
		// Race: peer process seeded between our hasTail() and append(). The retry
		// path inside appendOnce will try seq=1 with type=agent.identify; we'd
		// rather skip than emit a duplicate identify, so swallow ChainContention.
		if (!/ChainContention|UNIQUE|ChainSeedError/u.test(String(err))) {
			throw err;
		}
	}
}

try {
	ensureIdentifyOnce();
	for (let i = 0; i < count; i += 1) {
		store.append({
			eventId: `${label}-mw-${i}`,
			eventType: "memory.write",
			tsEdgeMs: Date.now(),
			consentLevel: "metadata-only",
			redacted: false,
			scope,
			payload: {
				key_hash: `h-${label}-${i}`,
				byte_len: 1,
				content_tokens: 1,
				tokens_method: "fast",
			},
			terminal: false,
			chainEpoch: 0,
		});
		appended += 1;
	}
} catch (error) {
	process.stdout.write(
		JSON.stringify({ ok: false, error: error?.message ?? String(error), label, appended }) + "\n",
	);
	store.close();
	process.exit(1);
}

store.close();
process.stdout.write(JSON.stringify({ ok: true, label, appended, firstEnsureIdentify }) + "\n");
process.exit(0);
