/** @file todo-store.ts
 * @purpose Counts to-do state changes whose source lifecycle command is missing or carries no session.
 * @boundary Read-only; performs no migration itself.
 */

import type { SqliteDatabaseLike } from "./sqlite-runtime";

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
