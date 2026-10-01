/** The prompt recall limit in settings.json reaches the OpenClaw hook audit. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb } from "../helpers/test-db.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";
import { untilModelReady } from "../../../packages/memory/integration/fixtures/model-ready.ts";

interface AuditLine {
	event: string;
	hook?: string;
	resultStatus?: string;
	decision?: string;
	details?: Record<string, unknown>;
	timestamp: string;
}

function readAudit(_stateDir: string): AuditLine[] {
	const auditPath = join(_stateDir, "sno-station-mem", "audit.jsonl");
	if (!existsSync(auditPath)) return [];
	const raw = readFileSync(auditPath, "utf-8").trim();
	if (!raw) return [];
	return raw
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditLine);
}

async function waitForAudit(
	stateDir: string,
	predicate: (entries: AuditLine[]) => boolean,
	timeoutMs = 5000,
): Promise<AuditLine[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entries = readAudit(stateDir);
		if (predicate(entries)) return entries;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return readAudit(stateDir);
}

interface Fixture {
	harness: OpenClawPluginApiHarness;
	stateDir: string;
	cleanup: () => void;
}

async function buildFixture(
	limit?: number,
): Promise<Fixture> {
	const stateDir = mkdtempSync(join(tmpdir(), "mem-claw-recall-topk-"));
	const prevStateDir = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = stateDir;

	const testDb = createTestDb();
	process.env.SNO_PROFILE_DIR = stateDir;
	writeSettingsFixture(stateDir, { mode: "local-first", store: { path: testDb.dbPath, encryptionKey: testDb.encryptionKey }, embedding: { cacheDir: "" }, recall: { auto: true, prompt: { ...(limit === undefined ? {} : { limit }) } }, capture: { ambient: false, sessionStrategy: "none" } });
	const harness = new OpenClawPluginApiHarness({
		embedding: { dimensions: 1024 },
		dbPath: testDb.dbPath,
		ambientLearning: false,
		autoRecall: true,
		sessionStrategy: "none",
	});
	await memClawPlugin.register?.(harness);
	await harness.startServices();
	const { port } = JSON.parse(readFileSync(join(stateDir, "station", "sidecar.json"), "utf8")) as { port: number };
	await untilModelReady(async ({ scope, ...recall }) => {
		const response = await fetch(`http://127.0.0.1:${port}/v1/get-recall`, {
			method: "POST", headers: { "x-sno-station-mem-skin": "model-ready-probe" },
			body: JSON.stringify({ ...recall, scope: { ...scope, principal: userInfo().username } }),
		});
		return response.json();
	});

	function cleanup(): void {
		testDb.cleanup();
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		if (prevStateDir === undefined) {
			delete process.env.SNO_PROFILE_DIR;
		} else {
			process.env.SNO_PROFILE_DIR = prevStateDir;
		}
	}

	return { harness, stateDir, cleanup };
}

async function invokeBeforeAgentStart(
	harness: OpenClawPluginApiHarness,
	prompt: string,
): Promise<void> {
	const handler = harness.getOnHookHandler("before_prompt_build");
	if (!handler) throw new Error("before_prompt_build handler missing");
	await (
		handler as unknown as (
			event: { prompt: string },
			ctx: { agentId?: string; sessionKey?: string },
		) => Promise<unknown>
	)(
		{ prompt },
		{ agentId: "agent-x", sessionKey: `agent:agent-x:${randomUUID()}` },
	);
}

describe("PRD §2.6 — recallTopK config flow into auto_recall hook", () => {
	let fixture: Fixture | undefined;

	beforeEach(() => {
		fixture = undefined;
	});

	afterEach(async () => {
		await fixture?.harness.stopServices?.();
		fixture?.cleanup();
	});

	it("default settings emit limit 3", async () => {
		fixture = await buildFixture();

		await invokeBeforeAgentStart(
			fixture.harness,
			"What did agent X say about the project?",
		);

		const entries = await waitForAudit(fixture.stateDir, (es) =>
			es.some(
				(e) =>
					e.event === "auto_recall" &&
					typeof e.details?.["limit"] === "number",
			),
		);

		const auto = entries.filter((e) => e.event === "auto_recall");
		expect(auto.length).toBeGreaterThanOrEqual(1);
		const first = auto[0];
		if (!first) throw new Error("expected at least one auto_recall entry");
		expect(first.details?.["limit"]).toBe(3);
	});

	it("explicit recall.prompt.limit=7 overrides the default and flows into the hook", async () => {
		fixture = await buildFixture(7);

		await invokeBeforeAgentStart(
			fixture.harness,
			"What did agent X say about the project?",
		);

		const entries = await waitForAudit(fixture.stateDir, (es) =>
			es.some(
				(e) =>
					e.event === "auto_recall" &&
					typeof e.details?.["limit"] === "number",
			),
		);

		const auto = entries.filter((e) => e.event === "auto_recall");
		expect(auto.length).toBeGreaterThanOrEqual(1);
		const first = auto[0];
		if (!first) throw new Error("expected at least one auto_recall entry");
		expect(first.details?.["limit"]).toBe(7);
	});

	it("explicit recall.prompt.limit=15 flows into the hook", async () => {
		fixture = await buildFixture(15);

		await invokeBeforeAgentStart(
			fixture.harness,
			"What did agent X say about the project?",
		);

		const entries = await waitForAudit(fixture.stateDir, (es) =>
			es.some(
				(e) =>
					e.event === "auto_recall" &&
					typeof e.details?.["limit"] === "number",
			),
		);

		const auto = entries.filter((e) => e.event === "auto_recall");
		expect(auto.length).toBeGreaterThanOrEqual(1);
		const first = auto[0];
		if (!first) throw new Error("expected at least one auto_recall entry");
		expect(first.details?.["limit"]).toBe(15);
	});
});
