export function crashAfter(point: string): void {
	if (
		process.env["NODIX_TESTING"] === "1" &&
		process.env["NODIX_CRASH_AFTER"] === point
	) {
		process.exit(137);
	}
}

export function forceCanaryFailure(): boolean {
	return (
		process.env["NODIX_TESTING"] === "1" &&
		process.env["NODIX_FORCE_CANARY_FAIL"] === "1"
	);
}
