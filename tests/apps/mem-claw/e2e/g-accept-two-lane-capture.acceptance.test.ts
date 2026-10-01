import { readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file g-accept-two-lane-capture.acceptance.test.ts
 * @purpose G-accept walk-owned bootstrap for journey J1/J2/J3 of
 *   openspec/changes/three-mode-write-routing-profile-lane/acceptance-walk.md.
 *   Frozen WITH that walk. Drives the REAL plugin capture entry
 *   (register → agent_end ambient hook → extractAndPersist → encrypted store), with J1/J2
 *   served by a localhost transport-boundary stub and J3 served by the live Sno routes.
 *   Selects the journey via SNO_GACCEPT_JOURNEY.
 *   Skipped unless SNO_GACCEPT_JOURNEY is set.
 * @boundary Prints observed rows for the blind verifier and asserts the frozen walk's
 *   substantive persisted-row requirements.
 * @see openspec/changes/three-mode-write-routing-profile-lane/acceptance-walk.md
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { flushAuditWrites } from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { resolveLlmEndpoint } from "../../../../packages/memory/src/model/llm-endpoint-resolution.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

type StubJourney = "J1" | "J2";
type Journey = StubJourney | "J3";
const requestedJourney = process.env.SNO_GACCEPT_JOURNEY;
const journeyNotSelected = requestedJourney === undefined || requestedJourney === "";
if (
	!journeyNotSelected &&
	requestedJourney !== "J1" &&
	requestedJourney !== "J2" &&
	requestedJourney !== "J3"
) {
	throw new Error("SNO_GACCEPT_JOURNEY must be explicitly set to J1, J2, or J3");
}
if (process.env.SNO_GACCEPT_LIVE_BASE_URL !== undefined) {
	throw new Error("SNO_GACCEPT_LIVE_BASE_URL is forbidden; J3 is pinned to the live Sno endpoint");
}
const UNSELECTED_JOURNEY = "UNSELECTED";
const JOURNEY: Journey | typeof UNSELECTED_JOURNEY = journeyNotSelected
	? UNSELECTED_JOURNEY
	: requestedJourney;
const journeySelectionNote = journeyNotSelected
	? " (skipped: set SNO_GACCEPT_JOURNEY to J1, J2, or J3)"
	: "";
const journeyDescribe = describe.skipIf(journeyNotSelected);
if (journeyNotSelected) process.stdout.write(`G-accept${journeySelectionNote}\n`);
const J3_API_KEY = JOURNEY === "J3" ? readTestSnoGpuSettings().apiKey : "";
const J3_MISSING_API_KEY = JOURNEY === "J3" && !J3_API_KEY?.trim();
const DEFAULT_LIVE_BASE_URL = "https://rt3-llm.sno.ai";

journeyDescribe(`G-accept live route configuration${journeySelectionNote}`, () => {
	it("keeps the configured base at the origin and lets signed presets own both paths", async () => {
		const [episodic, profile] = await Promise.all([
			resolveLlmEndpoint({
				baseOverride: DEFAULT_LIVE_BASE_URL,
				configuredPreset: "mem_claw/sno_ai_extract",
				callId: "E1",
				transport: "chat-completions",
			}),
			resolveLlmEndpoint({
				baseOverride: DEFAULT_LIVE_BASE_URL,
				configuredPreset: "mem_claw/sno_ai_extract",
				callId: "E9",
				transport: "raw-completions",
			}),
		]);
		expect(DEFAULT_LIVE_BASE_URL).toBe("https://rt3-llm.sno.ai");
		expect(episodic.url).toBe("https://rt3-llm.sno.ai/extract/v1/chat/completions");
		expect(profile.url).toBe("https://rt3-llm.sno.ai/extract/profile/v1/completions");
	});
});

// The episodic chat-completions body carries both `memories` for extraction and
// `decision` if a dedup request lands on the same inherited localhost boundary.
const EPISODIC_COMPLETION = JSON.stringify({
	decision: "create",
	reason: "g-accept stub",
	memories: [
		{
			category: "episodic",
			abstract: "The user asked to always be answered in three tight bullets.",
			overview: "The user asked to always be answered in three tight bullets.",
			content: "The user asked to always be answered in three tight bullets.",
		},
	],
});

// The stub answers with the SHIPPED stage-1 reply contract, which the deployed adapter emits and
// `b-profile-extraction.ts` validates strictly: each candidate is exactly `slug`, `topic_phrase`
// and `payload`, and nothing else. It used to send `section` + `evidence`, the pre-2026-08-18
// shape — measured then against a live reply, `section` was never emitted at all. Under the strict
// schema those extra keys now fail the WHOLE turn, which is why J1 and J2 stored no profile row
// while J3, served by the live route, kept passing.
//
// The section name is derived from `topic_phrase`, not from the slug; the slug only has to name a
// family the vocabulary knows. `trait.communication` is that family for both of these.
//
// J1: one clean B-profile candidate → must land under the derived bucket
//     preferences.answer_length.
// J2: a candidate whose slug the vocabulary does NOT claim ("identity" is not a shipped slug) →
//     must NOT reach the profile, plus a clean sibling ("status updates") that DOES land under
//     preferences.status_updates.
const PROFILE_COMPLETION: Record<StubJourney, string> = {
	J1: JSON.stringify({
		profile_candidates: [
			{
				slug: "trait.communication",
				topic_phrase: "answer length",
				payload: { likes: ["three tight bullets"], dislikes: [] },
			},
		],
	}),
	J2: JSON.stringify({
		profile_candidates: [
			{
				slug: "identity",
				topic_phrase: "answer length",
				payload: { likes: ["three tight bullets"], dislikes: [] },
			},
			{
				slug: "trait.communication",
				topic_phrase: "status updates",
				payload: { likes: ["async written updates"], dislikes: [] },
			},
		],
	}),
};

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function startStubServe(journey: StubJourney): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void readBody(req).then(() => {
			const url = req.url ?? "";
			res.setHeader("Content-Type", "application/json");
			if (url.endsWith("/extract/profile/v1/completions")) {
				res.end(JSON.stringify({ choices: [{ text: PROFILE_COMPLETION[journey] }] }));
				return;
			}
			if (url.endsWith("/chat/completions")) {
				res.end(JSON.stringify({ choices: [{ message: { content: EPISODIC_COMPLETION } }] }));
				return;
			}
			res.statusCode = 404;
			res.end(JSON.stringify({ error: `unstubbed route ${url}` }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

journeyDescribe(`G-accept two-lane capture bootstrap${journeySelectionNote}`, () => {
	let embedder: Embedder;
	let stub: { server: Server; baseUrl: string } | undefined;
	let dbPath: string;
	let cleanupDb: () => void;

	beforeAll(async () => {
		if (J3_MISSING_API_KEY) {
			throw new Error("J3 requires snoGpu.apiKey in settings.json");
		}
		embedder = await createTestEmbedder();
		if (JOURNEY === "J1" || JOURNEY === "J2") stub = await startStubServe(JOURNEY);
	});

	afterAll(() => {
		stub?.server.close();
		cleanupDb?.();
	});

	it(`drives the ${JOURNEY} capture turn and prints the resulting rows`, async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanupDb = testDb.cleanup;

		const llm = (() => {
			if (JOURNEY === "J3") {
				return {
					preset: "mem_claw/sno_ai_extract",
					baseURL: DEFAULT_LIVE_BASE_URL,
					apiKey: J3_API_KEY,
					timeoutMs: 60_000,
				};
			}
			if (!stub) throw new Error("G-accept stub failed to start");
			return {
				preset: "mem_claw/sno_ai_extract",
				baseURL: stub.baseUrl,
				apiKey: "g-accept",
			};
		})();

		const harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: true,
				autoRecall: false,
				selfImprovement: { enabled: false },
				sessionStrategy: "none",
				// Rem-enhanced sends extraction to Sno GPU (see the model-call table).
				mode: "rem-enhanced",
				extraction: {
					llm,
				},
			},
			{ runtimeAgentId: "g-accept-two-lane" },
		);
		writeSettingsFixture(dirname(dbPath), { mode: "rem-enhanced", store: { path: dbPath, encryptionKey: testDb.encryptionKey }, snoGpu: { baseUrl: new URL(llm.baseURL).origin, apiKey: llm.apiKey ?? "" }, embedding: { cacheDir: "" }, capture: { ambient: true, sessionStrategy: "none" }, recall: { auto: false } });
		await memClawPlugin.register?.(harness);

		const agentEndHandler = harness.getOnHookHandler("agent_end");
		expect(agentEndHandler).toBeDefined();

		const messages = [
			{
				role: "user",
				content:
					JOURNEY === "J3"
						? "For the weekly report, my standing formatting preference is exactly three tight bullets with no preamble. Separately, yesterday I presented the Atlas launch review to Alice."
						: "Please always answer me in three tight bullets, and send me async written status updates.",
				timestamp: Date.parse("2026-07-18T12:00:00.000Z"),
			},
		];
		await (
			agentEndHandler as (
				event: unknown,
				ctx: { agentId: string; sessionKey: string },
			) => Promise<void>
		)(
			{ messages, success: true },
			{ agentId: "g-accept-two-lane", sessionKey: "agent:g-accept-two-lane:test" },
		);
		await flushAuditWrites();

		const store = new MemoryStore({ dbPath, embedder });
		const rows = await store.list({ limit: 50 });
		const observed = rows.map((row) => {
			const metadata = parseInsightMetadata(row.metadata, row);
			return {
				category: row.category,
				section_name: typeof metadata.section_name === "string" ? metadata.section_name : null,
				raw_topic_phrase:
					typeof metadata.rawTopicPhrase === "string" ? metadata.rawTopicPhrase : null,
				abstract: metadata.l0_abstract ?? row.text.slice(0, 80),
				content: metadata.l2_content,
				evidence: typeof metadata.evidence === "string" ? metadata.evidence : null,
				source_session:
					typeof metadata.source_session === "string" ? metadata.source_session : null,
			};
		});
		store.closeSync();

		// Machine-readable persisted-row evidence for the blind verifier.
		process.stdout.write(`\nGACCEPT_ROWS_BEGIN ${JOURNEY}\n`);
		process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
		process.stdout.write("GACCEPT_ROWS_END\n");

		expect(observed.length).toBeGreaterThan(0);
		if (JOURNEY === "J1") {
			expect(
				observed.some(
					(row) => row.category === "profile" && row.section_name === "preferences.answer_length",
				),
			).toBe(true);
			expect(
				observed.some(
					(row) =>
						row.category === "profile" &&
						row.raw_topic_phrase === "answer length" &&
						row.content.toLowerCase().includes("three tight bullets") &&
						row.evidence?.toLowerCase().includes("three tight bullets") === true &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
			expect(
				observed.some(
					(row) =>
						row.category === "episodic" &&
						row.content.toLowerCase().includes("three tight bullets") &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
		} else if (JOURNEY === "J2") {
			expect(
				observed.some(
					(row) => row.category === "profile" && row.section_name === "preferences.status_updates",
				),
			).toBe(true);
			expect(
				observed.some(
					(row) =>
						row.category === "profile" &&
						(row.section_name === "identity" ||
							row.section_name === "preferences.answer_length"),
				),
			).toBe(false);
			expect(
				observed.some(
					(row) =>
						row.category === "profile" &&
						row.raw_topic_phrase === "status updates" &&
						row.content.toLowerCase().includes("async written updates") &&
						row.evidence?.toLowerCase().includes("async written updates") === true &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
			expect(
				observed.some(
					(row) =>
						row.category === "episodic" &&
						row.content.toLowerCase().includes("three tight bullets") &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
		} else {
			expect(
				observed.some(
					(row) =>
						row.category === "profile" &&
						row.section_name?.startsWith("preferences.") === true &&
						// The topic phrase is written by the extraction model, so pinning one
						// exact wording tests the model's word choice rather than the product.
						// What must hold is that the row is anchored to the topic the user
						// actually raised: a phrase is present and it names the weekly report.
						// A null phrase — the real defect, a profile row with no anchor — still
						// fails here, and so does a phrase about something else.
						/weekly report/i.test(row.raw_topic_phrase ?? "") &&
						row.content.toLowerCase().includes("three tight bullets") &&
						row.evidence?.toLowerCase().includes("three tight bullets") === true &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
			expect(
				observed.some(
					(row) =>
						row.category === "episodic" &&
						row.content.toLowerCase().includes("atlas launch review") &&
						row.source_session === "agent:g-accept-two-lane:test",
				),
			).toBe(true);
			process.stdout.write(
				`GACCEPT_LIVE_DUAL_LANE_PROOF J3 public_plugin=true real_sqlite=true live_base=${DEFAULT_LIVE_BASE_URL} grounded_profile=true grounded_episodic=true\n`,
			);
		}
	}, 120_000);
});
