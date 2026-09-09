/** @file memory-store-todo-api.ts
 * @purpose Reads the scoped to-do list for recall.
 * @boundary Prototype-mounted MemoryStore read method; no ranking behavior.
 */

import {
	MemoryStore,
	type MemoryStoreInternals,
	type TodoListInput,
	type TodoListResult,
	type TodoRecord,
} from "./memory-store-base";

Object.assign(MemoryStore.prototype, {
	listTodos(this: MemoryStoreInternals, input: TodoListInput): TodoListResult {
		if (input.projectIdFilter.length === 0) return { items: [], totalCount: 0 };
		const scopeJson = JSON.stringify(input.projectIdFilter);
		const statusClause = input.includeHistory ? "" : " AND status = 'open'";
		const whereClause = `project_id IN (SELECT value FROM json_each(?))${statusClause}`;
		const countRow = this.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM nodix_todos WHERE ${whereClause}`)
			.get(scopeJson) as { count: number | bigint };
		const items = this.sqlite
			.prepare(
				`SELECT project_id AS projectId, active_task_id AS activeTaskId,
					description, status, opened_at AS openedAt, closed_at AS closedAt,
					close_reason AS closeReason
				FROM nodix_todos
				WHERE ${whereClause}
				ORDER BY opened_at ASC, active_task_id ASC
				LIMIT ?`,
			)
			.all(scopeJson, input.limit) as TodoRecord[];
		return { items, totalCount: Number(countRow.count) };
	},
});
