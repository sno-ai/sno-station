import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseReplayJsonl,
	projectHtml,
	projectRichText,
	redactForStorage,
	sanitizeAndChunkContent,
	sanitizeContentIngress,
	sanitizePlainText,
	sanitizeStructuredJsonForStorage,
	sanitizeTranscript,
	validateExtractedContentForStorage,
} from "../src/index";

const OPENAI_KEY = ["sk-proj-", "abc123def456ghi789jkl012mno345pqr678"].join("");
const STRIPE_KEY = ["sk_live_", "1234567890abcdefghijklmnop"].join("");
const GITHUB_TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const JWT = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0In0", "c2lnbmF0dXJl"].join(".");
const PRIVATE_TEXT = "passport number is P-123456";
const QUOTED_SECRET = "correct horse battery staple";
const UNQUOTED_SECRET = "singleTokenSecret12345";
const ALT_UNQUOTED_SECRET = "secondTokenSecret67890";
const CROSSING_SECRET = `sk-proj-${"z".repeat(80)}`;
const BEARER_HEADER_SECRET = "headerBearerSecret12345";
const SHORT_JSON_SECRET = "tiny";
const PRIVATE_KEY_BODY = "private-key-body-secret";
const LONG_QUOTED_SECRET = "quoted-boundary-secret";
const MAX_TEST_TEXT_CHARS = 512 * 1024;

function asJson(value: unknown): string {
	return JSON.stringify(value);
}

function expectNoRawUnsafe(value: unknown): void {
	const json = asJson(value);
	for (const raw of [
		OPENAI_KEY,
		STRIPE_KEY,
		GITHUB_TOKEN,
		JWT,
		PRIVATE_TEXT,
		QUOTED_SECRET,
		UNQUOTED_SECRET,
		ALT_UNQUOTED_SECRET,
		CROSSING_SECRET,
		BEARER_HEADER_SECRET,
		PRIVATE_KEY_BODY,
		LONG_QUOTED_SECRET,
	]) {
		expect(json).not.toContain(raw);
	}
}

function expectBoundedDiagnostics(value: {
	warnings?: unknown[];
	redactions?: unknown[];
	provenance?: unknown;
}): void {
	expect(value.warnings?.length ?? 0).toBeLessThanOrEqual(20);
	expect(value.redactions?.length ?? 0).toBeLessThanOrEqual(50);
	expect(asJson(value.provenance).length).toBeLessThan(4096);
}

describe("@snoai/content-sanitizer public package contract", () => {
	it("exports content-generic public APIs and public package metadata", async () => {
		const exports = await import("../src/index");
		expect(Object.keys(exports).sort()).toEqual(
			expect.arrayContaining([
				"parseReplayJsonl",
				"projectHtml",
				"projectRichText",
				"redactForStorage",
				"sanitizeAndChunkContent",
				"sanitizeContentIngress",
				"sanitizePlainText",
				"sanitizeStructuredJsonForStorage",
				"sanitizeTranscript",
				"validateExtractedContentForStorage",
			]),
		);
		expect(Object.keys(exports).some((name) => /memory/i.test(name))).toBe(false);

		const manifest = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
		) as {
			name?: string;
			main?: string;
			types?: string;
			exports?: Record<string, unknown>;
			files?: string[];
			license?: string;
			publishConfig?: { access?: string };
			dependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		expect(manifest.name).toBe("@snoai/content-sanitizer");
		expect(manifest.main).toBe("./dist/index.js");
		expect(manifest.types).toBe("./dist/index.d.ts");
		expect(manifest.exports).toEqual({
			".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
		});
		expect(manifest.files).toEqual(["dist", "README.md", "LICENSE", "package.json"]);
		expect(manifest.license).toBe("Apache-2.0");
		expect(manifest.publishConfig?.access).toBe("public");
		expect(manifest.dependencies?.["@snoai/chunking"]).toBeDefined();
		expect(manifest.scripts?.prepack).toBe("npm run build");
	});

	it("validates malformed public inputs without leaking unsafe payloads", () => {
		expect(() =>
			sanitizeContentIngress({
				mode: "preview" as never,
				source: "document",
				content: `unsafe ${OPENAI_KEY}`,
			}),
		).toThrow(/storage-safe|mode/i);

		const malformedReplay = parseReplayJsonl(
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "keep this fact" } }),
				`{"type":"message","message":{"role":"assistant","content":"bad ${OPENAI_KEY}"`,
				JSON.stringify({ type: "thinking", content: `hidden ${STRIPE_KEY}` }),
			].join("\n"),
			{ source: "claude-jsonl" },
		);
		expect(malformedReplay.transcriptText).toContain("keep this fact");
		expect(malformedReplay.warnings.length).toBeGreaterThan(0);
		expectNoRawUnsafe(malformedReplay);
		expectBoundedDiagnostics(malformedReplay);
	});

	it("produces a key-order-independent stable input hash", () => {
		const first = sanitizeContentIngress({
			source: "document",
			content: { a: "one", b: ["two", { c: "three" }] },
		});
		const second = sanitizeContentIngress({
			source: "document",
			content: { b: ["two", { c: "three" }], a: "one" },
		});
		expect(first.stableInputHash).toBe(second.stableInputHash);
		expect(first.rawInputHash).toBe(second.rawInputHash);
	});

	it("separates storage-safe content hashing from raw input identity hashing", () => {
		const first = sanitizeContentIngress({
			source: "document",
			declaredContentType: "plain_text",
			content: `token=${UNQUOTED_SECRET}\nKeep project Lyra launch window.`,
		});
		const second = sanitizeContentIngress({
			source: "document",
			declaredContentType: "plain_text",
			content: `token=${ALT_UNQUOTED_SECRET}\nKeep project Lyra launch window.`,
		});
		expect(first.projections.plainText).toBe(second.projections.plainText);
		expect(first.stableInputHash).toBe(second.stableInputHash);
		expect(first.rawInputHash).not.toBe(second.rawInputHash);
		expectNoRawUnsafe(first);
		expectNoRawUnsafe(second);
	});

	it("preserves structured JSON keys while sanitizing string values for storage", () => {
		const result = sanitizeStructuredJsonForStorage({
			idempotency_key: "extract-session-42",
			mappedKind: "user-model",
			invalidated_at: 1_700_000_000_000,
			nested: {
				keep: "Project Lyra launch window is Friday.",
				api_key: OPENAI_KEY,
				note: `Bearer ${JWT}`,
			},
		});

		expect(JSON.parse(result.text)).toEqual({
			idempotency_key: "extract-session-42",
			mappedKind: "user-model",
			invalidated_at: 1_700_000_000_000,
			nested: {
				keep: "Project Lyra launch window is Friday.",
				api_key: "[REDACTED_SECRET]",
				note: "Bearer [REDACTED_SECRET]",
			},
		});
		expect(result.redactions.length).toBeGreaterThan(0);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});
});

describe("redaction and projection", () => {
	it("redacts storage secrets in text, warnings, provenance, and redaction events", () => {
		const result = redactForStorage(
			[
				`Authorization: Bearer ${JWT}`,
				`Authorization: Bearer ${BEARER_HEADER_SECRET}`,
				`OPENAI_API_KEY=${OPENAI_KEY}`,
				`stripe=${STRIPE_KEY}`,
				`repo token ${GITHUB_TOKEN}`,
				`password: "${QUOTED_SECRET}"`,
				`token=${UNQUOTED_SECRET}`,
				`<private>${PRIVATE_TEXT}</private>`,
				"Keep project Phoenix deadline on Friday.",
			].join("\n"),
		);
		expect(result.text).toContain("[REDACTED_SECRET]");
		expect(result.text).toContain("[REDACTED_PRIVATE]");
		expect(result.text).toContain("Keep project Phoenix deadline on Friday.");
		expect(result.text).not.toContain("horse battery staple");
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("redacts private blocks through end-of-input when the closing tag is missing", () => {
		const result = redactForStorage(`<private data-kind="note">${PRIVATE_TEXT}`);
		expect(result.text).toBe("[REDACTED_PRIVATE]");
		expect(result.redactions.some((event) => event.class === "private-block")).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("redacts URL credentials without treating prose email-like text as credentials", () => {
		const result = redactForStorage(
			"Contact foo:bar@example in prose. Fetch https://user:pass@example.test/db or admin:hunter2@db.internal:6379 next.",
		);
		expect(result.text).toContain("foo:bar@example");
		expect(result.text).toContain("https://[REDACTED_SECRET]@example.test/db");
		expect(result.text).toContain("[REDACTED_SECRET]@db.internal:6379");
		expect(result.text).not.toContain("admin:hunter2");
		expect(result.redactions.some((event) => event.class === "url-credentials")).toBe(true);
		expect(result.redactions.some((event) => event.class === "url-credentials-bare")).toBe(true);
		expectBoundedDiagnostics(result);
	});

	it("redacts secrets crossing the truncation boundary before cutting text", () => {
		const input = `${"x".repeat(MAX_TEST_TEXT_CHARS - 33)} ${CROSSING_SECRET} trailing`;
		const result = sanitizePlainText(input, { source: "document", contentType: "log" });
		expect(result.text).toContain("[REDACTED_SECRET]");
		expect(result.text).not.toContain("sk-proj-");
		expect(result.text).not.toContain("zzzzzzzz");
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("redacts unterminated private key blocks at the truncation boundary", () => {
		const input = [
			"x".repeat(MAX_TEST_TEXT_CHARS - 80),
			["-----BEGIN ", "PRIVATE KEY-----\n"].join(""),
			PRIVATE_KEY_BODY.repeat(512),
			["\n-----END ", "PRIVATE KEY-----"].join(""),
		].join("");
		const result = sanitizePlainText(input, { source: "document", contentType: "log" });
		expect(result.text).toContain("[REDACTED_SECRET]");
		expect(result.text).not.toContain("-----BEGIN PRIVATE KEY-----");
		expect(result.text).not.toContain(PRIVATE_KEY_BODY);
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("redacts unterminated quoted key-value secrets at the truncation boundary", () => {
		const input = [
			"x".repeat(MAX_TEST_TEXT_CHARS - 80),
			` password="${LONG_QUOTED_SECRET.repeat(512)}`,
		].join("");
		const result = sanitizePlainText(input, { source: "document", contentType: "log" });
		expect(result.text).toContain("[REDACTED_SECRET]");
		expect(result.text).not.toContain(LONG_QUOTED_SECRET);
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("caps oversized text before redaction scans while preserving the public text limit", () => {
		const input = `${"x".repeat(MAX_TEST_TEXT_CHARS + 8192)} ${CROSSING_SECRET}`;
		const result = sanitizePlainText(input, { source: "document", contentType: "log" });
		expect(result.text.length).toBeLessThanOrEqual(MAX_TEST_TEXT_CHARS);
		expect(result.text).not.toContain("sk-proj-");
		expect(result.text).not.toContain("zzzzzzzz");
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("reports truncation provenance for projected public content types", () => {
		const longText = "audit ".repeat(Math.ceil((MAX_TEST_TEXT_CHARS + 128) / 6));
		const html = sanitizeContentIngress({
			source: "document",
			declaredContentType: "html",
			content: `<article><p>${longText}</p></article>`,
		});
		expect(html.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(html.provenance.truncated).toBe(true);

		const structured = sanitizeContentIngress({
			source: "document",
			declaredContentType: "structured_json",
			content: { content: longText, project: "Truncation audit" },
		});
		expect(structured.warnings.some((warning) => warning.code === "content_truncated")).toBe(
			true,
		);
		expect(structured.provenance.truncated).toBe(true);

		const transcript = sanitizeContentIngress({
			source: "generic-chat",
			declaredContentType: "chat_messages",
			content: [{ role: "user", content: longText }],
		});
		expect(transcript.warnings.some((warning) => warning.code === "content_truncated")).toBe(
			true,
		);
		expect(transcript.provenance.truncated).toBe(true);

		const directTranscript = sanitizeTranscript({
			source: "generic-chat",
			messages: [{ role: "user", content: longText }],
		});
		expect(directTranscript.warnings.some((warning) => warning.code === "content_truncated")).toBe(
			true,
		);
		expect(directTranscript.provenance.truncated).toBe(true);
	});

	it("redacts JSON-looking quoted key-value secrets across text paths", () => {
		const jsonText = JSON.stringify({
			password: QUOTED_SECRET,
			api_key: UNQUOTED_SECRET,
			keep: "Project Nebula rollout is Friday.",
		});
		const direct = sanitizePlainText(jsonText, { source: "document", contentType: "plain_text" });
		expect(direct.text).toContain("[REDACTED_SECRET]");
		expect(direct.text).toContain("Project Nebula rollout is Friday.");
		expectNoRawUnsafe(direct);
		expectBoundedDiagnostics(direct);

		for (const contentType of ["plain_text", "markdown", "log", "email_text", "document_text"] as const) {
			const result = sanitizeContentIngress({
				source: "document",
				declaredContentType: contentType,
				content: jsonText,
			});
			expect(result.projections.plainText).toContain("[REDACTED_SECRET]");
			expect(result.projections.plainText).toContain("Project Nebula rollout is Friday.");
			expectNoRawUnsafe(result);
			expectBoundedDiagnostics(result);
		}
	});

	it("projects HTML and email into readable safe text and markdown", () => {
		const html = [
			"<html><head><style>.x{}</style><script>steal()</script></head>",
			"<body>",
			"<h1>Quarterly plan</h1>",
			`<p>API key: ${OPENAI_KEY}</p>`,
			'<a href="javascript:alert(1)">bad link</a>',
		`<a href="https://example.com/docs?token=${"abc" + "123xyz789"}">safe docs</a>`,
			"<blockquote>Quoted email context should stay readable.</blockquote>",
			`<private>${PRIVATE_TEXT}</private>`,
			"<main><section><article><p>Semantic section fact should stay readable.</p></article></section></main>",
			"<editor-block><p>Custom editor wrapper fact should stay readable.</p></editor-block>",
			"</body></html>",
		].join("");
		const result = projectHtml(html, { source: "document", contentType: "email_html" });
		expect(result.plainText).toContain("Quarterly plan");
		expect(result.plainText).toContain("Quoted email context should stay readable.");
		expect(result.plainText).toContain("Semantic section fact should stay readable.");
		expect(result.plainText).toContain("Custom editor wrapper fact should stay readable.");
		expect(result.plainText).toContain("[REDACTED_PRIVATE]");
		expect(result.plainText).not.toContain(PRIVATE_TEXT);
		expect(result.markdownText).toContain("safe docs");
		expect(result.plainText).not.toContain("steal()");
		expect(result.markdownText).not.toContain("javascript:");
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);

		const ingressEmailHtml = sanitizeContentIngress({
			source: "document",
			declaredContentType: "email_html",
			content: html,
		});
		expect(ingressEmailHtml.detectedContentType).toBe("email_html");
		expect(ingressEmailHtml.projections.plainText).toContain("Quarterly plan");
		expect(ingressEmailHtml.projections.markdownText).toContain("safe docs");
		expect(ingressEmailHtml.projections.plainText).toContain("[REDACTED_PRIVATE]");
		expectNoRawUnsafe(ingressEmailHtml);
		expectBoundedDiagnostics(ingressEmailHtml);
	});

	it("projects rich text, structured JSON, code, logs, Markdown, and CJK without flattening useful structure", () => {
		const rich = projectRichText({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "保留中文内容和 project Sakura." }] },
				{ type: "codeBlock", content: [{ type: "text", text: `const key = "${STRIPE_KEY}";` }] },
			],
		});
		expect(rich.plainText).toContain("保留中文内容");
		expect(rich.plainText).toContain("project Sakura");
		expect(rich.plainText).toContain("const key");
		expect(rich.plainText).toContain("\n");
		expectNoRawUnsafe(rich);

		const structured = sanitizeContentIngress({
			source: "document",
			declaredContentType: "structured_json",
			content: {
				project: "Sakura",
				password: STRIPE_KEY,
				notes: ["上线窗口是星期五", "```ts\nconsole.log('keep line structure')\n```"],
			},
		});
		expect(structured.projections.vectorText).toContain("Sakura");
		expect(structured.projections.vectorText).toContain("上线窗口是星期五");
		expect(structured.projections.vectorText).toContain("console.log");
		expectNoRawUnsafe(structured);
		expectBoundedDiagnostics(structured);

		const markdown = sanitizePlainText(
			[
				"# Deployment log",
				"```",
				`TOKEN=${OPENAI_KEY}`,
				"Error: keep stack trace line",
				"```",
			].join("\n"),
			{ source: "document", contentType: "markdown" },
		);
		expect(markdown.text).toContain("Deployment log");
		expect(markdown.text).toContain("Error: keep stack trace line");
		expect(markdown.text).toContain("\n");
		expectNoRawUnsafe(markdown);
	});

	it("auto-detects common content families and preserves paragraph boundaries for chunk handoff", () => {
		const html = sanitizeContentIngress({
			source: "document",
			content: [
				"<article>",
				"<h1>Detected HTML fact</h1>",
				`<script>leak('${OPENAI_KEY}')</script>`,
				"<p>Project HTML branch stays readable.</p>",
				"</article>",
			].join(""),
		});
		expect(html.detectedContentType).toBe("html");
		expect(html.projections.plainText).toContain("Detected HTML fact");
		expect(html.projections.plainText).toContain("Project HTML branch stays readable.");
		expect(html.projections.plainText).not.toContain("leak");
		expectNoRawUnsafe(html);

		const rich = sanitizeContentIngress({
			source: "document",
			content: {
				type: "doc",
				content: [{ type: "paragraph", content: [{ type: "text", text: "Rich text fact stays." }] }],
			},
		});
		expect(rich.detectedContentType).toBe("rich_text_json");
		expect(rich.projections.plainText).toContain("Rich text fact stays.");

		const markdown = sanitizeContentIngress({
			source: "document",
			content: ["# Release notes", "", "Keep project Lyra Friday.", "", "- Preserve list item."].join(
				"\n",
			),
		});
		expect(markdown.detectedContentType).toBe("markdown");
		expect(markdown.chunkingHandoff.text).toContain("\n\n");

		const code = sanitizeContentIngress({
			source: "document",
			content: [
				"export function keepFact(): string {",
				'  const project = "Orion";',
				"  return project;",
				"}",
			].join("\n"),
		});
		expect(code.detectedContentType).toBe("code");
		expect(code.chunkingHandoff.text).toContain('const project = "Orion";');

		const log = sanitizeContentIngress({
			source: "document",
			content: [
				"2026-06-27T10:00:00Z INFO Project Phoenix started",
				"2026-06-27T10:00:01Z ERROR token=singleTokenSecret12345",
			].join("\n"),
		});
		expect(log.detectedContentType).toBe("log");
		expect(log.chunkingHandoff.text).toContain("Project Phoenix started");
		expectNoRawUnsafe(log);

		const email = sanitizeContentIngress({
			source: "document",
			content: [
				"From: ops@example.test",
				"To: team@example.test",
				"Subject: Launch window",
				"",
				"Project Atlas ships Friday.",
			].join("\n"),
		});
		expect(email.detectedContentType).toBe("email_text");
		expect(email.chunkingHandoff.text).toContain("Project Atlas ships Friday.");

		const documentText = sanitizeContentIngress({
			source: "document",
			content: [
				"First paragraph keeps the project Mercury fact for retrieval.",
				"",
				"Second paragraph keeps the rollout date, owner, and constraints intact for downstream chunking.",
				"",
				"Third paragraph adds enough durable prose to be treated as a document while keeping paragraph boundaries visible.",
			].join("\n"),
		});
		expect(documentText.detectedContentType).toBe("document_text");
		expect(documentText.chunkingHandoff.text).toContain("\n\n");
	});

	it("removes cyclic rich text nodes without dropping visible text", () => {
		const cyclicRichText: { type: string; content: unknown[] } = {
			type: "doc",
			content: [{ type: "text", text: "Keep rich text cycle fact." }],
		};
		cyclicRichText.content.push(cyclicRichText);
		const result = projectRichText(cyclicRichText);
		expect(result.plainText).toContain("Keep rich text cycle fact.");
		expect(result.warnings.some((warning) => warning.code === "rich_text_cycle_removed")).toBe(
			true,
		);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});
});

describe("transcript and replay sanitization", () => {
	it("preserves visible conversation order while removing hidden/control content", () => {
		const result = sanitizeTranscript({
			source: "generic-chat",
			messages: [
				{ role: "system", content: `system hidden ${OPENAI_KEY}` },
				{ role: "user", content: "Remember project Orion uses Postgres." },
				{ role: "assistant", thinking: `secret thought ${STRIPE_KEY}`, content: "Noted." },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will keep the visible plan." },
						{ type: "thinking", text: "hidden typed part should not persist" },
						{ type: "reasoning", text: `hidden reasoning ${OPENAI_KEY}` },
						{ type: "image", source: { media_type: "image/png" } },
					],
				},
				{ role: "tool", name: "lookup", content: `tool result with ${GITHUB_TOKEN}` },
				{ role: "developer", content: `developer control ${JWT}` },
			],
		});
		expect(result.transcriptText).toContain("User: Remember project Orion uses Postgres.");
		expect(result.transcriptText).toContain("Assistant: Noted.");
		expect(result.transcriptText).toContain("[unsupported image part]");
		expect(result.transcriptText).toContain("Tool lookup:");
		expect(result.transcriptText).not.toContain("system hidden");
		expect(result.transcriptText).not.toContain("secret thought");
		expect(result.transcriptText).not.toContain("hidden typed part");
		expect(result.transcriptText).not.toContain("hidden reasoning");
		expect(result.transcriptText).not.toContain("developer control");
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("parses JSONL replay with same-role merge, malformed lines, and output-only field removal", () => {
		const result = parseReplayJsonl(
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "First visible fact." } }),
				JSON.stringify({ type: "message", message: { role: "user", content: "Second visible fact." } }),
				JSON.stringify({
					type: "assistant",
					role: "assistant",
					content: "Visible assistant answer.",
					output: `raw output ${OPENAI_KEY}`,
					reasoning: `hidden ${STRIPE_KEY}`,
				}),
				JSON.stringify({ type: "tool_result", name: "search", content: "Visible tool result." }),
				`{"type":"tool_result","content":"malformed ${GITHUB_TOKEN}"`,
			].join("\n"),
			{ source: "codex-jsonl" },
		);
		expect(result.transcriptText).toContain("User: First visible fact.\nSecond visible fact.");
		expect(result.transcriptText).toContain("Assistant: Visible assistant answer.");
		expect(result.transcriptText).toContain("Tool search: Visible tool result.");
		expect(result.warnings.some((warning) => warning.code === "malformed_jsonl_line")).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("caps rendered transcripts across many visible messages", () => {
		const messages = Array.from({ length: 700 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `turn ${index} ${"x".repeat(1000)}`,
		}));
		const result = sanitizeTranscript({ source: "generic-chat", messages });
		expect(result.transcriptText.length).toBeLessThanOrEqual(MAX_TEST_TEXT_CHARS);
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectBoundedDiagnostics(result);
	});

	it("caps JSONL replay parsing without retaining records beyond the rendered transcript limit", () => {
		const replay = [
			...Array.from({ length: 700 }, (_, index) =>
				JSON.stringify({
					type: "message",
					message: { role: "user", content: `jsonl turn ${index} ${"x".repeat(1000)}` },
				}),
			),
			JSON.stringify({ type: "thinking", content: `hidden tail ${OPENAI_KEY}` }),
		].join("\n");
		const result = parseReplayJsonl(replay, { source: "codex-jsonl" });
		expect(result.transcriptText.length).toBeLessThanOrEqual(MAX_TEST_TEXT_CHARS);
		expect(result.warnings.some((warning) => warning.code === "content_truncated")).toBe(true);
		expect(result.provenance.truncated).toBe(true);
		expectNoRawUnsafe(result);
		expectBoundedDiagnostics(result);
	});

	it("keeps tool-result atomic span offsets aligned with chunking handoff text", () => {
		const direct = sanitizeContentIngress({
			source: "generic-chat",
			declaredContentType: "chat_messages",
			content: [
				{ role: "assistant", content: "Calling lookup." },
				{ role: "tool", name: "lookup", content: "Tool result should stay atomic." },
			],
		});
		const directSpan = direct.chunkingHandoff.atomicSpans[0];
		expect(directSpan).toBeDefined();
		if (directSpan) {
			expect(direct.chunkingHandoff.text.slice(directSpan.startOffset, directSpan.endOffset)).toBe(
				"Tool lookup: Tool result should stay atomic.",
			);
		}

		const replay = sanitizeContentIngress({
			source: "codex-jsonl",
			content: JSON.stringify({
				type: "tool_result",
				name: "search",
				content: "Replay tool result should stay atomic.",
			}),
		});
		const replaySpan = replay.chunkingHandoff.atomicSpans[0];
		expect(replaySpan).toBeDefined();
		if (replaySpan) {
			expect(replay.chunkingHandoff.text.slice(replaySpan.startOffset, replaySpan.endOffset)).toBe(
				"Tool search: Replay tool result should stay atomic.",
			);
		}
	});
});

describe("chunk handoff and post-extraction validation", () => {
	it("delegates splitting to @snoai/chunking with explicit conversation 4096 profile", () => {
		const longConversation = Array.from(
			{ length: 900 },
			(_, index) =>
				`user: project Atlas decision ${index} must be preserved. assistant: acknowledged ${index}.`,
		).join("\n");
		const result = sanitizeAndChunkContent({
			source: "generic-chat",
			declaredContentType: "chat_messages",
			content: `${longConversation}\nsecret ${STRIPE_KEY}`,
		});
		expect(result.sanitized.chunkingHandoff.contentType).toBe("conversation");
		expect(result.chunks.length).toBeGreaterThan(0);
		expect(result.chunks.every((chunk) => chunk.contentType === "conversation")).toBe(true);
		expect(result.chunks.every((chunk) => chunk.tokenCount <= 4096)).toBe(true);
		expect(result.chunks[0]?.chunkText).toContain("project Atlas decision 0");
		expect(result.chunks.at(-1)?.chunkText).toContain("acknowledged 899");
		expectNoRawUnsafe(result);
	});

	it("chunks short atomic tool spans when they fit inside one chunk", () => {
		const result = sanitizeAndChunkContent({
			source: "generic-chat",
			declaredContentType: "chat_messages",
			content: [
				{ role: "assistant", content: "Calling tool." },
				{ role: "tool", name: "lookup", content: "Tool result must stay attached." },
			],
		});

		expect(result.chunks.length).toBe(1);
		expect(result.chunks[0]?.chunkText).toContain("Tool lookup: Tool result must stay attached.");
	});

	it("keeps an oversized atomic tool span whole in one flagged chunk instead of splitting it", () => {
		// `@snoai/chunking` >=1.0.0 fixed the oversized-turn guarantee (D4): a
		// turn that alone exceeds the token budget is emitted as ONE chunk
		// flagged "oversized" and is never force-split mid-turn. For an atomic
		// tool-call/tool-result span this is strictly better than the pre-1.0.0
		// behavior this test used to assert (force-split into <=maxTokens
		// pieces with a bounded "atomic_span_split" warning): the span now
		// never gets split at all, so REQ-9 (never silently split an atomic
		// span) holds with no warning needed.
		const result = sanitizeAndChunkContent({
			source: "generic-chat",
			declaredContentType: "chat_messages",
			content: [
				{ role: "assistant", content: "Calling tool." },
				{ role: "tool", name: "lookup", content: `Tool result ${"must stay attached. ".repeat(6000)}` },
			],
		});

		expect(result.chunks.length).toBe(2);
		const oversizedChunk = result.chunks[1];
		expect(oversizedChunk?.flags).toEqual(["oversized"]);
		expect(oversizedChunk?.tokenCount).toBeGreaterThan(4096);
		expect(oversizedChunk?.chunkText).toContain("Tool lookup: Tool result must stay attached.");
		// Nothing was split, so no atomic_span_split warning fires.
		expect(result.sanitized.warnings.some((warning) => warning.code === "atomic_span_split")).toBe(
			false,
		);
	});

	it("redacts model-derived candidates before storage and rejects empty sanitized output", () => {
		const accepted = validateExtractedContentForStorage({
			category: "episodic",
			abstract: `Phoenix API key ${OPENAI_KEY}`,
			overview: "- Keep the Phoenix migration decision.",
			content: `The Phoenix migration uses ${STRIPE_KEY} and should still preserve useful facts.`,
			sectionName: `<private>${PRIVATE_TEXT}</private>`,
			sourceUrl: `https://example.com/docs?token=${GITHUB_TOKEN}`,
			password: QUOTED_SECRET,
			metadata: {
				notes: `model side note leaked ${JWT}`,
				labels: ["keep deployment-window", `fallback ${OPENAI_KEY}`],
			},
		});
		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(accepted.value.abstract).toContain("[REDACTED_SECRET]");
			expect(accepted.value.content).toContain("Phoenix migration");
			expect(accepted.value.sourceUrl).toContain("[REDACTED_SECRET]");
			expect(accepted.value.password).toBe("[REDACTED_SECRET]");
			expect(accepted.value.metadata.notes).toContain("[REDACTED_SECRET]");
			expect(accepted.value.metadata.labels).toContain("keep deployment-window");
		}
		expectNoRawUnsafe(accepted);
		expectBoundedDiagnostics(accepted);

			const jsonStringAccepted = validateExtractedContentForStorage({
				category: "episodic",
				content: JSON.stringify({
				password: SHORT_JSON_SECRET,
				keep: "Keep the Phoenix migration JSON-string fact.",
			}),
		});
		expect(jsonStringAccepted.ok).toBe(true);
		if (jsonStringAccepted.ok) {
			expect(jsonStringAccepted.value.content).toContain("[REDACTED_SECRET]");
			expect(jsonStringAccepted.value.content).toContain("Keep the Phoenix migration");
			expect(jsonStringAccepted.value.content).not.toContain(SHORT_JSON_SECRET);
		}
			expect(JSON.stringify(jsonStringAccepted)).not.toContain(SHORT_JSON_SECRET);
			expectBoundedDiagnostics(jsonStringAccepted);

			const secretKeyAccepted = validateExtractedContentForStorage({
				category: "episodic",
				content: "Keep the secret key-name validation fact.",
				metadata: {
					[`api_key_${OPENAI_KEY}`]: "field value should be redacted because the key names a secret",
					[`${OPENAI_KEY}_fact`]: "Keep useful value behind a sanitized unsafe key.",
				},
			});
			expect(secretKeyAccepted.ok).toBe(true);
			if (secretKeyAccepted.ok) {
				const stored = JSON.stringify(secretKeyAccepted.value);
				expect(stored).toContain("[REDACTED_SECRET]");
				expect(stored).toContain("Keep useful value behind a sanitized unsafe key.");
				expect(stored).not.toContain(OPENAI_KEY);
			}
			expectNoRawUnsafe(secretKeyAccepted);
			expectBoundedDiagnostics(secretKeyAccepted);

			const rejected = validateExtractedContentForStorage({
			category: "episodic",
			abstract: `<private>${PRIVATE_TEXT}</private>`,
			overview: "",
			content: "",
		});
		expect(rejected.ok).toBe(false);
		expectNoRawUnsafe(rejected);
		expectBoundedDiagnostics(rejected);
	});

	it("handles cyclic runtime objects without leaking unsafe fields or crashing", () => {
		const cyclicStructured: Record<string, unknown> = {
			project: "Cycle-safe project",
			password: STRIPE_KEY,
		};
		cyclicStructured.self = cyclicStructured;
		const structured = sanitizeContentIngress({ source: "document", content: cyclicStructured });
		expect(structured.projections.vectorText).toContain("Cycle-safe project");
		expect(structured.warnings.some((warning) => warning.code === "structured_json_cycle_removed")).toBe(
			true,
		);
		expectNoRawUnsafe(structured);
		expectBoundedDiagnostics(structured);

		const cyclicItems: unknown[] = ["keep array fact", STRIPE_KEY];
		cyclicItems.push(cyclicItems);
		const accepted = validateExtractedContentForStorage({
			category: "episodic",
			content: "Keep the cycle validation fact.",
			metadata: { items: cyclicItems },
		});
		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(JSON.stringify(accepted.value)).toContain("keep array fact");
		}
		expect(accepted.warnings.some((warning) => warning.code === "unsupported_candidate_cycle")).toBe(
			true,
		);
		expectNoRawUnsafe(accepted);
		expectBoundedDiagnostics(accepted);

		class SecretPayload {
			toJSON(): Record<string, string> {
				return { apiKey: QUOTED_SECRET };
			}
		}
		const objectAccepted = validateExtractedContentForStorage({
			category: "episodic",
			content: "Keep the runtime object validation fact.",
			metadata: { payload: new SecretPayload() },
		});
		expect(objectAccepted.ok).toBe(true);
		expect(
			objectAccepted.warnings.some((warning) => warning.code === "unsupported_candidate_object"),
		).toBe(true);
		expectNoRawUnsafe(objectAccepted);
		expectBoundedDiagnostics(objectAccepted);

		class UnsupportedContent {
			value = "Keep unsupported content fact.";
		}
		const unsupportedUsefulField = validateExtractedContentForStorage({
			category: "episodic",
			overview: "Keep fallback overview.",
			content: new UnsupportedContent(),
		});
		expect(unsupportedUsefulField.ok).toBe(false);
		expect(unsupportedUsefulField.reason).toBe("unsupported-candidate");
		expect(
			unsupportedUsefulField.warnings.some(
				(warning) => warning.code === "unsupported_candidate_object",
			),
		).toBe(true);
		expectBoundedDiagnostics(unsupportedUsefulField);

		class RootPayload {
			content = "Keep the root object validation fact.";
		}
		const rootRejected = validateExtractedContentForStorage(
			new RootPayload() as unknown as Record<string, unknown>,
		);
		expect(rootRejected.ok).toBe(false);
		expect(rootRejected.reason).toBe("unsupported-candidate");
		expect(rootRejected.warnings.some((warning) => warning.code === "unsupported_candidate")).toBe(
			true,
		);
		expectNoRawUnsafe(rootRejected);
		expectBoundedDiagnostics(rootRejected);
	});
});
