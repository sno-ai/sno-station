import { createHash, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

type JsonRecord = Record<string, unknown>;

export function seedProductionMemory(
	database: BetterSqlite3.Database,
	input: {
		id?: string;
		metadata?: JsonRecord;
		scope: string;
		text: string;
		timestamp?: string;
	},
): string {
	const id = input.id ?? `clrem${randomUUID().replaceAll("-", "")}`;
	const timestamp = Date.parse(input.timestamp ?? "2026-08-09T08:00:00.000Z");
	database
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?)`,
		)
		.run(
			id,
			input.text,
			input.scope,
			timestamp,
			JSON.stringify(input.metadata ?? { section_name: "preferences.production-reachability" }),
			createHash("sha256").update(input.text).digest("hex"),
			`fact-${id}`,
			JSON.stringify({ evidence: input.text }),
		);
	return id;
}
