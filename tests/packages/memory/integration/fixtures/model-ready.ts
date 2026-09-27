import { setTimeout as delay } from "node:timers/promises";

/**
 * The service prepares its embedding model when it starts; until then a capture is only accepted
 * (`committed: false`) and recall answers `unavailable: "model-preparing"`. A test that proves what
 * happens after preparation waits here first. `recall` sends one recall on the service's own
 * contract (HTTP route, runtime pool or package client) in a probe session of its own.
 */
export async function untilModelReady(recall: (probe: { scope: { project: string; session: string }; query: string;
	options: { source: "native" } }) => Promise<unknown>, ms = 120_000): Promise<void> {
	const probe = { scope: { project: "global", session: "model-ready-probe" }, query: "model ready probe", options: { source: "native" as const } };
	const end = Date.now() + ms;
	let last: unknown;
	while (Date.now() < end) {
		last = await recall(probe);
		if (last && typeof last === "object" && "degraded" in last && last.degraded === false
			&& "recallId" in last && typeof last.recallId === "string"
			&& "contextText" in last && typeof last.contextText === "string" && !("unavailable" in last)) return;
		if (last && typeof last === "object" && "degraded" in last && last.degraded === false
			&& "unavailable" in last && last.unavailable === "model-preparing") {
			await delay(100);
			continue;
		}
		throw new Error(`model recall unavailable: ${JSON.stringify(last)}`);
	}
	throw new Error(`model still preparing after ${ms} ms: ${JSON.stringify(last)}`);
}
