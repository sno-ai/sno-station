/** @file atomic-document-naming.test.ts
 * @purpose Proves a dictated document's fields all land under one named entity, and a later removal stays live under it.
 * @boundary The real distiller, window split, entity registry and write door over real encrypted SQLite; the model is the only substitute.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	AtomicInsightDistiller,
	type AtomicMemoryExtractionTransports,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-document-naming";

/**
 * Memora session 42 of the business executive, as the engine cuts it: the purpose turn, the
 * recipients turn and the key-points turn each own a different two-turn window, so the purpose is
 * out of view when the recipients and the key points are extracted. Measured 2026-09-06: the model
 * returns every one of these fields with subject "the email", `unresolved` — it never names an
 * e-mail from its purpose sentence — and each field landed as a keyless episodic row. A later
 * removal of a recipient then closed itself at create and the member row stayed live.
 */
const PURPOSE =
	"To align leadership on our strategic pivot toward patient-centered digital health solutions and secure commitment for resource allocation across divisions.";
const PURPOSE_TURN = `The email's purpose is ${PURPOSE.charAt(0).toLowerCase()}${PURPOSE.slice(1)}`;
/**
 * The second wording of the same name. The purpose turn is in view for two windows, and the
 * second names the e-mail from it in its own words — no leading "To", no final period. Offered
 * both wordings, the real judge reads two candidates that could equally be it and answers null
 * for every field (measured 2026-09-06, every field of this e-mail).
 */
const PURPOSE_REWORDED = PURPOSE.replace(/^To /u, "").replace(/\.$/u, "");
const RECIPIENTS_TURN =
	"The email needs to go to the Chief Financial Officer, Head of R&D, and Chief Operating Officer.";
const KEY_POINTS_TURN =
	"The key points are that financial modeling projects break-even within 24 months with an estimated ROI of 35% by year three, and market analysis indicates a growing demand for integrated care platforms.";
const DICTATION = [
	"user: Hey there! How's it going?",
	"assistant: Going well. What can I do for you?",
	"user: I need to add some content for an email. Can you help me structure the information I have?",
	"assistant: Of course. What is the email's purpose?",
	`user: ${PURPOSE_TURN}`,
	"assistant: Got it. Who should receive it?",
	`user: ${RECIPIENTS_TURN}`,
	"assistant: Noted. What are the key points?",
	`user: ${KEY_POINTS_TURN}`,
	"assistant: I have everything I need.",
].join("\n");
const REMOVAL_TURN = "Yes, please remove 'Chief Operating Officer' from the recipient list.";
const REMOVAL_SESSION = [
	"user: I need to remove some information from my email.",
	"assistant: Sure. What should be removed?",
	`user: ${REMOVAL_TURN}`,
	"assistant: Done.",
].join("\n");

interface WireRecord {
	claim_text: string;
	attribute: string;
	value: string;
	quote: string;
	ends_current?: boolean;
	/** The model named the document on this record instead of leaving it unresolved. */
	named?: string;
}

/** The reply shape the model actually returns for a document field: subject "the email", unresolved, unless it named the document itself. */
function unresolvedEmailRecord(turnIndex: number, record: WireRecord) {
	return {
		kind: "standing",
		claim_text: record.claim_text,
		subject: record.named ?? "the email",
		subject_kind: record.named === undefined ? "unresolved" : "named_entity",
		attribute: record.attribute,
		value: record.value,
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: record.ends_current === true,
		ends_current: record.ends_current === true,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: turnIndex, quote: record.quote },
		relations: [],
		single_claim: true,
	};
}

/** Per owned turn, the records the probe measured the shipping prompt returning for it. */
const FIELDS_BY_TURN: ReadonlyMap<string, WireRecord[]> = new Map([
	[
		PURPOSE_TURN,
		[
			{
				claim_text: `The email's purpose is ${PURPOSE.charAt(0).toLowerCase()}${PURPOSE.slice(1)}`,
				attribute: "email.purpose",
				value: PURPOSE,
				quote: PURPOSE_TURN,
			},
		],
	],
	[
		RECIPIENTS_TURN,
		[
			{ claim_text: "The email's recipient is the Chief Financial Officer.", attribute: "email.recipient", value: "Chief Financial Officer", quote: "Chief Financial Officer" },
			{ claim_text: "The email's recipient is the Head of R&D.", attribute: "email.recipient", value: "Head of R&D", quote: "Head of R&D" },
			{ claim_text: "The email's recipient is the Chief Operating Officer.", attribute: "email.recipient", value: "Chief Operating Officer", quote: "Chief Operating Officer" },
		],
	],
	[
		KEY_POINTS_TURN,
		[
			{ claim_text: "The email's key point is that financial modeling projects break-even within 24 months.", attribute: "email.key_point", value: "financial modeling projects break-even within 24 months", quote: "financial modeling projects break-even within 24 months" },
			{ claim_text: "The email's key point is that market analysis indicates a growing demand for integrated care platforms.", attribute: "email.key_point", value: "market analysis indicates a growing demand for integrated care platforms", quote: "market analysis indicates a growing demand for integrated care platforms" },
		],
	],
	[
		REMOVAL_TURN,
		[
			{
				claim_text: "'Chief Operating Officer' is no longer a recipient of the email.",
				attribute: "email.recipient",
				value: "Chief Operating Officer",
				quote: "remove 'Chief Operating Officer' from the recipient list",
				ends_current: true,
			},
		],
	],
]);

interface IdentityPayload {
	new_display_name: string;
	existing_entities: Array<{ entity_id: string; display_name: string }>;
}

/**
 * Stands in for the model only. The extraction pass answers each window from the turns it was
 * given, for the turns it owns; the resolver answers null as soon as two candidates are on offer,
 * as the real judge does; the entity-identity judgement merges a name onto an existing entity
 * whose display name is the same name in either wording and calls anything else new — which is
 * what the real judge did for these two wordings in the replay.
 */
function sameWording(left: string, right: string): boolean {
	const fold = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	return fold(left).includes(fold(right)) || fold(right).includes(fold(left));
}
function transports(
	answered: (turn: string, prompt: string) => boolean,
	/** How many resolver calls come back cut off first, as the real model does under load. */
	resolverTruncatedCalls = 0,
): AtomicMemoryExtractionTransports {
	let truncatedLeft = resolverTruncatedCalls;
	const sliceTurns = (prompt: string): { turn_index: number; content: string }[] => {
		const match = /\[\{"turn_index".*?\}\]/su.exec(prompt);
		return match ? (JSON.parse(match[0]) as { turn_index: number; content: string }[]) : [];
	};
	return {
		generic: {
			async complete({ prompt }) {
				if (prompt.includes("Task: resolve each unresolved standing subject")) {
					if (truncatedLeft > 0) {
						truncatedLeft -= 1;
						return { text: '{"resolutions": [', truncated: true };
					}
					// The re-ask: the real judge picks the document the claim edits among the names the
					// conversation gave (raw strings) and the registry's entities (ids); the only
					// e-mail on offer is it.
					const candidates = [
						...prompt.matchAll(/"subject":\s*"([^"]+)",\s*"display_name":\s*"([^"]*)"/gu),
					];
					const email =
						candidates.length === 1 &&
						[PURPOSE, PURPOSE_REWORDED].includes(candidates[0]?.[2] ?? "")
							? (candidates[0]?.[1] ?? null)
							: null;
					const recordCount = (prompt.match(/"recordIndex"/gu) ?? []).length;
					const resolutions = Array.from({ length: recordCount }, (_, index) => ({
						record_index: index,
						subject: email,
					}));
					return { text: JSON.stringify({ resolutions }), truncated: false };
				}
				if (prompt.includes('"new_display_name"')) {
					const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)) as IdentityPayload;
					const same = payload.existing_entities.find(({ display_name }) =>
						sameWording(display_name, payload.new_display_name),
					);
					return { text: JSON.stringify({ entity_id: same?.entity_id ?? "new" }), truncated: false };
				}
				const turns = sliceTurns(prompt);
				const records = turns.flatMap(({ turn_index, content }, position) => {
					if (!answered(content, prompt)) return [];
					const fields = FIELDS_BY_TURN.get(content) ?? [];
					// The second window that sees the purpose turn (it opens that window's slice) names the
					// e-mail from it in its own words instead of returning the field.
					const reworded = content === PURPOSE_TURN && position === 0;
					return fields.map((record) =>
						unresolvedEmailRecord(turn_index, reworded ? { ...record, named: PURPOSE_REWORDED } : record),
					);
				});
				return { text: JSON.stringify({ records }), truncated: false };
			},
		},
		profileKeying: { async keyTurn() { return null; } },
		resplit: { async resplit() { return null; } },
		subjectGuard: {
			async repairMissingHalf() { return null; },
			async guardUserSubjects({ records }) { return records.map(() => true); },
		},
	} as unknown as AtomicMemoryExtractionTransports;
}

/**
 * Which turns a window answers. The extraction prompt carries no ownership list — a window
 * answers every turn in view and the engine's admission keeps only the turns it owns — so the
 * purpose turn is answered by the two windows that see it and by neither of the later ones. The
 * numeric sweep's re-ask does list the turns to account for, and is answered for those only.
 */
function answeredByPrompt(turn: string, prompt: string): boolean {
	const listed = /turn_indexes_to_account_for:\s*(\[[^\]]*\])/u.exec(prompt);
	const slice = /\[\{"turn_index".*?\}\]/su.exec(prompt);
	if (!slice) throw new Error("extraction prompt carries no turns");
	const turns = JSON.parse(slice[0]) as { turn_index: number; content: string }[];
	if (!listed) return turns.some(({ content }) => content === turn);
	const indexes = JSON.parse(listed[1] ?? "[]") as number[];
	return turns.some(({ turn_index, content }) => content === turn && indexes.includes(turn_index));
}

interface StoredRow {
	text: string;
	category: string;
	lane: string;
	subject: string | null;
	attribute: string | null;
	superseded_by: string | null;
}

function readRows(store: MemoryStore): StoredRow[] {
	return store.sqlite
		.prepare(
			`SELECT text, category, lane, subject, attribute,
				json_extract(metadata, '$.superseded_by') AS superseded_by
			FROM nodix_memories WHERE project_id = ? ORDER BY rowid`,
		)
		.all(PROJECT_ID) as StoredRow[];
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic document naming", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	it(
		"keys every field of a dictated e-mail to the one entity its purpose sentence names, and a later removal stays live under it",
		{ timeout: 120_000 },
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const distiller = new AtomicInsightDistiller(store, transports(answeredByPrompt), {
				defaultScope: PROJECT_ID,
				locale: "en",
			});
			const options = { sessionDateTime: "2026-06-02T12:00:00Z", sessionTimezone: "UTC" };

			await distiller.extractAndPersist(DICTATION, "email-session-42", options);
			const dictated = readRows(store);
			const evidence = JSON.stringify(dictated, null, 1);
			// Purpose, three recipients, two key points: six fields, every one a state row.
			expect(dictated, evidence).toHaveLength(6);
			expect(dictated.every((row) => row.category === "state"), evidence).toBe(true);
			const subjects = new Set(dictated.map((row) => row.subject));
			expect(subjects.size, `fields split across ${subjects.size} subjects.\n${evidence}`).toBe(1);
			const [entityId] = subjects;
			expect(entityId, evidence).toMatch(/^entity:/u);
			const entity = store.sqlite
				.prepare("SELECT display_name FROM nodix_memory_entities WHERE project_id = ? AND entity_id = ?")
				.get(PROJECT_ID, entityId) as { display_name: string } | undefined;
			// Whichever wording reached the chain first is the entity's name; both are the purpose.
			expect([PURPOSE, PURPOSE_REWORDED], evidence).toContain(entity?.display_name);

			// A later session refers to "the email" with the purpose out of view. The registry
			// names it; the removal is a live ended row of the same entity, and the member row it
			// ends is the one the arrival judgement is offered (closing it is the judgement's call,
			// not this test's).
			await distiller.extractAndPersist(REMOVAL_SESSION, "email-session-114", options);
			const rows = readRows(store);
			const removal = rows.find((row) => row.text.includes("no longer a recipient"));
			expect(removal, JSON.stringify(rows, null, 1)).toBeDefined();
			expect(removal?.category).toBe("state");
			expect(removal?.subject).toBe(entityId);
			expect(removal?.attribute).toBe("email.recipient");
			expect(removal?.superseded_by).toBeNull();
			// Live means the reader can see it: the active lane, not merely an empty superseded_by.
			expect(removal?.lane).toBe("active");
		},
	);

	it(
		"asks the resolver again after a cut-off answer, and still keys every field",
		{ timeout: 120_000 },
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const distiller = new AtomicInsightDistiller(store, transports(answeredByPrompt, 1), {
				defaultScope: PROJECT_ID,
				locale: "en",
			});
			await distiller.extractAndPersist(DICTATION, "email-session-42", {
				sessionDateTime: "2026-06-02T12:00:00Z",
				sessionTimezone: "UTC",
			});
			const dictated = readRows(store);
			const evidence = JSON.stringify(dictated, null, 1);
			// One cut-off answer used to turn that window's fields into unkeyed episodic rows.
			expect(dictated, evidence).toHaveLength(6);
			expect(dictated.every((row) => row.category === "state"), evidence).toBe(true);
			expect(new Set(dictated.map((row) => row.subject)).size, evidence).toBe(1);
		},
	);

	it(
		"still writes the fields, unkeyed, when the resolver never answers, and holds no chunk back",
		{ timeout: 120_000 },
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const distiller = new AtomicInsightDistiller(
				store,
				transports(answeredByPrompt, Number.POSITIVE_INFINITY),
				{ defaultScope: PROJECT_ID, locale: "en" },
			);
			await distiller.extractAndPersist(DICTATION, "email-session-42", {
				sessionDateTime: "2026-06-02T12:00:00Z",
				sessionTimezone: "UTC",
			});
			const rows = readRows(store);
			const ledger = store.sqlite
				.prepare("SELECT state, reprocess_reason AS reason FROM nodix_atomic_extraction_ledger")
				.all() as Array<{ state: string; reason: string | null }>;
			const evidence = `${JSON.stringify(rows, null, 1)}\n${JSON.stringify(ledger)}`;
			// The subject is unknown, so the fields land unkeyed as they always did — but they land.
			// A chunk held back is a chunk a single-pass caller never sends again, and its whole
			// window is then simply gone (measured 2026-09-07: 12 chunks over six personas).
			// Every field the model returned is still on disk (the reworded copy of the purpose the
			// second window names makes a seventh row; what matters is that none was dropped).
			for (const field of ["purpose", "Chief Financial Officer", "Head of R&D", "Chief Operating Officer", "break-even", "integrated care"]) {
				expect(
					rows.some((row) => row.text.includes(field)),
					`${field} was not written.\n${evidence}`,
				).toBe(true);
			}
			expect(
				rows.filter((row) => row.subject === null).every((row) => row.category === "episodic"),
				evidence,
			).toBe(true);
			expect(
				ledger.filter(({ state }) => state === "pending_reprocess"),
				evidence,
			).toHaveLength(0);
		},
	);
});
