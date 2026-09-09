/** @file rem-update-stamp-migration.ts
 * @purpose Hard-cuts legacy job-keyed REM update stamps to source-derived stamps.
 * @boundary Metadata-only startup migration; memory text and facets remain unchanged.
 */

import { createHash } from "node:crypto";
import {
	getRemUpdateLocaleResource,
	REM_UPDATE_LOCALES,
	type RemUpdateRewriteConfig,
} from "../engine/rem/index.js";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

export function deriveRemUpdateStamp(input: {
	source: string;
	implementationVersion: string;
	memoryKind: "profile" | "episodic" | "state";
	locale: string;
	localeResource: RemUpdateRewriteConfig["localeResource"];
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function migrateLegacyRemUpdateStamps(sqlite: SqliteDatabaseLike): number {
	const rows = sqlite
		.prepare(
			`SELECT id, text, category, metadata FROM nodix_memories
			WHERE json_valid(metadata)
				AND json_type(metadata, '$.rem_update_idempotency_key') = 'text'
				AND json_extract(metadata, '$.rem_update_source_version') IS NULL`,
		)
		.all() as Array<{ id: string; text: string; category: string; metadata: string }>;
	let migrated = 0;
	for (const row of rows) {
		if (row.category !== "profile" && row.category !== "episodic") continue;
		const metadata = parseMetadata(row.metadata);
		const localeValue = metadata["locale"];
		const locale = REM_UPDATE_LOCALES.find((candidate) => candidate === localeValue) ?? "en";
		const history = sqlite
			.prepare("SELECT text FROM nodix_rem_memory_facets WHERE memory_id = ? AND facet = 'history'")
			.get(row.id) as { text: string } | undefined;
		const source = history?.text ?? row.text;
		const rewriteConfig: RemUpdateRewriteConfig = {
			implementationVersion: "rem-update-v1",
			memoryKind: row.category,
			locale,
			localeResource: getRemUpdateLocaleResource(locale),
		};
		const stamp = deriveRemUpdateStamp({ source, ...rewriteConfig });
		const nextMetadata = JSON.stringify({
			...metadata,
			rem_update_source_version: source,
			rem_update_rewrite_config: rewriteConfig,
			rem_update_idempotency_key: stamp,
			rem_update_result_text_sha256: createHash("sha256").update(row.text).digest("hex"),
		});
		sqlite.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?").run(nextMetadata, row.id);
		migrated += 1;
	}
	return migrated;
}

function parseMetadata(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("REM candidate metadata must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}
