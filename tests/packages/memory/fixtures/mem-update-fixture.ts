/** Shared real HTTP service and encrypted store for correction acceptance journeys. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { REM_SIDECAR_TOKEN_HEADER } from "../../../../packages/memory/src/contract/routes";
import { startRemSidecar } from "../../../../packages/memory/src/sidecar/server";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";
import { writeSettingsFixture, type SettingsDocument } from "./settings-file-fixture";
import { untilModelReady } from "../integration/fixtures/model-ready";
import type { MemoryEntry } from "../../../../packages/memory/src/engine/shared/types";

interface FixtureHttpBody {
	degraded: boolean;
	error?: string;
	reason?: string;
	contextText: string;
	memoryIds: string[];
	committed: boolean;
	result: {
		isError: boolean;
		content: Array<{ type: "text"; text: string }>;
		details: { id: string; errorCode: string; successorId: string };
		entry: MemoryEntry | null;
	};
}

export async function createMemUpdateFixture(embedder: Embedder, overrides: SettingsDocument = {}) {
	const database = createTestDb();
	const store = new MemoryStore({ dbPath: database.dbPath, embedder });
	const profile = dirname(database.dbPath);
	const scope = { principal: userInfo().username, project: "agent:mem-update", session: "correction-test" };
	writeSettingsFixture(profile, {
		mode: "local-first",
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		embedding: { cacheDir: "" },
		rerank: { mode: "none" },
		rem: { tick: false },
		telemetry: { memoryUsage: { enabled: false }, observe: { enabled: false } },
		...overrides,
	});
	let sidecar = await startRemSidecar();
	async function post(path: string, body: unknown, skin = "mem-update-test") {
		const response = await fetch(`http://127.0.0.1:${sidecar.port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-sno-station-mem-skin": skin,
				[REM_SIDECAR_TOKEN_HEADER]: JSON.parse(readFileSync(join(profile, "station", "sidecar.json"), "utf8")).token },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() as FixtureHttpBody };
	}
	try {
		const init = await post("/v1/init", { scope, registration: { skinId: "mem-update-test" } });
		if (init.body.degraded) throw new Error(`test registration failed: ${JSON.stringify(init.body)}`);
		await untilModelReady(async ({ scope: probe, ...recall }) =>
			(await post("/v1/get-recall", { ...recall, scope: { ...scope, ...probe } })).body);
	} catch (error) {
		await sidecar.stop();
		await store.close();
		database.cleanup();
		throw error;
	}
	return {
		database, store, profile, scope, post,
		async restart() {
			await sidecar.stop();
			sidecar = await startRemSidecar();
			const init = await post("/v1/init", { scope, registration: { skinId: "mem-update-test" } });
			if (init.body.degraded) throw new Error(`test registration failed: ${JSON.stringify(init.body)}`);
			await untilModelReady(async ({ scope: probe, ...recall }) =>
				(await post("/v1/get-recall", { ...recall, scope: { ...scope, ...probe } })).body);
		},
		async close() {
			await sidecar.stop();
			await store.close();
			database.cleanup();
		},
	};
}
