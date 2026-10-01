export function crashAfter(point: string): void {
	if (
		process.env["SNO_STATION_CORE_TESTING"] === "1" &&
		process.env["SNO_STATION_CORE_CRASH_AFTER"] === point
	) {
		process.exit(137);
	}
}

export function forceCanaryFailure(): boolean {
	return (
		process.env["SNO_STATION_CORE_TESTING"] === "1" &&
		process.env["SNO_STATION_CORE_FORCE_CANARY_FAIL"] === "1"
	);
}
