import { FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_MEMORY_SNO_EXTRACT_PROFILE, FIXED_PROTOCOL_VALUE_74 } from "../../model/signed-registry-constants";
/** @file run-group-crud-maintenance.ts
 * @purpose Runs group CRUD maintenance twice against one encrypted project store.
 * @boundary Explicit command only; reports are written as JSON lines to stdout.
 */

import { pathToFileURL } from "node:url";
import { createAtomicGenericExtractionTransport } from "../extraction/atomic-generic-extractor";
import { createBProfileKeyingTransport } from "../extraction/atomic-profile-keying";
import { createEmbedder, type Embedder } from "../extraction/embedding-provider-client";
import { runGroupCrudMaintenancePass } from "./group-crud-maintenance";
import {
	createModelGroupCrudEntityIdentityJudgementPort,
	createModelGroupCrudStateKeyingJudgementPort,
} from "./group-crud-maintenance-ports";
import { readSnoStationMemConfig, resolveSnoStationMemConfigPath } from "../bindings/embedder-config-files";
import { createLlmClient } from "../../model/llm-client";
import { MODEL_CALLS } from "../../model/model-call-table";
import { pickLlmRoutingConfig } from "../../model/llm-mode-routing";
import { getSnoStationMemStateDir } from "../shared/paths";
import { pluginConfigSchema } from "../shared/types";
import { initSqliteRuntimeSync, openSqliteDatabase } from "../../store/sqlite-runtime";

function readArguments(): { storePath: string } {
	const [storePath, extra] = process.argv.slice(2);
	if (storePath === undefined || extra !== undefined) {
		throw new Error("Usage: maintenance:group-crud <store-path>");
	}
	return { storePath };
}

async function main(): Promise<void> {
	const { storePath } = readArguments();
	initSqliteRuntimeSync();
	const sqlite = openSqliteDatabase(storePath, { fileMustExist: true });
	let embedder: Embedder | undefined;
	try {
		const hostConfig = readSnoStationMemConfig(resolveSnoStationMemConfigPath());
		const pluginConfig = pluginConfigSchema.parse(
			hostConfig?.plugins?.entries?.[FIXED_PROTOCOL_VALUE_74]?.config ?? {},
		);
		embedder = createEmbedder(pluginConfig.embedding, getSnoStationMemStateDir());
		const routing = pickLlmRoutingConfig(pluginConfig);
		const chatClient = ["E8", "E12"].some(id => MODEL_CALLS[id as "E8" | "E12"].destinations[pluginConfig.mode] !== "off") ? createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_CHAT,
			timeoutMs: 60_000,
			routing,
		}) : undefined;
		const profileClient = MODEL_CALLS.E9.destinations[pluginConfig.mode] !== "off" ? createLlmClient({
			preset: FIXED_MEMORY_SNO_EXTRACT_PROFILE,
			timeoutMs: 60_000,
			routing,
		}) : undefined;
		const ports = {
			...(chatClient && MODEL_CALLS.E8.destinations[pluginConfig.mode] !== "off" ? { identityJudgement: createModelGroupCrudEntityIdentityJudgementPort(
				createAtomicGenericExtractionTransport(chatClient),
			) } : {}),
			...(chatClient && MODEL_CALLS.E12.destinations[pluginConfig.mode] !== "off" ? { stateKeying: createModelGroupCrudStateKeyingJudgementPort(chatClient) } : {}),
			...(profileClient ? { profileKeying: createBProfileKeyingTransport(profileClient) } : {}),
		};
		console.log(
			JSON.stringify(await runGroupCrudMaintenancePass({ database: sqlite.db, embedder, ...ports })),
		);
		console.log(
			JSON.stringify(await runGroupCrudMaintenancePass({ database: sqlite.db, embedder, ...ports })),
		);
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
