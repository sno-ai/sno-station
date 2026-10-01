/** @file four-plugin-registration.test.ts
 * @purpose Codex, Claude Code, Hermes and OpenClaw each register with the real memory service and capture once
 * (rem-enhanced PRD REQ-3): a routing key the schema no longer accepts, left in any registration writer, fails here.
 * @boundary Real in-process sidecar, SQLite store and embeddings; each plugin's own registration writer.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SKIN_ID as CLAUDE_SKIN_ID } from "../../../../apps/mem-claude/src/constants";
import { SKIN_ID as OPENCLAW_SKIN_ID } from "../../../../apps/mem-claw/src/constants";
import { createMemoryConnection } from "../../../../apps/mem-claw/src/install/memory-connection";
import { SKIN_ID as CODEX_SKIN_ID } from "../../../../apps/mem-codex/src/constants";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture";
import { untilModelReady } from "../../../packages/memory/integration/fixtures/model-ready";
import { createTestDb } from "../helpers/test-db";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "four-plugin-registration-"));
	database = createTestDb();
	vi.stubEnv("SNO_PROFILE_DIR", root);
});
afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	vi.unstubAllEnvs();
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
});

const stored = (sentence: string) => (database.sqlite.prepare("SELECT count(*) AS count FROM nodix_memories WHERE text LIKE ?")
	.get(`%${sentence}%`) as { count: number }).count;
const turn = (turnId: string, sentence: string) => ({ turnId, rewindEpoch: 0, messages: [{ role: "user" as const, content: sentence, at: 1789606800000 }] });

it("registers and captures once from each of the four plugins", { timeout: 180_000 }, async () => {
	// Local First stores a captured sentence without a model call, so a failure here is the registration's.
	writeSettingsFixture(root, { mode: "local-first", store: { path: database.dbPath, encryptionKey: database.encryptionKey }, rerank: { mode: "none" }, embedding: { cacheDir: "" } });
	sidecar = await startRemSidecar();
	const post = async (path: string, skin: string, body: unknown) => {
		if (!sidecar) throw new Error("missing test sidecar");
		const { token } = JSON.parse(readFileSync(join(root, "station", "sidecar.json"), "utf8")) as { token: string };
		const response = await fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
			method: "POST", headers: { "x-sno-station-mem-skin": skin, "x-sidecar-token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
		});
		return { status: response.status, body: await response.json() as { degraded?: boolean; toolResult?: { details?: { memories?: Array<{ text: string }> } } } };
	};
	const outcomes: Record<string, unknown> = {};
	await untilModelReady(async ({ scope, ...recall }) => (await post("/v1/get-recall", CODEX_SKIN_ID,
		{ ...recall, scope: { ...scope, principal: userInfo().username } })).body);
	// Codex, Claude Code and Hermes send only their identity and host model.
	for (const skinId of [CODEX_SKIN_ID, CLAUDE_SKIN_ID, "hermes"]) {
		const scope = { principal: "caller", project: "/workspace", session: `${skinId}-session` };
		const sentence = `The ${skinId} plugin keeps meeting notes in a blue notebook.`;
		const init = await post("/v1/init", skinId, { scope, registration: { skinId,
			model: { baseUrl: "http://127.0.0.1:9/host/v1/", credential: "loopback-credential", model: "loopback-model" } } });
		const capture = await post("/v1/capture", skinId, { scope, turn: turn(`${skinId}-turn`, sentence) });
		const recall = await post("/v1/get-recall", skinId, { scope, query: `Where does the ${skinId} plugin keep meeting notes?`, options: { source: "manual", minScore: 0 } });
		outcomes[skinId] = { init: init.status, initDegraded: init.body.degraded ?? false, capture: capture.status, stored: stored(sentence), recalled: recall.body.toolResult?.details?.memories?.some(row => row.text.includes(sentence)) ?? false };
	}
	// OpenClaw registers through its own connection writer.
	const connection = createMemoryConnection({ config: {}, logger: { error() {} } } as unknown as OpenClawPluginApi);
	try {
		const sentence = "The OpenClaw plugin keeps meeting notes in a blue notebook.";
		const client = await connection.ready();
		const scope = { principal: client.principal, project: "/workspace", session: "openclaw-session" };
		const capture = await client.capture(turn("openclaw-turn", sentence), scope);
		const recall = await client.getRecall("Where does the OpenClaw plugin keep meeting notes?", scope, { source: "manual", minScore: 0 });
		outcomes[OPENCLAW_SKIN_ID] = { init: 200, initDegraded: false, capture: capture.degraded ? 503 : 200, stored: stored(sentence), recalled: JSON.stringify(recall.toolResult?.details?.memories ?? []).includes(sentence) };
	} finally {
		await connection.close();
	}
	const registered = { init: 200, initDegraded: false, capture: 200, stored: 1, recalled: true };
	expect(outcomes).toEqual({ [CODEX_SKIN_ID]: registered, [CLAUDE_SKIN_ID]: registered, hermes: registered, [OPENCLAW_SKIN_ID]: registered });
});
