// Observe v2 (QCG-5): the seeded agent.identify row carries locale, os and hashed person hints
// read from the user's HOME. Real SDK, real buffer.db, temporary profile and HOME.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { createSnoObserve } from "../../../../packages/observability/dist/index.js";
import { InvalidEventPayloadError } from "../../../../packages/observability/dist/internal/errors.js";
import { parseEventInput } from "../../../../packages/observability/dist/internal/schemas.js";
import {
	cleanupTempSnoEnv,
	createFetchRecorder,
	createTempSnoEnv,
	validPayloads,
} from "../fixtures/temp-env.mjs";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Emits one memory.write under a HOME prepared by `prepareHome`; returns the seeded identify payload. */
async function seededIdentify(prepareHome) {
	const temp = createTempSnoEnv("sno-observe-identify-");
	prepareHome(temp.dir);
	const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	process.env.HOME = temp.dir;
	delete process.env.XDG_CONFIG_HOME;
	const observe = createSnoObserve({ env: temp.env, cwd: temp.dir, fetch: createFetchRecorder().fetch });
	try {
		await observe.emit({
			event_type: "memory.write",
			lane: "memory",
			agent_id: "claude-code",
			payload: validPayloads["memory.write"],
		});
		const db = new DatabaseConstructor(temp.env.SNO_BUFFER_PATH, { readonly: true });
		try {
			const envelopes = db
				.prepare("SELECT payload FROM events ORDER BY rowid")
				.all()
				.map((row) => JSON.parse(String(row.payload)));
			const identify = envelopes.filter((envelope) => envelope.event_type === "agent.identify");
			assert.equal(identify.length, 1);
			return identify[0].payload;
		} finally {
			db.close();
		}
	} finally {
		await observe.shutdown();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		cleanupTempSnoEnv(temp);
	}
}

function identifyEvent(extra) {
	return {
		event_type: "agent.identify",
		lane: "memory",
		agent_id: "codex",
		payload: { ...validPayloads["agent.identify"], ...extra },
	};
}

describe("observe v2 agent.identify fields", () => {
	it("seeds locale, os and the claude and git person hints from HOME", async () => {
		const payload = await seededIdentify((home) => {
			writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "ACCT-A" } }));
			writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = A\n\temail = A@Example.org\n");
		});
		assert.equal(payload.locale, Intl.DateTimeFormat().resolvedOptions().locale);
		assert.equal(payload.os, process.platform);
		assert.deepEqual(payload.person_hints, [
			{ kind: "claude_account", hash: sha256("acct-a") },
			{ kind: "git_email", hash: sha256("a@example.org") },
		]);
	});

	it("omits person_hints under an empty HOME", async () => {
		const payload = await seededIdentify(() => {});
		assert.equal(payload.os, process.platform);
		assert.equal(Object.hasOwn(payload, "person_hints"), false);
	});

	it("keeps locale, os and person_hints optional and bounds person_hints", () => {
		parseEventInput(identifyEvent({}));
		const hints = [
			{ kind: "claude_account", hash: sha256("acct-a") },
			{ kind: "tailscale_user", hash: sha256("a@example.org") },
		];
		const parsed = parseEventInput(identifyEvent({ locale: "en-US", os: "linux", person_hints: hints }));
		assert.deepEqual(parsed.payload.person_hints, hints);

		for (const person_hints of [
			[],
			[{ kind: "git_email", hash: "a".repeat(63) }],
			Array.from({ length: 17 }, () => hints[0]),
		]) {
			assert.throws(() => parseEventInput(identifyEvent({ person_hints })), InvalidEventPayloadError);
		}
	});
});
