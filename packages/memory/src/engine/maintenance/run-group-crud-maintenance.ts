import { FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_MEMORY_SNO_EXTRACT_PROFILE } from "../../model/signed-registry-constants";
/** @file run-group-crud-maintenance.ts
 * @purpose Runs group CRUD maintenance twice against one encrypted project store.
 * @boundary Explicit command only; reports are written as JSON lines to stdout.
 */

import { pathToFileURL } from "node:url";
import { createLogger } from "@snoai/utils/logger";
import { createAtomicGenericExtractionTransport } from "../extraction/atomic-generic-extractor";
import { createBProfileKeyingTransport } from "../extraction/atomic-profile-keying";
import { createEmbedder, type Embedder } from "../extraction/embedding-provider-client";
import { runGroupCrudMaintenancePass } from "./group-crud-maintenance";
import {
	createModelGroupCrudEntityIdentityJudgementPort,
	createModelGroupCrudStateKeyingJudgementPort,
} from "./group-crud-maintenance-ports";
import { readSettings } from "../../contract/profile";
import { settingsToPluginConfig } from "../../../config/settings";
import { createLlmClient } from "../../model/llm-client";
import { modelCallDestination } from "../../model/model-call-table";
import { pickLlmRoutingConfig } from "../../model/llm-mode-routing";
import { getSnoStationMemStateDir } from "../shared/paths";
import { initSqliteRuntime, openSqliteDatabase } from "../../store/sqlite-runtime";
import { withMemoryOperation } from "../operation-cancellation";

function readArguments(): { storePath: string } {
	const [storePath, extra] = process.argv.slice(2);
	if (storePath === undefined || extra !== undefined) {
		throw new Error("Usage: maintenance:group-crud <store-path>");
	}
	return { storePath };
}

async function main(): Promise<void> {
	const { storePath } = readArguments();
	const settings = readSettings();
	initSqliteRuntime(settings.store.encryptionKey);
	const sqlite = openSqliteDatabase(storePath, { fileMustExist: true });
	let embedder: Embedder | undefined;
	try {
		const pluginConfig = settingsToPluginConfig(settings);
		embedder = createEmbedder(pluginConfig.embedding, getSnoStationMemStateDir());
		const routing = pickLlmRoutingConfig(pluginConfig);
		// This command runs outside the memory service, so no plugin's host model is reachable from it:
		// a call runs here only when the table sends it to the Sno GPU; a host call is skipped like `off`.
		const runs = (id: "E8" | "E9" | "E12"): boolean => modelCallDestination(id, pluginConfig.mode, settings.modelCalls) === "sno-gpu";
		const skipped = (["E8", "E9", "E12"] as const).filter(id => modelCallDestination(id, pluginConfig.mode, settings.modelCalls) === "host");
		if (skipped.length > 0) {
			createLogger("sno-station-mem:group-crud-maintenance").warn("Host model calls skipped: no host is reachable from this command", { mode: pluginConfig.mode, call_ids: skipped }, {
				event_name: "memory.group_crud.host_calls_skipped", file: "packages/memory/src/engine/maintenance/run-group-crud-maintenance.ts",
				function: "main", site_id: "memory.group_crud.host_calls_skipped",
			});
		}
		const chatClient = runs("E8") || runs("E12") ? createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
			apiKey: settings.snoGpu.apiKey,
			baseURL: settings.snoGpu.baseUrl,
			timeoutMs: 60_000,
			routing,
		}) : undefined;
		const profileClient = runs("E9") ? createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_PROFILE,
			apiKey: settings.snoGpu.apiKey,
			baseURL: settings.snoGpu.baseUrl,
			timeoutMs: 60_000,
			routing,
		}) : undefined;
		const ports = {
			...(chatClient && runs("E8") ? { identityJudgement: createModelGroupCrudEntityIdentityJudgementPort(
				createAtomicGenericExtractionTransport(chatClient),
			) } : {}),
			...(chatClient && runs("E12") ? { stateKeying: createModelGroupCrudStateKeyingJudgementPort(chatClient) } : {}),
			...(profileClient ? { profileKeying: createBProfileKeyingTransport(profileClient) } : {}),
		};
		await withMemoryOperation("group-crud", undefined, async () => {
			console.log(
				JSON.stringify(await runGroupCrudMaintenancePass({ database: sqlite.db, embedder, ...ports })),
			);
			console.log(
				JSON.stringify(await runGroupCrudMaintenancePass({ database: sqlite.db, embedder, ...ports })),
			);
		});
	} finally {
		try {
			await embedder?.dispose();
		} finally {
			sqlite.db.close();
		}
	}
}

// Keep imports read-only while preserving direct command execution.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
