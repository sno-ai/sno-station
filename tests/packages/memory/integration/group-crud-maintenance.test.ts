/** @file PRD 150 QCG-11 — the re-runnable maintenance pass, on a real encrypted store. No mocks.
 *
 * @boundary `runGroupCrudMaintenancePass` over a store the REAL write path filled
 * (`MemoryStore.storeAtomicExtractionChunk`), then aged into the shape a store written before this
 * change actually has. Only the three judgements are supplied by the test — the entity identity
 * port, the state keying port and the person-profile adapter transport — because all three are
 * model calls; every mechanical step is the product's own.
 *
 * The seeded population is read off a real persona store
 * (`evals/memora/run-data/stores/mem-claw-memora-eval.20260904T233718Z-263073/personas/
 * academic_researcher_weekly`), measured 2026-09-05: 187 rows, 136 `profile`, 33 of them carrying
 * an `entity:` subject — 29 with a null attribute and `section_name: "unkeyed.profile"`, four keyed
 * to a person slug such as `identity.project_role` — 70 unkeyed `profile` rows, 183 rows carrying a
 * `keying_note`, and not one row anywhere carrying `topic`, `attribute` or a `raw_candidate_json`
 * on an active row. Those are the shapes seeded here, not toy strings.
 *
 * "Aged" means exactly one thing: `metadata.source_order` is deleted from every row, which is what
 * a store written before REQ-2 looks like. Nothing else is hand-shaped — every row below went in
 * through the product's own card path.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AtomicExtractionRecord } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import type {
	AtomicKeyedRecord,
	AtomicProfileKeyingTransport,
} from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	createGroupCrudEntityIdentityJudgementPort,
	createGroupCrudStateKeyingJudgementPort,
	type GroupCrudEntityIdentityJudgementPort,
	type GroupCrudMaintenanceReport,
	type GroupCrudStateKeyingJudgementPort,
	runGroupCrudMaintenancePass,
} from "../../../../packages/memory/src/engine/maintenance/group-crud-maintenance";
import { readMemorySourceOrder } from "../../../../packages/memory/src/store/memory-source-order";
import { ENTITY_IDENTITY_CANDIDATE_LIMIT } from "../../../../packages/memory/src/store/memory-store-atomic-entity-api";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "academic_researcher_weekly";
const EXTRACTOR_VERSION = "group-crud-maintenance-test";
/** The two weekly sessions the rows come from, and the clock the pass itself is given. */
const WEEK_ONE_MS = Date.UTC(2026, 5, 1, 9, 0);
const WEEK_TWO_MS = Date.UTC(2026, 5, 8, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 4, 23, 37);
const PASS_MS = Date.UTC(2026, 8, 5, 6, 15);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};
/** The shipped state vocabulary, read from the file the pass itself keys from. */
const STATE_SLUGS: string[] = (
	JSON.parse(
		readFileSync(
			join(
				resolve(import.meta.dirname, "../../../.."),
				"packages/memory/config/state-vocabulary.json",
			),
			"utf8",
		),
	) as { slugs: Array<{ slug: string }> }
).slugs.map(({ slug }) => slug);

interface EntityRegistration {
	entityId: string;
	displayName: string;
	normalizedName: string;
}

/**
 * The split entity, in the shape the store splits them: the full proposal title registered in the
 * first week, and the shorthand the same person used a week later, which normalizes to a different
 * name and so became a second entity with its own rows.
 */
const CANONICAL: EntityRegistration = {
	entityId:
		"entity:deep-learning-for-regional-energy-demand-forecasting-under-climate-volatility-967e8c480d3a",
	displayName: "Deep Learning for Regional Energy Demand Forecasting under Climate Volatility",
	normalizedName: "deep learning for regional energy demand forecasting under climate volatility",
};
const VARIANT: EntityRegistration = {
	entityId: "entity:the-regional-energy-demand-forecasting-proposal-4b17d0c9ae52",
	displayName: "the regional energy demand forecasting proposal",
	normalizedName: "the regional energy demand forecasting proposal",
};
const PERSON: EntityRegistration = {
	entityId: "entity:dr-anya-sharma-e4240e1c192b",
	displayName: "Dr. Anya Sharma",
	normalizedName: "dr. anya sharma",
};

interface Seed {
	label: string;
	category: "profile" | "state";
	subject: string;
	subjectKind: "user" | "named_entity";
	attribute: string | null;
	/** The row's stored sentence. */
	text: string;
	/** `metadata.value` — the fact's own value, which the keying retry sends to the adapter. */
	value: string;
	/** `metadata.source_span.quote` — the turn the claim was cut from. */
	quote: string;
	turnIndex: number;
	keyingNote?: "keying-unmatched" | "keying-failed";
	/** The person slug the adapter answers on a retry; absent means the adapter cannot key it. */
	adapterSlug?: string;
}

/** Week one: the proposal under its full title, the project lead, and the person's own rows. */
const WEEK_ONE_SEEDS: readonly Seed[] = [
	{
		label: "state-budget",
		category: "state",
		subject: CANONICAL.entityId,
		subjectKind: "named_entity",
		attribute: "project.budget",
		text: "The Deep Learning for Regional Energy Demand Forecasting proposal budget is $1,200,000.",
		value: "$1,200,000",
		quote: "The proposed budget for the grant is $1,200,000.",
		turnIndex: 1,
	},
	{
		label: "legacy-aim",
		category: "profile",
		subject: CANONICAL.entityId,
		subjectKind: "named_entity",
		attribute: null,
		text: "The project proposal aims to develop and validate deep learning models for long-term regional energy demand forecasting.",
		value:
			"develop and validate deep learning models for long-term regional energy demand forecasting",
		quote:
			"This project aims to develop and validate deep learning models for long-term regional energy demand forecasting.",
		turnIndex: 1,
		keyingNote: "keying-unmatched",
	},
	{
		label: "legacy-role",
		category: "profile",
		subject: PERSON.entityId,
		subjectKind: "named_entity",
		attribute: "identity.project_role",
		text: "Dr. Anya Sharma is the project lead.",
		value: "project lead",
		quote: "The project lead is Dr. Anya Sharma.",
		turnIndex: 1,
		keyingNote: "keying-unmatched",
	},
	{
		label: "profile-music",
		category: "profile",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		text: "The user's favourite jazz pianist is Thelonious Monk.",
		value: "Thelonious Monk",
		quote: "My favourite jazz pianist is Thelonious Monk.",
		turnIndex: 3,
		keyingNote: "keying-unmatched",
		adapterSlug: "preference.music",
	},
	{
		label: "profile-tools",
		category: "profile",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		text: "The user drafts every manuscript in Emacs.",
		value: "Emacs",
		quote: "I draft every manuscript in Emacs.",
		turnIndex: 5,
		keyingNote: "keying-unmatched",
		adapterSlug: "preference.tools",
	},
	{
		label: "profile-abstract",
		category: "profile",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		text: "The user needs to prepare a conference abstract by 2026-06-08.",
		value: "prepare a conference abstract",
		quote: "I need to prepare a conference abstract by next week.",
		turnIndex: 7,
		keyingNote: "keying-unmatched",
	},
	{
		label: "profile-swim",
		category: "profile",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		// The row whose keying CALL failed rather than came back unmatched: the adapter can key it,
		// and the pass has to ask again.
		text: "The user swims for an hour before the morning lab meeting.",
		value: "swim for an hour",
		quote: "I swim for an hour before the morning lab meeting.",
		turnIndex: 9,
		keyingNote: "keying-failed",
		adapterSlug: "routine.daily",
	},
];

/** Week two: the same proposal under the shorthand name, which became a second entity. */
const WEEK_TWO_SEEDS: readonly Seed[] = [
	{
		label: "state-timeline",
		category: "state",
		subject: VARIANT.entityId,
		subjectKind: "named_entity",
		attribute: "project.timeline",
		text: "The regional energy demand forecasting proposal timeline is 30 months.",
		value: "30 months",
		quote: "The project timeline is 30 months, in three phases.",
		turnIndex: 1,
	},
	{
		label: "state-stakeholder",
		category: "state",
		subject: VARIANT.entityId,
		subjectKind: "named_entity",
		attribute: "project.stakeholder",
		text: "The regional energy demand forecasting proposal is funded by the Regional Grid Authority.",
		value: "Regional Grid Authority",
		quote: "The Regional Grid Authority is funding the proposal.",
		turnIndex: 3,
	},
];

const ALL_SEEDS: readonly Seed[] = [...WEEK_ONE_SEEDS, ...WEEK_TWO_SEEDS];

interface StoredRow {
	id: string;
	text: string;
	category: string;
	subject: string | null;
	attribute: string | null;
	lane: string;
	metadata: string;
}

function seedRecord(seed: Seed): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: seed.category,
		claimText: seed.text,
		subject: seed.subject,
		subjectKind: seed.subjectKind,
		attribute: seed.attribute,
		value: seed.value,
		temporalPhrase: null,
		resolvedTime: null,
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: seed.turnIndex,
			quote: seed.quote,
			startOffset: 0,
			endOffset: seed.quote.length,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...(seed.keyingNote ? { keyingNote: seed.keyingNote } : {}),
	};
}

/**
 * The adapter, as a port. It answers for the rows a real adapter can key and returns nothing for
 * the row it cannot, so what this file measures is what the ENGINE does with the answer.
 */
class MaintenanceKeyingTransport implements AtomicProfileKeyingTransport {
	readonly askedFor: string[] = [];

	async keyTurn(
		input: Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0],
	): Promise<AtomicExtractionRecord[] | null> {
		const content = input.turn.content;
		this.askedFor.push(content);
		const seed = ALL_SEEDS.find(
			(candidate) => candidate.adapterSlug !== undefined && content.includes(candidate.value),
		);
		if (seed?.adapterSlug === undefined) return [];
		return [
			{
				kind: "standing",
				claimText: seed.text,
				subject: "user",
				subjectKind: "user",
				attribute: seed.adapterSlug,
				value: seed.value,
				temporalPhrase: null,
				resolvedTime: null,
				endsCurrent: false,
				endedAt: null,
				importance: "medium",
				changesCurrentState: false,
				todo: "none",
				closeReason: null,
				sourceSpan: { turnIndex: input.turnIndex, quote: seed.value },
				relations: [],
				singleClaim: true,
			},
		];
	}
}

interface IdentityAsk {
	displayName: string;
	offered: string[];
}

/**
 * The identity judgement, as a port: the shorthand IS the proposal, every other name is itself.
 * Answering `existing` in the other direction would merge the established entity into the
 * shorthand, which is the ping-pong the pass must never be asked to perform.
 */
function identityPort(asks: IdentityAsk[]): GroupCrudEntityIdentityJudgementPort {
	return createGroupCrudEntityIdentityJudgementPort({
		async respond({ displayName, existingDisplayNames }) {
			asks.push({
				displayName,
				offered: existingDisplayNames.map((candidate) => candidate.entityId),
			});
			if (displayName !== VARIANT.displayName) return { decision: "new" };
			const target = existingDisplayNames.find(
				(candidate) => candidate.displayName === CANONICAL.displayName,
			);
			if (!target) throw new Error("the canonical proposal was not offered as a candidate");
			return { decision: "existing", entityId: target.entityId };
		},
	});
}

interface StateKeyingAsk {
	text: string;
	offered: string[];
}

function seedByLabel(label: string): Seed {
	const seed = ALL_SEEDS.find((candidate) => candidate.label === label);
	if (seed === undefined) throw new Error(`no seed labelled ${label}`);
	return seed;
}

/**
 * The one state slug each recategorized entity row belongs under, read off the shipped
 * vocabulary (`packages/memory/config/state-vocabulary.json`), keyed by the row's stored text:
 * the aim of the proposal is a `Project.description-scoped goal` (`project.objective`), and the
 * project lead is a `Project.funder / participant` (`project.stakeholder`). Any other text has no
 * row here, so the double answers null for it — a product that keys the wrong row, or keys a row
 * it never asked about, cannot pass by being handed the first slug on offer.
 */
const STATE_KEYING_ANSWERS: ReadonlyMap<string, string> = new Map([
	[seedByLabel("legacy-aim").text, "project.objective"],
	[seedByLabel("legacy-role").text, "project.stakeholder"],
]);

/**
 * The state keying judgement, as a port: it records every ask and answers only from the table
 * above. It returns the slug even when the engine did not offer it, so an engine that offers a
 * short list — or refuses an unoffered slug — is measured on what it then writes.
 */
function stateKeyingPort(asks: StateKeyingAsk[]): GroupCrudStateKeyingJudgementPort {
	return createGroupCrudStateKeyingJudgementPort({
		async respond({ text, offeredSlugs }) {
			asks.push({ text, offered: [...offeredSlugs] });
			return STATE_KEYING_ANSWERS.get(text) ?? null;
		},
	});
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function writeSession(
	store: MemoryStore,
	seeds: readonly Seed[],
	entities: readonly EntityRegistration[],
	conversationId: string,
	sessionTimestampMs: number,
	nowMs: number,
): Promise<Map<string, string>> {
	const key: AtomicExtractionLedgerKey = {
		conversationId,
		chunkHash: `chunk-${conversationId}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: seeds.map((seed) => `user: ${seed.quote}`).join("\n"),
			routingSnapshotId: "routing-group-crud-maintenance",
			runParameters: RUN_PARAMETERS,
			nowMs,
		}),
	).toMatchObject({ action: "run" });
	store.recordAtomicExtractionCalls(key, nowMs + 1);
	const result = await store.storeAtomicExtractionChunk({
		ledgerKey: key,
		projectId: PROJECT_ID,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: nowMs + 2,
		cards: buildAtomicWriteCards({
			records: seeds.map(seedRecord),
			idempotencyKeys: seeds.map((seed) => `group-crud-maintenance-${seed.label}`),
			sessionTimestampMs,
			sourceTurnOffset: 0,
			timezone: "UTC",
		}),
		entities,
	});
	const ids = new Map<string, string>();
	seeds.forEach((seed, index) => {
		const id = result.cardIds[index];
		if (id === undefined) throw new Error(`no row was written for ${seed.label}`);
		ids.set(seed.label, id);
	});
	return ids;
}

function readRows(fixture: TestDb): StoredRow[] {
	return fixture.runtime.db
		.prepare(
			"SELECT id, text, category, subject, attribute, lane, metadata FROM nodix_memories ORDER BY rowid",
		)
		.all() as StoredRow[];
}

function metadataOf(fixture: TestDb, rowId: string): Record<string, unknown> {
	const row = readRows(fixture).find((candidate) => candidate.id === rowId);
	if (row === undefined) throw new Error(`row ${rowId} is not in the store`);
	return JSON.parse(row.metadata) as Record<string, unknown>;
}

function rowOf(fixture: TestDb, rowId: string): StoredRow {
	const row = readRows(fixture).find((candidate) => candidate.id === rowId);
	if (row === undefined) throw new Error(`row ${rowId} is not in the store`);
	return row;
}

/** A store written before REQ-2 carries no order key anywhere. */
function stripSourceOrder(fixture: TestDb): void {
	const update = fixture.runtime.db.prepare(
		"UPDATE nodix_memories SET metadata = ? WHERE id = ?",
	);
	for (const row of readRows(fixture)) {
		const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
		delete metadata["source_order"];
		update.run(JSON.stringify(metadata), row.id);
	}
}

interface SeededStore {
	fixture: TestDb;
	ids: Map<string, string>;
}

/**
 * A MemoryStore handle for the length of one operation.
 *
 * The pass takes an immediate transaction on the same file, so no writer handle may be open while
 * it runs; opening one per operation is what keeps that true.
 */
async function withStore<T>(fixture: TestDb, run: (store: MemoryStore) => Promise<T>): Promise<T> {
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		return await run(store);
	} finally {
		await store.close();
	}
}

/** Fills a real store through the real write path, then ages it into the pre-REQ-2 shape. */
async function seedStore(): Promise<SeededStore> {
	const fixture = createTestDb();
	cleanups.push(() => fixture.cleanup());
	const ids = await withStore(fixture, async (store) => {
		const written = new Map<string, string>();
		for (const [label, id] of await writeSession(
			store,
			WEEK_ONE_SEEDS,
			[CANONICAL, PERSON],
			"weekly-session-2026-06-01",
			WEEK_ONE_MS,
			WRITE_MS,
		)) {
			written.set(label, id);
		}
		for (const [label, id] of await writeSession(
			store,
			WEEK_TWO_SEEDS,
			[VARIANT],
			"weekly-session-2026-06-08",
			WEEK_TWO_MS,
			WRITE_MS + 3_600_000,
		)) {
			written.set(label, id);
		}
		return written;
	});
	stripSourceOrder(fixture);
	expect(readRows(fixture)).toHaveLength(ALL_SEEDS.length);
	return { fixture, ids };
}

/** One real similarity search against the store, through the product's own semantic path. */
async function similarityHits(fixture: TestDb, query: string): Promise<string[]> {
	return withStore(fixture, async (store) => {
		const vector = await embedder.embed(query);
		const hits = await store.searchSemantic(vector, {
			limit: 10,
			projectIdFilter: [PROJECT_ID],
		});
		return hits.map((hit) => hit.entry.id);
	});
}

async function runPass(
	fixture: TestDb,
	options: {
		identityJudgement?: GroupCrudEntityIdentityJudgementPort;
		profileKeying?: AtomicProfileKeyingTransport;
		stateKeying?: GroupCrudStateKeyingJudgementPort;
		nowMs?: number;
	} = {},
): Promise<GroupCrudMaintenanceReport> {
	return runGroupCrudMaintenancePass({
		database: fixture.runtime.db,
		nowMs: options.nowMs ?? PASS_MS,
		...(options.identityJudgement ? { identityJudgement: options.identityJudgement } : {}),
		...(options.profileKeying ? { profileKeying: options.profileKeying } : {}),
		...(options.stateKeying ? { stateKeying: options.stateKeying } : {}),
	});
}

function receipts(fixture: TestDb): Array<{
	migrationId: string;
	beforeCount: number;
	afterCount: number;
	migratedAt: number;
}> {
	return fixture.runtime.db
		.prepare(
			`SELECT migration_id AS migrationId, before_count AS beforeCount,
				after_count AS afterCount, migrated_at AS migratedAt
			FROM nodix_todo_migration_receipts
			WHERE migration_id = 'group-crud-maintenance-v1'`,
		)
		.all() as Array<{
		migrationId: string;
		beforeCount: number;
		afterCount: number;
		migratedAt: number;
	}>;
}

describe("PRD 150 QCG-11 — the maintenance pass over a store written before this change", () => {
	it(
		"limits identity candidates by name similarity and retains the close variant",
		{ timeout: 240_000 },
		async () => {
			const fixture = createTestDb();
			cleanups.push(() => fixture.cleanup());
			const sourceName = "Acme Corp Rebrand";
			const variantName = "ACME Rebrand";
			const unrelatedNames = [
				"Alpine Marmot Habitat", "Bengal Tiger Sanctuary", "Coral Reef Nursery",
				"Desert Tortoise Shelter", "Emperor Penguin Colony", "Forest Badger Trail",
				"Galapagos Finch Survey", "Harbor Seal Rescue", "Icelandic Horse Pasture",
				"Jungle Macaw Aviary", "Koala Eucalyptus Grove", "Lake Otter Den",
				"Mountain Ibex Range", "Northern Puffin Island", "Ocean Manta Ray Lagoon",
				"Prairie Bison Herd", "Queensland Cassowary Reserve", "Red Panda Enclosure",
				"Savanna Giraffe Waterhole", "Timber Wolf Territory", "Urchin Tide Pool",
				"Violet Hummingbird Garden", "Wild Boar Woodland", "Kyoto Bamboo Forest",
				"Lisbon Tram Museum", "Oslo Fjord Ferry", "Prague Castle Courtyard",
				"Quebec Winter Carnival", "Rome Aqueduct Walk", "Seoul Lantern Festival",
				"Tallinn Medieval Walls", "Utrecht Canal Bridge", "Vienna Opera Balcony",
				"Warsaw River Promenade", "York Railway Exhibit", "Zurich Lakeside Pier",
				"Athens Olive Market", "Bruges Chocolate Workshop", "Cusco Stone Temple",
				"Dublin Poetry Reading", "Edinburgh Highland Games", "Florence Marble Statue",
				"Granada Palace Fountain", "Hanoi Noodle Stall", "Jaipur Textile Bazaar",
				"Cast Iron Skillet", "Ceramic Tea Kettle", "Folding Camping Stove",
				"Glass Terrarium Bowl", "Handwoven Wool Blanket", "Insulated Picnic Basket",
				"Juniper Wood Bookshelf", "Kitchen Sourdough Starter", "Linen Curtain Fabric",
				"Maple Violin Bow", "Nylon Climbing Rope", "Oak Chess Board",
				"Porcelain Dinner Plates", "Quartz Wall Clock", "Rattan Garden Chair",
				"Stainless Bicycle Pedals", "Terracotta Flower Pot", "Ultralight Hiking Tent",
				"Velvet Piano Cover", "Walnut Cutting Board", "Yellow Rain Boots",
				"Zinc Watering Can", "Astronomy Telescope Lens", "Basalt Mortar Pestle",
			];
			const entities = [sourceName, ...unrelatedNames, variantName].map(
				(displayName, index) => ({
					entityId: `entity:maintenance-candidate-${String(index).padStart(2, "0")}`,
					displayName,
					normalizedName: displayName.toLowerCase(),
				}),
			);
			const source = entities.find(({ displayName }) => displayName === sourceName);
			const variant = entities.find(({ displayName }) => displayName === variantName);
			if (source === undefined || variant === undefined) throw new Error("missing entity seed");
			expect(entities).toHaveLength(71);
			await withStore(fixture, async (store) => {
				const seeds: Seed[] = entities.map((entity, index) => ({
					label: entity.entityId,
					category: "state",
					subject: entity.entityId,
					subjectKind: "named_entity",
					attribute: "project.budget",
					text: `${entity.displayName} has a budget of $12,000.`,
					value: "$12,000",
					quote: `${entity.displayName} has a budget of $12,000.`,
					turnIndex: index,
				}));
				await writeSession(store, seeds, entities, "identity-candidate-limit", WEEK_ONE_MS, WRITE_MS);
			});
			fixture.runtime.db.prepare(`
				UPDATE nodix_memories
				SET metadata = json_set(metadata, '$.group_crud_maintenance_identity', 'new')
				WHERE subject <> ?
			`).run(source.entityId);
			const asks: IdentityAsk[] = [];

			await runGroupCrudMaintenancePass({
				database: fixture.runtime.db,
				embedder,
				identityJudgement: identityPort(asks),
				nowMs: PASS_MS,
			});

			expect(asks.map(({ displayName }) => displayName)).toEqual([sourceName]);
			const offered = asks[0]?.offered;
			expect(offered).toHaveLength(ENTITY_IDENTITY_CANDIDATE_LIMIT);
			expect(offered).toContain(variant.entityId);
		},
	);

	it(
		"reports scanned, changed, undecided and rolled-back counts against the seeded store",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();

			const report = await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
				stateKeying: stateKeyingPort([]),
			});

			expect(report.scanned, "the pass did not scan every row of the store").toBe(
				ALL_SEEDS.length,
			);
			// Every row lost its order key, so every row is backfilled and every row changes.
			expect(report.changed, "a row of the aged store was left untouched").toBe(
				ALL_SEEDS.length,
			);
			// Exactly one seeded row is unkeyable: the conference abstract, which the adapter
			// returns nothing for. Every other unkeyed row is either keyed by the adapter or keyed
			// from the state vocabulary after recategorization (REQ-11).
			expect(
				report.undecided,
				"the pass left rows undecided that REQ-11 says it can key",
			).toBe(1);
			expect(report.rolledBack, "the pass rolled a merge back that nothing asked it to").toBe(
				0,
			);
		},
	);

	it(
		"backfills a readable source_order on every existing row",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();
			for (const row of readRows(fixture)) {
				expect(() => readMemorySourceOrder(row.metadata)).toThrow(/source_order/);
			}

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
			});

			// Read through the product's own reader, so a key of the wrong shape counts as absent —
			// which is exactly how the order guard sees it.
			const orders = readRows(fixture).map((row) => ({
				id: row.id,
				order: readMemorySourceOrder(row.metadata),
			}));
			expect(orders).toHaveLength(ALL_SEEDS.length);
			const rowids = new Set<number>();
			for (const { id, order } of orders) {
				expect(order.valid_from, `row ${id} was backfilled with no valid_from`).not.toBeNull();
				expect(
					Number.isSafeInteger(order.session_ordinal),
					`row ${id} was backfilled with no session ordinal`,
				).toBe(true);
				expect(
					Number.isSafeInteger(order.global_turn_index),
					`row ${id} was backfilled with no turn index`,
				).toBe(true);
				rowids.add(order.rowid);
			}
			expect(rowids.size, "two rows were backfilled with one rowid").toBe(ALL_SEEDS.length);
			// The two weekly sessions have different `valid_from` values, so the backfilled session
			// ordinal must separate them rather than collapsing to a constant.
			expect(
				new Set(orders.map(({ order }) => order.session_ordinal)).size,
				"every row got the same session ordinal, so the key cannot order two sessions",
			).toBe(2);
		},
	);

	it(
		"recategorizes every entity-subject profile row to state and keys it from the state vocabulary",
		{ timeout: 240_000 },
		async () => {
			const { fixture, ids } = await seedStore();
			const asks: StateKeyingAsk[] = [];

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
				stateKeying: stateKeyingPort(asks),
			});

			for (const label of ["legacy-aim", "legacy-role"]) {
				const rowId = ids.get(label);
				if (rowId === undefined) throw new Error(`no row for ${label}`);
				const seed = seedByLabel(label);
				const expectedSlug = STATE_KEYING_ANSWERS.get(seed.text);
				if (expectedSlug === undefined) throw new Error(`no state slug answered for ${label}`);
				const row = rowOf(fixture, rowId);
				expect(
					row.category,
					`${label} has an entity subject and no event_at but stayed profile`,
				).toBe("state");
				expect(row.subject?.startsWith("entity:")).toBe(true);
				// The keying is a meaning question, so it must reach the model port — with the whole
				// vocabulary on offer, not a shortlist the engine narrowed by string.
				const ask = asks.find((candidate) => candidate.text === seed.text);
				expect(
					ask,
					`${label} was never put to the state keying judgement (asked about: ${JSON.stringify(
						asks.map((candidate) => candidate.text),
					)}), so whatever it is keyed to was not the model's answer`,
				).toBeDefined();
				expect(
					[...(ask?.offered ?? [])].sort(),
					`${label} was asked with a different slug list than the 13-slug state vocabulary`,
				).toEqual([...STATE_SLUGS].sort());
				expect(
					row.attribute,
					`${label} was asked and the judgement answered ${expectedSlug}, but the row was keyed to ${String(
						row.attribute,
					)}`,
				).toBe(expectedSlug);
				expect(metadataOf(fixture, rowId)["kind"]).toBe("state");
			}
			// The negative half: a standing fact about the person is not a state row and must not
			// be moved, whatever it is keyed to.
			for (const label of ["profile-music", "profile-tools", "profile-abstract", "profile-swim"]) {
				const rowId = ids.get(label);
				if (rowId === undefined) throw new Error(`no row for ${label}`);
				const row = rowOf(fixture, rowId);
				expect(row.category, `${label} has subject 'user' and was recategorized anyway`).toBe(
					"profile",
				);
				expect(row.subject).toBe("user");
			}
		},
	);

	it(
		"retries a state row that failed keying once within the pass, and does not persist the skip",
		{ timeout: 240_000 },
		async () => {
			const { fixture, ids } = await seedStore();
			const target = seedByLabel("legacy-aim");
			const expectedSlug = STATE_KEYING_ANSWERS.get(target.text);
			if (expectedSlug === undefined) throw new Error("no slug answered for legacy-aim");
			// One transient failure: the first ask for this row returns null (as a wedged model
			// would), every later ask in the same pass answers correctly.
			let firstAskSeen = false;
			const flakyPort = createGroupCrudStateKeyingJudgementPort({
				async respond({ text }) {
					if (text !== target.text) return STATE_KEYING_ANSWERS.get(text) ?? null;
					if (!firstAskSeen) {
						firstAskSeen = true;
						return null;
					}
					return expectedSlug;
				},
			});

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
				stateKeying: flakyPort,
			});

			const rowId = ids.get("legacy-aim");
			if (rowId === undefined) throw new Error("no row for legacy-aim");
			expect(
				rowOf(fixture, rowId).attribute,
				"the row was not keyed on the in-pass retry after a transient first failure",
			).toBe(expectedSlug);
			expect(
				metadataOf(fixture, rowId)["group_crud_maintenance_state_keying"],
				"a transient first failure persisted the skip marker, blocking every later run",
			).toBeUndefined();
		},
	);

	it(
		"persists the skip only when keying fails on the final attempt, so a second run is a no-op",
		{ timeout: 240_000 },
		async () => {
			const { fixture, ids } = await seedStore();
			// Always fails: the row genuinely cannot be keyed, so the pass must end with the marker
			// written (REQ-11 — a second full run then reports zero changes).
			const alwaysNull = createGroupCrudStateKeyingJudgementPort({
				async respond() {
					return null;
				},
			});

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
				stateKeying: alwaysNull,
			});

			const rowId = ids.get("legacy-aim");
			if (rowId === undefined) throw new Error("no row for legacy-aim");
			expect(
				rowOf(fixture, rowId).attribute,
				"a row that never keys must not be keyed",
			).not.toBe("project.objective");
			expect(
				metadataOf(fixture, rowId)["group_crud_maintenance_state_keying"],
				"a genuine keying failure did not persist the skip, so a later run keeps re-asking",
			).toBe("undecided");
		},
	);

	it(
		"re-keys an entity table still on the (project_id, entity_id) key before its first merge",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();
			// The maintenance command opens the store raw, so a store the new runtime has never
			// opened still carries the 0032 table shape; the merge's UPDATE of entity_id lands on
			// the target's own primary-key row.
			fixture.runtime.db.exec(`
				CREATE TABLE nodix_memory_entities_legacy (
					project_id TEXT NOT NULL,
					entity_id TEXT NOT NULL,
					display_name TEXT NOT NULL,
					normalized_name TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					PRIMARY KEY(project_id, entity_id),
					UNIQUE(project_id, normalized_name)
				) WITHOUT ROWID;
				INSERT INTO nodix_memory_entities_legacy
					SELECT project_id, entity_id, display_name, normalized_name, created_at
					FROM nodix_memory_entities;
				DROP TABLE nodix_memory_entities;
				ALTER TABLE nodix_memory_entities_legacy RENAME TO nodix_memory_entities;
			`);

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
			});

			const primaryKey = (
				fixture.runtime.db.prepare("PRAGMA table_info(nodix_memory_entities)").all() as Array<{
					name: string;
					pk: number;
				}>
			)
				.filter((column) => column.pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map((column) => column.name);
			expect(primaryKey, "the entity table was not re-keyed by name").toEqual([
				"project_id",
				"normalized_name",
			]);
			expect(
				(
					fixture.runtime.db
						.prepare("SELECT COUNT(*) AS n FROM nodix_memories WHERE subject = ?")
						.get(VARIANT.entityId) as { n: number }
				).n,
				"the shorthand entity still owns rows after the merge",
			).toBe(0);
			expect(receipts(fixture), "the pass wrote no receipt").toHaveLength(1);
		},
	);

	it(
		"merges the split entity under one merge_id, journalled, and moves only its rows",
		{ timeout: 240_000 },
		async () => {
			const { fixture, ids } = await seedStore();
			const asks: IdentityAsk[] = [];

			await runPass(fixture, {
				identityJudgement: identityPort(asks),
				profileKeying: new MaintenanceKeyingTransport(),
			});

			expect(
				asks.map((ask) => ask.displayName),
				"the pass never asked about the shorthand name that split the entity",
			).toContain(VARIANT.displayName);
			const mergeIds = new Set<string>();
			for (const label of ["state-timeline", "state-stakeholder"]) {
				const rowId = ids.get(label);
				if (rowId === undefined) throw new Error(`no row for ${label}`);
				const row = rowOf(fixture, rowId);
				expect(
					row.subject,
					`${label} stayed under the shorthand entity after the merge`,
				).toBe(CANONICAL.entityId);
				const mergeId = metadataOf(fixture, rowId)["merge_id"];
				expect(typeof mergeId, `${label} moved without a merge_id`).toBe("string");
				mergeIds.add(String(mergeId));
			}
			expect(mergeIds.size, "one merge wrote two different merge ids").toBe(1);
			const [mergeId] = [...mergeIds];

			// A row that was already under the surviving entity is not part of the merge.
			const untouched = ids.get("state-budget");
			if (untouched === undefined) throw new Error("no row for state-budget");
			expect(
				metadataOf(fixture, untouched)["merge_id"],
				"a row that never moved was tagged with the merge",
			).toBeUndefined();

			const journal = (
				fixture.runtime.db
					.prepare(
						`SELECT detail FROM nodix_rem_journal
						WHERE stage = 'entity-identity' AND outcome = 'done' AND json_valid(detail)`,
					)
					.all() as Array<{ detail: string }>
			).map((row) => JSON.parse(row.detail) as Record<string, unknown>);
			expect(journal, "the merge left no entity-identity journal line").toHaveLength(1);
			const [detail] = journal;
			expect(detail?.["merge_id"], "the journal names a different merge").toBe(mergeId);
			expect(detail?.["entity_id"]).toBe(CANONICAL.entityId);
			expect(detail?.["display_name"]).toBe(VARIANT.displayName);
			expect(detail?.["offered_entity_ids"]).toContain(CANONICAL.entityId);
		},
	);

	it(
		"points the merged-away name at the surviving entity, so the next write does not re-split it",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();

			const before = await withStore(fixture, async (store) =>
				store.resolveAtomicMemoryEntity(PROJECT_ID, VARIANT.displayName),
			);
			expect(
				before.entityId,
				"the shorthand did not start on its own entity, so the merge below proves nothing",
			).toBe(VARIANT.entityId);

			await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
			});

			// The name is what the next extraction resolves through. A merge that moves the rows but
			// leaves the name on the old entity is undone by the first write that uses the name again.
			const after = await withStore(fixture, async (store) =>
				store.resolveAtomicMemoryEntity(PROJECT_ID, VARIANT.displayName),
			);
			expect(
				after.entityId,
				"the shorthand still resolves to the entity the merge emptied",
			).toBe(CANONICAL.entityId);
			expect(
				after.registration,
				"the shorthand was re-registered as a new entity instead of aliased",
			).toBeUndefined();

			// A name that was never part of a merge keeps its own entity.
			const untouched = await withStore(fixture, async (store) =>
				store.resolveAtomicMemoryEntity(PROJECT_ID, PERSON.displayName),
			);
			expect(untouched.entityId, "an unrelated name was moved by the merge").toBe(
				PERSON.entityId,
			);
		},
	);

	it(
		"never leaves a name pointing at an entity the pass emptied, however the judge answers",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();

			// An adversarial but entirely legal judge: it merges whatever it is asked about into the
			// first entity it is offered. That is what a chained merge looks like — A into B, then B
			// offered A again — and it is the answer that used to send the rows back out of the
			// entity they had just been merged into.
			const greedy = createGroupCrudEntityIdentityJudgementPort({
				async respond({ existingDisplayNames }) {
					const [first] = existingDisplayNames;
					if (!first) return { decision: "new" };
					return { decision: "existing", entityId: first.entityId };
				},
			});
			await runPass(fixture, {
				identityJudgement: greedy,
				profileKeying: new MaintenanceKeyingTransport(),
			});

			const names = fixture.runtime.db
				.prepare("SELECT display_name AS displayName, entity_id AS entityId FROM nodix_memory_entities")
				.all() as Array<{ displayName: string; entityId: string }>;
			expect(names.length, "the fixture registered no entity names").toBeGreaterThan(1);

			const rowCountOf = (entityId: string): number =>
				(
					fixture.runtime.db
						.prepare(
							"SELECT COUNT(*) AS total FROM nodix_memories WHERE project_id = ? AND subject = ?",
						)
						.get(PROJECT_ID, entityId) as { total: number }
				).total;

			// The invariant: a name resolves to an entity that still holds the rows written under it.
			// A name left on an emptied entity re-splits that entity on the very next write.
			// Every merge empties one entity, so a pass over N entities cannot need more than N-1 of
			// them. More than that means it merged into an entity it had already emptied and moved
			// the same rows a second time.
			const merges = (
				fixture.runtime.db
					.prepare(
						"SELECT COUNT(*) AS total FROM nodix_rem_journal WHERE stage = 'entity-identity' AND outcome = 'done'",
					)
					.get() as { total: number }
			).total;
			expect(
				merges,
				"the pass merged into an entity it had already emptied",
			).toBeLessThanOrEqual(names.length - 1);

			// Every merge must still own its rows. A chained merge (A→B then B→C) rewrites the rows'
			// `merge_id` to the second merge, so the first merge's id names nothing and its rollback
			// restores nothing. Assert each recorded merge id is carried by at least one row.
			const mergeIds = (
				fixture.runtime.db
					.prepare(
						`SELECT detail FROM nodix_rem_journal
						 WHERE stage = 'entity-identity' AND outcome = 'done' AND json_valid(detail)`,
					)
					.all() as Array<{ detail: string }>
			).map((row) => String((JSON.parse(row.detail) as Record<string, unknown>)["merge_id"]));
			for (const mergeId of mergeIds) {
				const carriers = (
					fixture.runtime.db
						.prepare(
							`SELECT COUNT(*) AS total FROM nodix_memories
							 WHERE project_id = ? AND json_valid(metadata)
								AND json_extract(metadata, '$.merge_id') = ?`,
						)
						.get(PROJECT_ID, mergeId) as { total: number }
				).total;
				expect(
					carriers,
					`merge ${mergeId} owns no rows — a later merge overwrote its id`,
				).toBeGreaterThan(0);
			}
			const stranded = await withStore(fixture, async (store) =>
				names
					.filter(({ displayName }) => {
						const resolved = store.resolveAtomicMemoryEntity(PROJECT_ID, displayName);
						return resolved.registration === undefined && rowCountOf(resolved.entityId) === 0;
					})
					.map(({ displayName }) => displayName),
			);
			expect(stranded, "a name resolves to an entity the pass emptied").toEqual([]);
		},
	);

	it(
		"keys what the adapter can key, retries the failed call, and leaves the undecided row reachable by similarity",
		{ timeout: 300_000 },
		async () => {
			const { fixture, ids } = await seedStore();
			const undecidedId = ids.get("profile-abstract");
			if (undecidedId === undefined) throw new Error("no row for profile-abstract");
			const query = "when does the conference abstract have to be ready";
			const searchBefore = await similarityHits(fixture, query);
			expect(
				searchBefore,
				"the undecided row was not reachable by similarity BEFORE the pass, so the check after it proves nothing",
			).toContain(undecidedId);

			const transport = new MaintenanceKeyingTransport();
			await runPass(fixture, { identityJudgement: identityPort([]), profileKeying: transport });

			for (const label of ["profile-music", "profile-tools", "profile-swim"]) {
				const rowId = ids.get(label);
				if (rowId === undefined) throw new Error(`no row for ${label}`);
				const seed = ALL_SEEDS.find((candidate) => candidate.label === label);
				const row = rowOf(fixture, rowId);
				expect(row.attribute, `${label} was left unkeyed though the adapter keys it`).toBe(
					seed?.adapterSlug,
				);
				const metadata = metadataOf(fixture, rowId);
				expect(metadata["section_name"]).toBe(seed?.adapterSlug);
				expect(
					metadata["keying_note"],
					`${label} is keyed and still carries the note saying it is not`,
				).toBeUndefined();
			}
			// The failed-keying row is proof of the retry: it went in with `keying-failed` and only a
			// second ask can have cleared it.
			expect(
				transport.askedFor.some((content) => content.includes("swim for an hour")),
				"the pass never retried the row whose keying call had failed",
			).toBe(true);

			const undecided = rowOf(fixture, undecidedId);
			expect(undecided.attribute, "a row the adapter cannot key was keyed anyway").toBeNull();
			expect(undecided.lane, "the undecided row was parked out of reach").toBe("active");

			expect(
				await similarityHits(fixture, query),
				"the undecided row stopped being reachable by similarity after the pass",
			).toContain(undecidedId);
		},
	);

	it(
		"a second run on the same store reports zero changes and rewrites no row",
		{ timeout: 300_000 },
		async () => {
			const { fixture } = await seedStore();
			const asks: IdentityAsk[] = [];
			const first = await runPass(fixture, {
				identityJudgement: identityPort(asks),
				profileKeying: new MaintenanceKeyingTransport(),
			});
			expect(first.changed).toBeGreaterThan(0);
			const before = readRows(fixture);

			const second = await runPass(fixture, {
				identityJudgement: identityPort(asks),
				profileKeying: new MaintenanceKeyingTransport(),
				nowMs: PASS_MS + 86_400_000,
			});

			const after = readRows(fixture);
			const rewritten = after.filter((row, index) => {
				const previous = before[index];
				return previous === undefined || previous.metadata !== row.metadata;
			});
			expect(
				rewritten.map((row) => ({
					id: row.id,
					text: row.text,
					before: before.find((candidate) => candidate.id === row.id)?.metadata,
					after: row.metadata,
				})),
				`the second run rewrote row metadata on a store it had already migrated, and reported ${second.changed} changed rows`,
			).toEqual([]);
			expect(second.scanned, "the second run scanned a different store").toBe(first.scanned);
			expect(second.changed, "the second run changed rows on an already-migrated store").toBe(
				0,
			);
			expect(after.map((row) => ({ ...row, metadata: undefined }))).toEqual(
				before.map((row) => ({ ...row, metadata: undefined })),
			);
		},
	);

	it(
		"writes the completion receipt after a successful run",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();

			const report = await runPass(fixture, {
				identityJudgement: identityPort([]),
				profileKeying: new MaintenanceKeyingTransport(),
			});

			expect(receipts(fixture), "a successful pass left no completion receipt").toEqual([
				{
					migrationId: "group-crud-maintenance-v1",
					beforeCount: report.scanned,
					afterCount: report.scanned,
					migratedAt: PASS_MS,
				},
			]);
		},
	);

	it(
		"writes no receipt when a step fails, so a half-migrated store is never marked done",
		{ timeout: 240_000 },
		async () => {
			const { fixture } = await seedStore();
			const failing = createGroupCrudEntityIdentityJudgementPort({
				async respond() {
					throw new Error("entity identity judgement is unavailable");
				},
			});

			await expect(
				runPass(fixture, {
					identityJudgement: failing,
					profileKeying: new MaintenanceKeyingTransport(),
				}),
			).rejects.toThrow(/entity identity judgement is unavailable/);

			expect(
				receipts(fixture),
				"a run that failed mid-way still wrote the completion receipt, so recall would read this store as migrated",
			).toEqual([]);
		},
	);
});
