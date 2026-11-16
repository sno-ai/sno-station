export interface RemStatementLike {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): unknown;
}

export interface RemTransactionLike {
	(...args: unknown[]): unknown;
	immediate(...args: unknown[]): unknown;
}

export interface RemDatabaseLike {
	prepare(sql: string): RemStatementLike;
	exec(sql: string): unknown;
	transaction(fn: (...args: never[]) => unknown): RemTransactionLike;
}
