/**
 * Reflection pipeline — integration tests.
 * Real SQLite, real embeddings, real filesystem writes. No mocking.
 * Test generator returns realistic reflection markdown (DI, not a mock).
 */

import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	buildReflectionFallbackText,
	buildReflectionPrompt,
	extractTextContent,
	generateReflectionText,
	type ReflectionGenerator,
	readSessionConversationForReflection,
	readSessionConversationWithResetFallback,
	shouldSkipReflectionMessage,
	writeReflectionToFilesystem,
} from "../../../../packages/memory/src/engine/reflection/daily-log-generator.ts";
import { extractReflectionSlices } from "../../../../packages/memory/src/engine/reflection/markdown-slice-parser.ts";

function requireValue<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) {
		throw new Error(message);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const REALISTIC_REFLECTION = `## Context
- Session focused on migrating mem-claw plugin to use reflection pipeline.

## Decisions (durable)
- Always use dependency injection for LLM calls in plugins.

## User model deltas (about the human)
- Prefers concise code with minimal abstractions.

## Agent model deltas (about the assistant/system)
- Should verify typecheck after each file change.

## Lessons & pitfalls (symptom / cause / fix / prevention)
- Symptom: unused import errors. Cause: adding imports before code that uses them. Fix: add imports and usage in same edit.

## Learning governance candidates (.learnings / promotion / skill extraction)
- LRN candidate: Always run typecheck after editing TypeScript files.

## Open loops / next actions
- Verify reflection storage dedup threshold works for sqlite-vec.

## Retrieval tags / keywords
- reflection, pipeline, migration, mem-claw

## Invariants
- Always run typecheck after editing TypeScript files.
- Never store secrets in reflection text.
- When generating reflections, prefer fallback over crash.
- Avoid storing duplicate reflections with >0.97 similarity.
- Require DI callbacks for all LLM generation in plugins.

## Derived
- This run showed that sqlite-vec cosine distance depends on L2-normalized vectors.
- Next run should verify dedup threshold empirically.
- Re-check that reflection slice extraction handles malformed markdown.
`;

function buildSessionJsonl(
	messages: Array<{ role: string; content: string }>,
): string {
	return messages
		.map((m) =>
			JSON.stringify({
				type: "message",
				message: { role: m.role, content: m.content },
			}),
		)
		.join("\n");
}

const TEST_DIALOG_MESSAGES = [
	{ role: "user", content: "Can you help me refactor the auth module?" },
	{
		role: "assistant",
		content: "Sure, I'll start by reading the current implementation.",
	},
	{ role: "user", content: "Focus on the token refresh logic." },
	{
		role: "assistant",
		content:
			"The token refresh has a race condition. I'll fix it with a mutex.",
	},
	{
		role: "user",
		content: "Good catch. Also add error handling for expired tokens.",
	},
	{
		role: "assistant",
		content:
			"Done. I've added a typed Result return for token refresh failures.",
	},
];

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let testDir: string;
let embedder: ReturnType<typeof createEmbedder>;

beforeAll(async () => {
	testDir = mkdtempSync(join(tmpdir(), "reflection-pipeline-test-"));
	embedder = createEmbedder({ dimensions: 1024 }, testDir);
});

afterAll(async () => {
	try {
		await embedder.dispose();
	} catch {
		// best effort
	}
	await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. extractTextContent
// ---------------------------------------------------------------------------
describe("extractTextContent", () => {
	it("extracts string content directly", () => {
		expect(extractTextContent("hello")).toBe("hello");
	});

	it("extracts from SDK content block array", () => {
		const content = [{ type: "text", text: "block text" }];
		expect(extractTextContent(content)).toBe("block text");
	});

	it("returns null for empty/missing content", () => {
		expect(extractTextContent(null)).toBeNull();
		expect(extractTextContent(undefined)).toBeNull();
		expect(extractTextContent([])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 2. shouldSkipReflectionMessage
// ---------------------------------------------------------------------------
describe("shouldSkipReflectionMessage", () => {
	it("skips slash commands", () => {
		expect(shouldSkipReflectionMessage("user", "/new")).toBe(true);
		expect(shouldSkipReflectionMessage("user", "/reset")).toBe(true);
	});

	it("skips user messages with system tags", () => {
		expect(
			shouldSkipReflectionMessage("user", "<relevant-memories>\nsome data"),
		).toBe(true);
		expect(shouldSkipReflectionMessage("user", "UNTRUSTED DATA\nfoo")).toBe(
			true,
		);
	});

	it("does not skip normal user/assistant messages", () => {
		expect(shouldSkipReflectionMessage("user", "help me refactor")).toBe(false);
		expect(shouldSkipReflectionMessage("assistant", "Sure, I can help.")).toBe(
			false,
		);
	});

	it("skips empty/whitespace-only messages", () => {
		expect(shouldSkipReflectionMessage("user", "")).toBe(true);
		expect(shouldSkipReflectionMessage("user", "   ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. readSessionConversationForReflection
// ---------------------------------------------------------------------------
describe("readSessionConversationForReflection", () => {
	it("reads real dialog from JSONL file", async () => {
		const sessionFile = join(testDir, "session-dialog.jsonl");
		await writeFile(sessionFile, buildSessionJsonl(TEST_DIALOG_MESSAGES));

		const result = await readSessionConversationForReflection(sessionFile, 100);
		expect(result).not.toBeNull();
		expect(result).toContain("user: Can you help me refactor");
		expect(result).toContain("assistant: Sure, I'll start by reading");
	});

	it("returns null for empty session (only system tags)", async () => {
		const sessionFile = join(testDir, "session-empty.jsonl");
		const lines = [
			JSON.stringify({ type: "system", data: "init" }),
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: "<relevant-memories>\nold data\nEND UNTRUSTED DATA",
				},
			}),
		].join("\n");
		await writeFile(sessionFile, lines);

		const result = await readSessionConversationForReflection(sessionFile, 100);
		expect(result).toBeNull();
	});

	it("returns null for slash-command-only session", async () => {
		const sessionFile = join(testDir, "session-slash.jsonl");
		const lines = buildSessionJsonl([
			{ role: "user", content: "/new" },
			{ role: "user", content: "/note something" },
		]);
		await writeFile(sessionFile, lines);

		const result = await readSessionConversationForReflection(sessionFile, 100);
		expect(result).toBeNull();
	});

	it("keeps all readable messages before chunking instead of slicing recent messages", async () => {
		const sessionFile = join(testDir, "session-limit.jsonl");
		await writeFile(sessionFile, buildSessionJsonl(TEST_DIALOG_MESSAGES));

		const result = await readSessionConversationForReflection(sessionFile, 2);
		expect(result).not.toBeNull();
		const lines = requireValue(result, "expected limited conversation")
			.split("\n")
			.filter((l) => l.trim());
		expect(lines.length).toBe(TEST_DIALOG_MESSAGES.length);
		expect(lines[0]).toContain(TEST_DIALOG_MESSAGES[0]?.content);
		expect(lines.at(-1)).toContain(TEST_DIALOG_MESSAGES.at(-1)?.content);
	});

	it("keeps the front of large session files instead of reading only the tail", async () => {
		const sessionFile = join(testDir, "session-large.jsonl");
		await writeFile(
			sessionFile,
			buildSessionJsonl([
				{ role: "user", content: "FRONT-REFLECTION-SESSION-FILE-MARKER" },
				{ role: "assistant", content: "large transcript filler ".repeat(40000) },
				{ role: "user", content: "TAIL-REFLECTION-SESSION-FILE-MARKER" },
			]),
		);

		const result = await readSessionConversationForReflection(sessionFile, 1);

		expect(result).toContain("FRONT-REFLECTION-SESSION-FILE-MARKER");
		expect(result).toContain("TAIL-REFLECTION-SESSION-FILE-MARKER");
	});
});

// ---------------------------------------------------------------------------
// 4. readSessionConversationWithResetFallback
// ---------------------------------------------------------------------------
describe("readSessionConversationWithResetFallback", () => {
	it("falls back to .reset file when primary is empty", async () => {
		const primaryFile = join(testDir, "session-primary.jsonl");
		const resetFile = join(testDir, "session-primary.jsonl.reset.1");
		await writeFile(primaryFile, "");
		await writeFile(resetFile, buildSessionJsonl(TEST_DIALOG_MESSAGES));

		const result = await readSessionConversationWithResetFallback(
			primaryFile,
			100,
		);
		expect(result).not.toBeNull();
		expect(result).toContain("refactor the auth module");
	});
});

// ---------------------------------------------------------------------------
// 5. buildReflectionPrompt
// ---------------------------------------------------------------------------
describe("buildReflectionPrompt", () => {
	it("includes conversation and section headings in output", () => {
		const prompt = buildReflectionPrompt("user: hello\nassistant: hi", 10000);
		expect(prompt).toContain("user: hello");
		expect(prompt).toContain("## Context");
		expect(prompt).toContain("## Invariants");
		expect(prompt).toContain("## Derived");
	});

	it("keeps caller-provided conversation content instead of slicing the tail", () => {
		const longConvo = [
			"user: FRONT-REFLECTION-PROMPT-MARKER",
			"x".repeat(50000),
			"assistant: TAIL-REFLECTION-PROMPT-MARKER",
		].join("\n");
		const prompt = buildReflectionPrompt(longConvo, 1000);
		expect(prompt).toContain("FRONT-REFLECTION-PROMPT-MARKER");
		expect(prompt).toContain("TAIL-REFLECTION-PROMPT-MARKER");
	});

	it("includes error signal hints when provided", () => {
		const prompt = buildReflectionPrompt("user: test", 10000, [
			{
				at: Date.now(),
				toolName: "Bash",
				summary: "command not found: foo",
				source: "tool_error",
				signature: "command not found",
				signatureHash: "abc12345deadbeef",
			},
		]);
		expect(prompt).toContain("[Bash] command not found: foo");
		expect(prompt).toContain("abc12345");
	});
});

// ---------------------------------------------------------------------------
// 6. extractReflectionSlices
// ---------------------------------------------------------------------------
describe("extractReflectionSlices", () => {
	it("extracts invariants and derived from well-formed reflection", () => {
		const slices = extractReflectionSlices(REALISTIC_REFLECTION);
		expect(slices.invariants.length).toBeGreaterThanOrEqual(3);
		expect(slices.derived.length).toBeGreaterThanOrEqual(2);
		// Invariants should be rule-like
		expect(
			slices.invariants.some((i) => /always|never|when|require|avoid/i.test(i)),
		).toBe(true);
		// Derived should be delta-like
		expect(
			slices.derived.some((d) => /this run|next run|re-check/i.test(d)),
		).toBe(true);
	});

	it("enforces max 8 invariants", () => {
		const manyInvariants = [
			"## Invariants",
			...Array.from({ length: 12 }, (_, i) => `- Always do rule ${i + 1}.`),
		].join("\n");
		const slices = extractReflectionSlices(manyInvariants);
		expect(slices.invariants.length).toBeLessThanOrEqual(8);
	});

	it("enforces max 10 derived", () => {
		const manyDerived = [
			"## Derived",
			...Array.from(
				{ length: 15 },
				(_, i) => `- This run showed issue ${i + 1}.`,
			),
		].join("\n");
		const slices = extractReflectionSlices(manyDerived);
		expect(slices.derived.length).toBeLessThanOrEqual(10);
	});

	it("returns empty slices for malformed markdown", () => {
		const slices = extractReflectionSlices("no headings here, just text");
		expect(slices.invariants).toEqual([]);
		expect(slices.derived).toEqual([]);
	});

	it("filters placeholder lines like (none captured)", () => {
		const text = [
			"## Invariants",
			"- (none captured)",
			"- (none)",
			"## Derived",
			"- (none captured)",
		].join("\n");
		const slices = extractReflectionSlices(text);
		expect(slices.invariants).toEqual([]);
		expect(slices.derived).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 7. generateReflectionText — fallback on LLM failure
// ---------------------------------------------------------------------------
describe("generateReflectionText", () => {
	it("uses fallback when generator returns null", async () => {
		const nullGenerator: ReflectionGenerator = async () => null;
		const result = await generateReflectionText({
			conversation: "user: test\nassistant: ok",
			maxInputChars: 10000,
			timeoutMs: 5000,
			generate: nullGenerator,
		});
		expect(result.usedFallback).toBe(true);
		expect(result.text).toContain("(fallback)");
		expect(result.error).toBe("generate returned empty text");
	});

	it("uses fallback when generator throws", async () => {
		const failGenerator: ReflectionGenerator = async () => {
			throw new Error("LLM service unavailable");
		};
		const result = await generateReflectionText({
			conversation: "user: test\nassistant: ok",
			maxInputChars: 10000,
			timeoutMs: 5000,
			generate: failGenerator,
		});
		expect(result.usedFallback).toBe(true);
		expect(result.error).toContain("LLM service unavailable");
	});

	it("returns generated text when generator succeeds", async () => {
		const successGenerator: ReflectionGenerator = async () =>
			REALISTIC_REFLECTION;
		const result = await generateReflectionText({
			conversation: "user: test\nassistant: ok",
			maxInputChars: 10000,
			timeoutMs: 5000,
			generate: successGenerator,
		});
		expect(result.usedFallback).toBe(false);
		expect(result.text).toContain("## Invariants");
		expect(result.promptHash).toBeTruthy();
	});

	it("generates over ordered package chunks instead of a tail-only prompt", async () => {
		const prompts: string[] = [];
		const generator: ReflectionGenerator = async (prompt) => {
			prompts.push(prompt);
			return `## Context
- generated reflection chunk ${prompts.length}

## Decisions (durable)
- (none)

## User model deltas (about the human)
- (none)

## Agent model deltas (about the assistant/system)
- (none)

## Lessons & pitfalls (symptom / cause / fix / prevention)
- (none)

## Learning governance candidates (.learnings / promotion / skill extraction)
- (none)

## Open loops / next actions
- (none)

## Retrieval tags / keywords
- reflection-test

## Invariants
- Always preserve ordered reflection chunk inputs.

## Derived
- This run showed chunked reflection input is active.`;
		};
		const conversation = [
			"user: FRONT-REFLECTION-CHUNK-MARKER.",
			"front filler for package chunking ".repeat(2000),
			"user: MIDDLE-REFLECTION-CHUNK-MARKER.",
			"middle filler for package chunking ".repeat(2000),
			"assistant: TAIL-REFLECTION-CHUNK-MARKER.",
		].join(" ");

		const result = await generateReflectionText({
			conversation,
			maxInputChars: 1200,
			timeoutMs: 5000,
			generate: generator,
		});
		const joinedPrompts = prompts.join("\n");

		expect(result.usedFallback).toBe(false);
		expect(prompts.length).toBeGreaterThan(1);
		expect(joinedPrompts).toContain("FRONT-REFLECTION-CHUNK-MARKER");
		expect(joinedPrompts).toContain("MIDDLE-REFLECTION-CHUNK-MARKER");
		expect(joinedPrompts).toContain("TAIL-REFLECTION-CHUNK-MARKER");
	});
});

// ---------------------------------------------------------------------------
// 8. buildReflectionFallbackText structure
// ---------------------------------------------------------------------------
describe("buildReflectionFallbackText", () => {
	it("produces valid markdown with all required sections", () => {
		const text = buildReflectionFallbackText();
		const requiredSections = [
			"## Context",
			"## Decisions (durable)",
			"## User model deltas",
			"## Agent model deltas",
			"## Lessons & pitfalls",
			"## Learning governance candidates",
			"## Open loops / next actions",
			"## Retrieval tags / keywords",
			"## Invariants",
			"## Derived",
		];
		for (const section of requiredSections) {
			expect(text).toContain(section);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Locale dispatch via the `conversation` argument.
	//
	// Recent fix: the empty-text branch in `generateReflectionText` (and the
	// catch-branch) now passes `params.conversation` to
	// `buildReflectionFallbackText`, so locale resolves from the session
	// conversation rather than DEFAULT_LOCALE. Without the conversation arg,
	// non-English sessions silently fell back to the English marker.
	//
	// The machine contract — section headings stay English so
	// markdown-slice-parser.ts can parse them — must be preserved across every
	// locale's fallback. Translating a heading would silently produce empty
	// slices for that locale and break the v3 layered store + §4.2 mapped-
	// memory loop.
	// ─────────────────────────────────────────────────────────────────────────

	const PARSER_HEADING_LITERALS = [
		"## Context",
		"## Decisions (durable)",
		"## Invariants",
		"## Derived",
	] as const;

	function expectParserHeadingsPreserved(text: string): void {
		for (const heading of PARSER_HEADING_LITERALS) {
			expect(text).toContain(heading);
		}
	}

	it("zh conversation routes to zh fallback marker (locale dispatch)", () => {
		// Long enough to exceed resolver's 8-char short-text bypass and rich in
		// CJK Han characters so detector picks zh.
		const conversation =
			"用户：我们今天要复盘最近一次发布的反思流程。助手：好的，我会按照中文整理 governance 候选条目。";
		const text = buildReflectionFallbackText(conversation);

		expect(text).toContain("(fallback) 反思生成失败");
		// English marker must NOT leak into a zh-routed fallback.
		expect(text).not.toContain("(fallback) Reflection generation failed");
		expectParserHeadingsPreserved(text);
	});

	it("zh-Hant conversation routes to zh-Hant fallback marker (locale dispatch)", () => {
		const conversation =
			"使用者：我們今天要覆盤最近一次發布的反思流程。助理：好的，我會按照繁體中文整理候選條目。";
		const text = buildReflectionFallbackText(conversation);

		expect(text).toContain("(fallback) 反思生成失敗");
		expect(text).not.toContain("(fallback) Reflection generation failed");
		expectParserHeadingsPreserved(text);
	});

	it("French conversation routes to fr fallback marker (Romance-locale dispatch)", () => {
		const conversation = [
			"Utilisateur : Pouvons-nous récapituler la dernière session de réflexion ?",
			"Assistant : Bien sûr, je vais résumer les décisions durables et les leçons apprises.",
			"Utilisateur : Concentrez-vous sur les invariants et les actions à suivre.",
		].join("\n");
		const text = buildReflectionFallbackText(conversation);

		expect(text).toContain("(fallback) Échec de la génération de la réflexion");
		expect(text).not.toContain("(fallback) Reflection generation failed");
		expectParserHeadingsPreserved(text);
	});

	it("empty / English conversation falls back to en marker (default-locale path)", () => {
		const emptyText = buildReflectionFallbackText("");
		expect(emptyText).toContain("(fallback) Reflection generation failed");
		expectParserHeadingsPreserved(emptyText);

		const englishText = buildReflectionFallbackText(
			"User: Let's recap the latest reflection session.\nAssistant: Sure, I'll summarize the durable decisions and lessons learned.",
		);
		expect(englishText).toContain("(fallback) Reflection generation failed");
		expectParserHeadingsPreserved(englishText);
	});
});

// ---------------------------------------------------------------------------
// 9. writeReflectionToFilesystem
// ---------------------------------------------------------------------------
describe("writeReflectionToFilesystem", () => {
	it("writes reflection file and daily log entry", async () => {
		const workDir = join(testDir, "ws-fs-test");
		await mkdir(workDir, { recursive: true });

		const relPath = await writeReflectionToFilesystem({
			workspaceDir: workDir,
			reflectionText: REALISTIC_REFLECTION,
			sessionKey: "agent:main:session-1",
			sessionId: "sess-001",
			agentId: "main",
			command: "new",
			toolErrorSignals: [],
			nowTs: Date.now(),
		});

		// File should exist
		const absPath = join(workDir, relPath);
		expect(existsSync(absPath)).toBe(true);

		// Content should include header and reflection
		const content = await readFile(absPath, "utf-8");
		expect(content).toContain("# Reflection:");
		expect(content).toContain("Session Key: agent:main:session-1");
		expect(content).toContain("## Invariants");

		// Daily log should exist
		const dateStr = new Date().toISOString().split("T")[0] ?? "";
		const dailyLog = join(workDir, "memory", `${dateStr}.md`);
		expect(existsSync(dailyLog)).toBe(true);
		const logContent = await readFile(dailyLog, "utf-8");
		expect(logContent).toContain("Reflection generated:");
	});

	it("handles collision-safe retry with unique filenames", async () => {
		const workDir = join(testDir, "ws-collision-test");
		await mkdir(workDir, { recursive: true });

		const nowTs = Date.now();
		const paths: string[] = [];
		// Write two reflections at the same timestamp
		for (let i = 0; i < 2; i++) {
			const relPath = await writeReflectionToFilesystem({
				workspaceDir: workDir,
				reflectionText: `Reflection ${i}`,
				sessionKey: "test",
				sessionId: "sess-collision",
				agentId: "main",
				command: "new",
				toolErrorSignals: [],
				nowTs,
			});
			paths.push(relPath);
		}

		expect(paths[0]).not.toBe(paths[1]);
		expect(
			existsSync(join(workDir, requireValue(paths[0], "first path"))),
		).toBe(true);
		expect(
			existsSync(join(workDir, requireValue(paths[1], "second path"))),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 10. Full pipeline: generate → extract → store → filesystem
// ---------------------------------------------------------------------------
describe("full reflection pipeline", () => {
	it("end-to-end: session file → generate → store + write FS", async () => {
		const workDir = join(testDir, "ws-pipeline");
		await mkdir(workDir, { recursive: true });

		// Write a session JSONL
		const sessionFile = join(workDir, "session-pipeline.jsonl");
		await writeFile(sessionFile, buildSessionJsonl(TEST_DIALOG_MESSAGES));

		// Read conversation
		const conversation = await readSessionConversationForReflection(
			sessionFile,
			100,
		);
		expect(conversation).not.toBeNull();

		// Generate with test generator
		const testGenerator: ReflectionGenerator = async () => REALISTIC_REFLECTION;
		const genResult = await generateReflectionText({
			conversation: requireValue(
				conversation,
				"expected reflection conversation",
			),
			maxInputChars: 24000,
			timeoutMs: 5000,
			generate: testGenerator,
		});
		expect(genResult.usedFallback).toBe(false);

		// Write to filesystem
		const nowTs = Date.now();
		const relPath = await writeReflectionToFilesystem({
			workspaceDir: workDir,
			reflectionText: genResult.text,
			sessionKey: "agent:main:pipeline-test",
			sessionId: "sess-pipeline",
			agentId: "main",
			command: "new",
			toolErrorSignals: [],
			nowTs,
		});
		expect(existsSync(join(workDir, relPath))).toBe(true);

		// Extract slices
		const slices = extractReflectionSlices(genResult.text);
		expect(slices.invariants.length).toBeGreaterThan(0);
		expect(slices.derived.length).toBeGreaterThan(0);
	});
});
