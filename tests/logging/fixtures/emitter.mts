import { readFileSync } from "node:fs";
import { createLogger, closeLogger, configureLogger, withLogContext, currentLogContext } from "../../../packages/utils/src/logger.ts";
import { buildLogCatalog } from "../../../apps/mem-claw/scripts/build-log-catalog.ts";

const catalog = buildLogCatalog([{ path: "tests/logging/fixtures/emitter.mts", text: readFileSync(import.meta.filename, "utf8") }]);
const version = JSON.parse(readFileSync(new URL("../../../apps/mem-claw/package.json", import.meta.url), "utf8")).version;
// argv: <mode> <state home> [file override]; the caller owns level, file and home.
configureLogger({ app: "mem-claw", serviceVersion: version, buildId: catalog.build_id, catalog,
	level: "info", home: process.argv[3], file: process.argv[4] || undefined });

const log = createLogger("mem-claw:logging-test");

async function emitFixture(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "context") {
		await Promise.all(["alpha", "beta"].map((name, index) => withLogContext({
			operation_id: `operation-${name}`, session_reference: `private-session-${name}`,
			external_reference: `reference-${name}`, external_reference_visibility: index ? "public" : "private",
		}, async () => {
			await new Promise(resolve => setTimeout(resolve, index ? 5 : 15));
			contextRecord("parent");
			await withLogContext({ attempt_id: `attempt-${name}` }, async () => {
				await new Promise(resolve => setTimeout(resolve, index ? 15 : 5));
				contextRecord("attempt");
			});
			contextRecord("restored");
		})));
		contextRecord("outside");
		for (const reference of ["", " ", "x".repeat(129)]) {
			withLogContext({ external_reference: reference, external_reference_visibility: "public" }, () => contextRecord("invalid"));
		}
		return;
	}
	if (mode === "bounds") {
		let attributeReads = 0;
		const hostile = new Proxy({}, { ownKeys() { attributeReads++; throw new Error("disabled serialization executed"); } });
		const returned = log.debug("Disabled event", hostile, {
			event_name: "diagnostic.test.disabled", file: "tests/logging/fixtures/emitter.mts",
			function: "emitFixture", site_id: "diagnostic.test.disabled",
		});
		if (returned) throw new Error("Disabled event emitted");
		if (attributeReads !== 0) throw new Error("Disabled event accessed its attributes");
		log.info("Large diagnostic", { values: Array.from({ length: 128 }, () => ({ file: "x".repeat(1024) })) }, {
			event_name: "diagnostic.test.large", file: "tests/logging/fixtures/emitter.mts",
			function: "emitFixture", site_id: "diagnostic.test.large",
		});
		return;
	}
	if (mode === "privacy") {
		const cause = new Error("private-cause-sentinel");
		const error = new Error("private-message-sentinel", { cause });
		Object.assign(error, { code: "EIO" });
		log.error("Diagnostic fixture failed", {
			error,
			query: "private-query-sentinel",
			claimText: "private-memory-sentinel",
			nested: { authorization: "private-key-sentinel" },
			endpoint: "https://private-key-sentinel:private-message-sentinel@example.com/private-query-sentinel?token=private-key-sentinel#private-memory-sentinel",
			dek: "a1".repeat(32),
			config_hash: "b2".repeat(32),
			trace_id: "c3".repeat(16),
		}, {
			event_name: "diagnostic.test.failed",
			file: "tests/logging/fixtures/emitter.mts",
			function: "emitFixture",
			site_id: "diagnostic.test.failed",
		});
		return;
	}
	log.info("Diagnostic fixture completed", { outcome: "success", result_count: 3 }, {
		event_name: "diagnostic.test.completed",
		file: "tests/logging/fixtures/emitter.mts",
		function: "emitFixture",
		site_id: "diagnostic.test.completed",
	});
	log.warn("Diagnostic fixture degraded", {
		severity_text: "DEBUG", timestamp: "forged", outcome: "partial",
	}, {
		event_name: "diagnostic.test.degraded",
		file: "tests/logging/fixtures/emitter.mts",
		function: "emitFixture",
		site_id: "diagnostic.test.degraded",
	});
}

function contextRecord(phase: string): void {
	log.info("Context fixture checkpoint", { phase, inherited_operation: currentLogContext().operation_id }, {
		event_name: "diagnostic.test.context", file: "tests/logging/fixtures/emitter.mts",
		function: "contextRecord", site_id: "diagnostic.test.context",
	});
}

await emitFixture();
await closeLogger();
