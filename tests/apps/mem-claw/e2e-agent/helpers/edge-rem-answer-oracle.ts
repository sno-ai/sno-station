export function assertEdgeRemAnswerShape(input: {
	answer: string;
	forbidden: string;
	required: string;
}): void {
	if (input.answer.includes(input.forbidden)) {
		throw new Error("edge REM answer contains the forbidden value");
	}
	if (input.answer.trim() !== input.required) {
		throw new Error("edge REM answer must equal the exact current value");
	}
}

export function assertEdgeRemSoftCloseSurface(input: {
	currentChunkCount: unknown;
	historyChunkCount: unknown;
	successorId: string;
	supersededBy: unknown;
}): void {
	if (input.supersededBy !== input.successorId) {
		throw new Error("edge REM stale row does not point to the current successor");
	}
	if (input.currentChunkCount !== 0) {
		throw new Error("edge REM stale row remains on the current serving index");
	}
	if (
		typeof input.historyChunkCount !== "number" ||
		!Number.isInteger(input.historyChunkCount) ||
		input.historyChunkCount < 1
	) {
		throw new Error("edge REM stale row is missing from the history index");
	}
}

export function assertEdgeRemFinalAnswer(input: {
	activeStaleRows: number;
	answer: string;
	forbidden: string;
	required: string;
}): void {
	if (input.activeStaleRows !== 0) {
		throw new Error("edge REM final answer has active stale public state");
	}
	assertEdgeRemAnswerShape(input);
}

export function assertEdgeRemJobDone(input: {
	jobType: "rem-update" | "rem-replace";
	state: unknown;
}): void {
	if (input.state !== "done") {
		throw new Error(
			`edge REM ${input.jobType} terminal state must be done, received ${String(input.state)}`,
		);
	}
}

export function readEdgeRemJobOperations(input: {
	job: Record<string, unknown>;
	jobType: "rem-update" | "rem-replace";
}): number {
	const stats = input.job["stats"];
	const operations =
		typeof stats === "object" && stats !== null && !Array.isArray(stats)
			? (stats as Record<string, unknown>)["operations"]
			: undefined;
	if (typeof operations !== "number" || !Number.isInteger(operations) || operations < 0) {
		throw new Error(
			`edge REM ${input.jobType} result must report a non-negative integer operation count`,
		);
	}
	return operations;
}

export function assertEdgeRemPairVerdictRecorded(pair: Record<string, unknown>): void {
	if (pair["checkpoint"] !== "verdict_recorded" && pair["checkpoint"] !== "action_applied") {
		throw new Error(`replacement pair did not record a verdict: ${JSON.stringify(pair)}`);
	}
}

export function assertEdgeRemDefaultOffState(
	before: readonly Record<string, unknown>[],
	after: readonly Record<string, unknown>[],
): void {
	if (stableRows(before) !== stableRows(after)) {
		throw new Error("edge REM default-off public state changed");
	}
}

export function assertBackdatedFixtureOrder(input: {
	current: { seedOrdinal: number; validFrom: string };
	retired: { seedOrdinal: number; validFrom: string };
}): void {
	if (input.current.seedOrdinal >= input.retired.seedOrdinal) {
		throw new Error("edge REM insertion order must oppose valid-time order");
	}
	const currentValidFrom = Date.parse(input.current.validFrom);
	const retiredValidFrom = Date.parse(input.retired.validFrom);
	if (
		!Number.isFinite(currentValidFrom) ||
		!Number.isFinite(retiredValidFrom) ||
		retiredValidFrom >= currentValidFrom
	) {
		throw new Error("edge REM fixture requires a back-dated retired row");
	}
}

function stableRows(rows: readonly Record<string, unknown>[]): string {
	return JSON.stringify(
		rows
			.map((row) => stableValue(row))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stableValue(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}
