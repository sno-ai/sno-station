/** @file todo-store.ts
 * @purpose Enforces count parity between lifecycle task identities and dedicated to-do rows.
 * @boundary Runs after schema migration on every store open; performs no migration itself.
 */

import { StorageError } from "../engine/shared/errors";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

interface TodoStoreCounts {
	beforeCount: number;
	afterCount: number;
}

export function assertTodoStoreCountParity(database: SqliteDatabaseLike): TodoStoreCounts {
	const row = database
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM nodix_active_task_instances) AS beforeCount,
				(SELECT COUNT(*) FROM nodix_todos) AS afterCount`,
		)
		.get() as { beforeCount: number | bigint; afterCount: number | bigint };
	const counts = {
		beforeCount: Number(row.beforeCount),
		afterCount: Number(row.afterCount),
	};
	if (counts.beforeCount !== counts.afterCount) {
		throw new StorageError(
			`To-do migration count mismatch: before=${counts.beforeCount}, after=${counts.afterCount}`,
		);
	}
	return counts;
}

export function countTodoTransitionsWithoutSource(database: SqliteDatabaseLike): number {
	const row = database
		.prepare(
			`SELECT COUNT(*) AS count
			FROM nodix_active_task_transitions AS transition_row
			LEFT JOIN nodix_task_lifecycle_commands AS command
				ON command.project_id = transition_row.project_id
				AND command.command_id = transition_row.command_id
			WHERE command.command_id IS NULL
				OR NOT json_valid(command.identity_json)
				OR COALESCE(
					json_extract(command.identity_json, '$.sessionKey'),
					json_extract(command.identity_json, '$.canonicalTuple[2]')
				) IS NULL`,
		)
		.get() as { count: number | bigint };
	return Number(row.count);
}
