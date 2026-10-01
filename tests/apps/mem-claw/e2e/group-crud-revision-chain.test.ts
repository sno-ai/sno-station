import { readTestSnoGpuSettings } from "../helpers/settings.ts";

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AtomicGenericExtractionTransport } from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import {
	AtomicInsightDistiller,
	type AtomicMemoryExtractionTransports,
	createSignedAtomicMemoryExtractionTransports,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	createGroupCrudEntityIdentityJudgementPort,
	createGroupCrudStateKeyingJudgementPort,
	runGroupCrudMaintenancePass,
} from "../../../../packages/memory/src/engine/maintenance/group-crud-maintenance";
import { readModelReplyJson } from "../../../../packages/memory/src/engine/shared/model-reply-text";
import { llmRoutingConfigSchema } from "../../../../packages/memory/config/plugin-config-mode-schema";
import {
	compareMemorySourceOrder,
	readMemorySourceOrder,
} from "../../../../packages/memory/src/store/memory-source-order";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const IDENTITY_SKILL_PATH = join(
	REPO_ROOT,
	"apps/mem-claw/skills/resolve-entity-identity/SKILL.md",
);
const MAINTENANCE_RECEIPT = "group-crud-maintenance-v1";

const SCOPE = "group-crud-revision-chain";
const _AGENT_ID = "group-crud-revision-chain";
/** `project.budget` is cardinality `one` in `config/state-vocabulary.json`. */
const ATTRIBUTE = "project.budget";
/** The project's title as the user first states it, and the spelling the last session uses. */
const PROJECT_TITLE = "Acme Corp Rebrand";
const PROJECT_ALIAS = "ACME Rebrand";
/** Every entity row the model registers for the project, under either spelling. */
const PROJECT_ENTITY_NAME = /acme/i;
/** The values in arrival order; the anchors survive "$48,500", "48500 USD" and "48.5k" alike. */
const SAME_DAY_FINAL_VALUE = /48[,.]?500|48\.5\s?k/i;
const FINAL_VALUE = /50[,.]?000|50\s?k/i;
const PASS_MS = Date.UTC(2026, 8, 1, 8, 0);

interface Session {
	key: string;
	/** The session clock the ambient-learning hook derives; no sentence carries its own date. */
	dateTime: string;
	conversation: string;
}

const KICKOFF: Session = {
	key: "revision-chain-day-1",
	dateTime: "2026-09-01T09:00:00.000Z",
	conversation: [
		`user: I just signed a new client project. The project title is "${PROJECT_TITLE}" — a full brand refresh for a regional logistics company.`,
		"assistant: Congratulations. Do you have a schedule for it yet?",
		`user: The timeline for the "${PROJECT_TITLE}" project is twelve weeks.`,
		"assistant: Noted.",
	].join("\n"),
};

const SAME_DAY_REVISIONS: Session = {
	key: "revision-chain-day-2",
	dateTime: "2026-09-02T10:00:00.000Z",
	conversation: [
		`user: Budget news: the client confirmed the budget for the "${PROJECT_TITLE}" project is $45,000.`,
		"assistant: Noted.",
		`user: Hold on, they just emailed again. The budget for the "${PROJECT_TITLE}" project is $52,000 — they added the packaging work.`,
		"assistant: Updated. Anything else changing?",
		// No time phrase anywhere in this session: "this afternoon" on the first run resolved to the
		// day's midnight, an order key EARLIER than the session clock the undated rows carry, and the
		// correction was written closed on arrival behind the $52,000 row.
		`user: One more correction from their finance team: the budget for the "${PROJECT_TITLE}" project is $48,500. That is the number to keep.`,
		"assistant: Got it.",
	].join("\n"),
};

const LATER_DAY_RESTATEMENT: Session = {
	key: "revision-chain-day-3",
	dateTime: "2026-09-03T14:00:00.000Z",
	conversation: [
		`user: Quick update on the "${PROJECT_ALIAS}" project — the budget for the "${PROJECT_ALIAS}" project is now finalized at $50,000.`,
		"assistant: Recorded.",
	].join("\n"),
};

// ---------------------------------------------------------------------------------------------
// The live model, through the product's own transports.
// ---------------------------------------------------------------------------------------------

function requireLiveEndpoint(): { gpuBaseUrl: string; llmApiKey: string } {
	const { baseUrl, apiKey } = readTestSnoGpuSettings();
	const gpuBaseUrl = baseUrl.trim();
	const llmApiKey = apiKey.trim();
	if (!gpuBaseUrl || !llmApiKey) {
		throw new Error(
			"live Sno GPU endpoint is required: snoGpu.baseUrl and snoGpu.apiKey must be set in settings.json; this test never skips",
		);
	}
	return { gpuBaseUrl, llmApiKey };
}

/** The same factory the plugin's distiller uses, with the same preset and routing. */
function liveTransports(apiKey: string): AtomicMemoryExtractionTransports {
	return createSignedAtomicMemoryExtractionTransports(
		{
			preset: "mem_claw/sno_extract_chat",
			apiKey,
			routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }),
			timeoutMs: 180_000,
		},
		"en",
	);
}

/** The maintenance pass's entity-identity port, answered by the real model over the shipped skill. */
function liveIdentityPort(generic: AtomicGenericExtractionTransport) {
	const skill = readFileSync(IDENTITY_SKILL_PATH, "utf8");
	return createGroupCrudEntityIdentityJudgementPort({
		async respond({ displayName, existingDisplayNames }) {
			const completion = await generic.complete({
				callId: "E8",
				prompt: [
					skill,
					JSON.stringify({
						new_display_name: displayName,
						existing_entities: existingDisplayNames.map((candidate) => ({
							entity_id: candidate.entityId,
							display_name: candidate.displayName,
						})),
					}),
				].join("\n\n"),
				maxTokens: 64,
			});
			const answer = readModelReplyJson(completion?.text ?? "", (value) =>
				typeof value === "object" &&
				value !== null &&
				"entity_id" in value &&
				typeof value.entity_id === "string"
					? value.entity_id
					: undefined,
			);
			const offered = existingDisplayNames.find((candidate) => candidate.entityId === answer);
			return offered ? { decision: "existing", entityId: offered.entityId } : { decision: "new" };
		},
	});
}

/** The maintenance pass's state-keying port, answered by the real model over the offered slugs. */
function liveStateKeyingPort(generic: AtomicGenericExtractionTransport) {
	return createGroupCrudStateKeyingJudgementPort({
		async respond({ text, offeredSlugs }) {
			const completion = await generic.complete({
				callId: "E12",
				prompt: [
					"Key this standing fact about a named thing (a document, a proposal, an e-mail, a meeting) to exactly one attribute slug from the offered list.",
					'Return exactly one JSON object and no prose: {"slug":"<one offered slug>"} or {"slug":null} when no offered slug fits.',
					`Offered slugs: ${JSON.stringify(offeredSlugs)}`,
					`Fact: ${JSON.stringify(text)}`,
				].join("\n\n"),
				maxTokens: 64,
			});
			const slug = readModelReplyJson(completion?.text ?? "", (value) =>
				typeof value === "object" && value !== null && "slug" in value
					? typeof value.slug === "string"
						? value.slug
						: null
					: undefined,
			);
			return slug ?? null;
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Reading the store back.
// ---------------------------------------------------------------------------------------------

interface StoredRow {
	id: string;
	text: string;
	category: string;
	subject: string | null;
	attribute: string | null;
	lane: string;
	metadata: string;
	validFrom: number | null;
}

interface EntityRow {
	entityId: string;
	displayName: string;
	normalizedName: string;
}

function allRows(fixture: TestDb): StoredRow[] {
	return fixture.sqlite
		.prepare(
			`SELECT id, text, category, subject, attribute, lane, metadata, valid_from AS validFrom
			 FROM nodix_memories WHERE project_id = ? ORDER BY rowid`,
		)
		.all(SCOPE) as StoredRow[];
}

function budgetRows(fixture: TestDb): StoredRow[] {
	return allRows(fixture).filter((row) => row.attribute === ATTRIBUTE);
}

function supersededBy(row: StoredRow): string | null {
	const value = (JSON.parse(row.metadata) as Record<string, unknown>)["superseded_by"];
	return typeof value === "string" ? value : null;
}

function isOpen(row: StoredRow): boolean {
	return supersededBy(row) === null;
}

function projectEntities(fixture: TestDb): EntityRow[] {
	return (
		fixture.sqlite
			.prepare(
				`SELECT entity_id AS entityId, display_name AS displayName,
					normalized_name AS normalizedName
				 FROM nodix_memory_entities WHERE project_id = ? ORDER BY normalized_name`,
			)
			.all(SCOPE) as EntityRow[]
	).filter((row) => PROJECT_ENTITY_NAME.test(row.normalizedName));
}

function describeRows(rows: readonly StoredRow[]): string {
	return rows
		.map((row) => {
			const order = (JSON.parse(row.metadata) as Record<string, unknown>)["source_order"];
			return `${row.id} ${row.category}/${row.subject ?? "-"}/${row.attribute ?? "-"} lane=${row.lane} order=${JSON.stringify(order ?? null)} superseded_by=${supersededBy(row) ?? "null"} :: ${row.text}`;
		})
		.join("\n");
}

function describeEntities(rows: readonly EntityRow[]): string {
	return rows.map((row) => `${row.entityId} :: ${row.displayName}`).join("\n");
}

function describeJournal(fixture: TestDb): string {
	const rows = fixture.sqlite
		.prepare(
			`SELECT job_id AS jobId, stage, outcome, row_id AS rowId, reason, detail
			 FROM nodix_rem_journal WHERE job_type = 'atomic-extraction' ORDER BY sequence`,
		)
		.all() as Array<{
		jobId: string;
		stage: string;
		outcome: string;
		rowId: string | null;
		reason: string | null;
		detail: string | null;
	}>;
	return rows
		.map(
			(row) =>
				`${row.jobId} ${row.stage} ${row.outcome} row=${row.rowId ?? "-"} ${row.reason ?? ""} ${row.detail ?? ""}`,
		)
		.join("\n");
}

function storeState(fixture: TestDb): string {
	return `store:\n${describeRows(allRows(fixture))}\nentities:\n${describeEntities(projectEntities(fixture))}\njournal:\n${describeJournal(fixture)}`;
}

/**
 * The group invariant every write step ends on: exactly one open row, and every closed row
 * names a later row of the same group. Returns the open row.
 */
function expectOneOpenRowClosingForward(fixture: TestDb, step: string): StoredRow {
	const rows = budgetRows(fixture);
	const state = storeState(fixture);
	const open = rows.filter(isOpen);
	expect(
		open.map((row) => row.text),
		`${step}: the ${ATTRIBUTE} group must hold exactly one open row\n${state}`,
	).toHaveLength(1);
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const row of rows) {
		if (isOpen(row)) continue;
		const closer = supersededBy(row);
		expect(
			closer,
			`${step}: closed row ${row.id} was closed by itself, not by a later revision\n${state}`,
		).not.toBe(row.id);
		const closingRow = closer === null ? undefined : byId.get(closer);
		expect(
			closingRow,
			`${step}: closed row ${row.id} points at ${closer}, which is not a row of the group\n${state}`,
		).toBeDefined();
		if (!closingRow) continue;
		expect(
			compareMemorySourceOrder(
				readMemorySourceOrder(closingRow.metadata),
				readMemorySourceOrder(row.metadata),
			),
			`${step}: closed row ${row.id} is closed by ${closer}, which does not come after it\n${state}`,
		).toBeGreaterThan(0);
	}
	const openRow = open[0];
	if (openRow === undefined) throw new Error(`${step}: no open row`);
	return openRow;
}

// ---------------------------------------------------------------------------------------------
// The journey's shared state. Steps run in file order; a step that did not pass fails the next.
// ---------------------------------------------------------------------------------------------

interface Journey {
	fixture: TestDb;
	store: MemoryStore;
	distiller: AtomicInsightDistiller;
	preflightReply: string;
	maintenanceReceiptAt: number;
}

let embedder: Embedder;
let journey: Journey | undefined;
let harness: OpenClawPluginApiHarness | undefined;
let stateDir: string | undefined;
/** The one entity id the project is registered under on day 1; every later row must sit on it. */
let projectEntityId: string | undefined;
let sameDayChainClosed = false;
let storeClosed = false;
const priorStateDir = process.env["OPENCLAW_STATE_DIR"];

function requireJourney(): Journey {
	if (journey === undefined) throw new Error("the journey's preconditions did not pass");
	return journey;
}

async function ingest(session: Session): Promise<void> {
	const { distiller } = requireJourney();
	const stats = await distiller.extractAndPersist(session.conversation, session.key, {
		scope: SCOPE,
		sessionDateTime: session.dateTime,
		sessionTimezone: "UTC",
	});
	expect(
		stats.llmFailures ?? 0,
		`${session.key}: an extraction window failed against the live model: ${JSON.stringify(stats)}`,
	).toBe(0);
	expect(stats.created, `${session.key}: the extractor wrote no row: ${JSON.stringify(stats)}`)
		.toBeGreaterThan(0);
}

beforeAll(async () => {
	embedder = await createTestEmbedder();
	const endpoint = requireLiveEndpoint();

	// Precondition 1 — the GPU answers one real call through the product transport.
	const transports = liveTransports(endpoint.llmApiKey);
	const preflight = await transports.generic.complete({
		callId: "E1",
		prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}',
		maxTokens: 64,
	});
	if (preflight === null || preflight.truncated || !/"ok"\s*:\s*true/.test(preflight.text)) {
		throw new Error(
			`the live Sno GPU did not answer the preflight call through mem_claw/sno_extract_chat: ${JSON.stringify(preflight)}`,
		);
	}

	const fixture = createTestDb();
	try {
		// Precondition 2 — the maintenance pass runs on the fresh store and leaves its receipt.
		// It applies the `state` category migration and is what switches recall onto the group
		// path; a store without it would take the plain path silently.
		await runGroupCrudMaintenancePass({
			database: fixture.runtime.db,
			identityJudgement: liveIdentityPort(transports.generic),
			stateKeying: liveStateKeyingPort(transports.generic),
			profileKeying: transports.profileKeying,
			nowMs: PASS_MS,
		});
		const receipt = fixture.sqlite
			.prepare(
				"SELECT migrated_at AS migratedAt FROM nodix_todo_migration_receipts WHERE migration_id = ?",
			)
			.get(MAINTENANCE_RECEIPT) as { migratedAt: number } | undefined;
		if (receipt === undefined) {
			throw new Error(
				`the maintenance pass left no receipt (${MAINTENANCE_RECEIPT}); recall would take the plain path`,
			);
		}

		// Precondition 3 — the store opens through the product's own connection path, and the
		// distiller is the ambient-learning hook's, built from the same transports.
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		journey = {
			fixture,
			store,
			distiller: new AtomicInsightDistiller(store, transports, {
				defaultScope: SCOPE,
				locale: "en",
			}),
			preflightReply: preflight.text,
			maintenanceReceiptAt: receipt.migratedAt,
		};
	} catch (error) {
		fixture.cleanup();
		throw error;
	}
}, 600_000);

afterAll(async () => {
	if (harness) await harness.stopServices();
	if (journey && !storeClosed) await journey.store.close();
	journey?.fixture.cleanup();
	if (stateDir) rmSync(stateDir, { recursive: true, force: true });
	if (priorStateDir === undefined) delete process.env["OPENCLAW_STATE_DIR"];
	else process.env["OPENCLAW_STATE_DIR"] = priorStateDir;
});

describe("PRD 150 — a single-valued attribute revised through the real extractor closes forward, then recall serves the current value", () => {
	it("preconditions: live GPU, maintenance receipt, open store", () => {
		const { fixture, preflightReply, maintenanceReceiptAt } = requireJourney();
		expect(preflightReply).toMatch(/"ok"\s*:\s*true/);
		expect(maintenanceReceiptAt).toBe(PASS_MS);
		expect(allRows(fixture), "the fresh store is not empty").toHaveLength(0);
	});

	it(
		"day 1: the session that names the project registers one entity and no budget row",
		{ timeout: 900_000 },
		async () => {
			const { fixture } = requireJourney();
			await ingest(KICKOFF);
			const state = storeState(fixture);
			const entities = projectEntities(fixture);
			const entityIds = [...new Set(entities.map((row) => row.entityId))];
			expect(
				entityIds,
				`the project was not registered as exactly one entity on day 1\n${state}`,
			).toHaveLength(1);
			projectEntityId = entityIds[0];
			expect(
				budgetRows(fixture).map((row) => row.text),
				`day 1 stated no budget, yet a ${ATTRIBUTE} row was written\n${state}`,
			).toHaveLength(0);
			// The project's own rows sit on that id; the entity is not just a registry line.
			expect(
				allRows(fixture).filter((row) => row.subject === projectEntityId).length,
				`no row of day 1 was written under the project's entity\n${state}`,
			).toBeGreaterThan(0);
		},
	);

	it(
		"day 2: stated and revised twice on one day — one open row, every earlier row closed forward",
		{ timeout: 900_000 },
		async () => {
			const { fixture } = requireJourney();
			if (projectEntityId === undefined) throw new Error("day 1 did not pass");
			await ingest(SAME_DAY_REVISIONS);
			const state = storeState(fixture);
			const rows = budgetRows(fixture);
			// Three statements were made; a split that adds a row keeps the invariants, a drop breaks
			// them — three values cannot share fewer than three rows.
			expect(
				rows.map((row) => row.text),
				`the three same-day budget statements did not all reach the store\n${state}`,
			).not.toHaveLength(0);
			expect(rows.length, `fewer rows than budget statements\n${state}`).toBeGreaterThanOrEqual(
				3,
			);
			for (const row of rows) {
				expect(row.category, `${row.id} is not a state row\n${state}`).toBe("state");
				expect(row.lane, `${row.id} was parked, not written live\n${state}`).toBe("active");
				expect(
					row.subject,
					`${row.id} is not on the project's entity from day 1\n${state}`,
				).toBe(projectEntityId);
			}
			const openRow = expectOneOpenRowClosingForward(fixture, "day 2");
			expect(
				openRow.text,
				`the open row after the same-day chain is not the last revision\n${state}`,
			).toMatch(SAME_DAY_FINAL_VALUE);
			sameDayChainClosed = true;
		},
	);

	it(
		"day 3: restated under a second spelling, no date — one open row with the final value, one entity",
		{ timeout: 900_000 },
		async () => {
			const { fixture } = requireJourney();
			if (!sameDayChainClosed) throw new Error("day 2 did not pass; the chain is not proven");
			const before = budgetRows(fixture);
			await ingest(LATER_DAY_RESTATEMENT);
			const state = storeState(fixture);
			const rows = budgetRows(fixture);
			expect(
				rows.length,
				`the later-day restatement wrote no ${ATTRIBUTE} row\n${state}`,
			).toBeGreaterThan(before.length);

			const openRow = expectOneOpenRowClosingForward(fixture, "day 3");
			expect(openRow.text, `the open row is not the final value\n${state}`).toMatch(
				FINAL_VALUE,
			);
			// Without a date in the sentence the row's validity starts at its session clock, which
			// is a later day than every row it closed.
			expect(openRow.validFrom, `the final row carries no valid_from\n${state}`).not.toBeNull();
			for (const row of rows) {
				if (row.id === openRow.id) continue;
				expect(
					(openRow.validFrom ?? 0) > (row.validFrom ?? 0),
					`the final row is not dated after ${row.id}\n${state}`,
				).toBe(true);
			}

			// Two spellings, one entity: every row of the group sits on the day-1 id, and the
			// registry holds no second id for the project (an alias row for "ACME" is one more
			// name on the same id, never a second id).
			for (const row of rows) {
				expect(
					row.subject,
					`${row.id} was written under a second entity for the same project\n${state}`,
				).toBe(projectEntityId);
			}
			const entityIds = [...new Set(projectEntities(fixture).map((row) => row.entityId))];
			expect(
				entityIds,
				`the project is registered under more than one entity id\n${state}`,
			).toEqual([projectEntityId]);
		},
	);

});
