import { describe, expect, it } from "vitest";
import { chunk } from "../src/chunker";
import { CHUNKING_VERSION } from "../src/chunking-version";
import { classifyContentRoute } from "../src/route-heuristic";
import { countTokens } from "../src/tokenize";

/** Small helper: a paragraph of `n` sentences of repeated filler. */
function paragraph(n: number, lead: string): string {
	const sentence = `${lead} The quick brown fox jumps over the lazy dog repeatedly across the meadow.`;
	return Array.from({ length: n }, () => sentence).join(" ");
}

/** Conversation turn line in PRD-style format. */
function turn(speaker: string, idx: number, body: string): string {
	const ts = `2026-04-28T10:${String(idx).padStart(2, "0")}:00Z`;
	return `[${ts}] ${speaker}: ${body}`;
}

describe("chunk()", () => {
	describe("edge cases", () => {
		it("returns [] for empty string", () => {
			expect(chunk("")).toEqual([]);
		});

		it("returns 1 chunk for short prose under maxTokens", () => {
			const text = "Hello, world. This is a single short paragraph that fits.";
			const result = chunk(text, { contentType: "prose" });
			expect(result).toHaveLength(1);
			const first = result[0];
			expect(first).toBeDefined();
			if (!first) return;
			expect(first.startOffset).toBe(0);
			expect(first.endOffset).toBe(text.length);
			expect(first.chunkText).toBe(text);
			expect(first.chunkIndex).toBe(0);
			expect(first.contentType).toBe("prose");
			expect(first.chunkingVersion).toBe(CHUNKING_VERSION);
			expect(first.tokenCount).toBe(countTokens(text));
		});
	});

	describe("conversation content type", () => {
		it("splits on turn boundaries when total tokens exceed target", () => {
			// 5 long turns. Each turn body is ~600 chars → ~200 tokens.
			// Total ≈ 1000 tokens > maxTokens (448). Boundaries are turn lines.
			const turns = [
				turn("Alice", 0, paragraph(8, "Step zero starts here.")),
				turn("Bob", 1, paragraph(8, "Step one continues now.")),
				turn("Alice", 2, paragraph(8, "Step two arrives soon.")),
				turn("Bob", 3, paragraph(8, "Step three is rolling.")),
				turn("Alice", 4, paragraph(8, "Step four wraps it up.")),
			];
			const text = turns.join("\n");
			const result = chunk(text, { contentType: "conversation" });

			expect(result.length).toBeGreaterThan(1);

			// Each chunk text should start with a turn-line marker (timestamp or speaker).
			for (const c of result) {
				expect(c.chunkText.startsWith("[")).toBe(true);
			}

			// Spans must cover the whole text monotonically.
			expect(result[0]?.startOffset).toBe(0);
			expect(result.at(-1)?.endOffset).toBe(text.length);
		});
	});

	describe("prose content type", () => {
		it("splits on paragraph boundaries; chunks fit token bands", () => {
			// 3 paragraphs, ~1200 tokens total (≈3600 chars).
			const p1 = paragraph(20, "Alpha:");
			const p2 = paragraph(20, "Beta:");
			const p3 = paragraph(20, "Gamma:");
			const text = `${p1}\n\n${p2}\n\n${p3}`;
			const totalTokens = countTokens(text);
			expect(totalTokens).toBeGreaterThan(448);

			const result = chunk(text, { contentType: "prose" });
			expect(result.length).toBeGreaterThan(1);

			// All chunks except possibly the last sit within [minTokens, maxTokens].
			const last = result.length - 1;
			for (let i = 0; i < result.length; i++) {
				const c = result[i];
				expect(c).toBeDefined();
				if (!c) continue;
				expect(c.tokenCount).toBeLessThanOrEqual(448);
				if (i !== last) {
					expect(c.tokenCount).toBeGreaterThanOrEqual(256);
				}
			}

			// First chunk starts at 0; last ends at text.length.
			expect(result[0]?.startOffset).toBe(0);
			expect(result.at(-1)?.endOffset).toBe(text.length);
		});
	});

	describe("code route", () => {
		it("rejects code as an embedded content type and routes raw code to attachment", () => {
			const text = [
				"export function alpha() {}",
				"export const beta = 1;",
				"class Gamma {}",
				"interface Delta {}",
				"type Epsilon = string;",
				"const zeta = true;",
			].join("\n");

			expect(() => chunk(text, { contentType: "code" as never })).toThrow();
			expect(classifyContentRoute({ content: text })).toMatchObject({
				route: "attachment",
				reasons: ["clear-code-shape"],
			});
		});
	});

	describe("determinism", () => {
		it("produces byte-identical output across runs", () => {
			const text = `${paragraph(20, "Alpha:")}\n\n${paragraph(20, "Beta:")}\n\n${paragraph(20, "Gamma:")}`;
			const a = chunk(text, { contentType: "prose" }, "mem-1");
			const b = chunk(text, { contentType: "prose" }, "mem-1");
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		});
	});

	describe("metadata shape", () => {
		it("emits placeholder chunkId/densePayload and threads memoryId", () => {
			const text = paragraph(5, "Solo:");
			const result = chunk(text, { contentType: "prose" }, "mem-xyz");
			const c = result[0];
			expect(c).toBeDefined();
			if (!c) return;
			expect(c.chunkId).toBe("");
			expect(c.densePayload).toBe("");
			expect(c.memoryId).toBe("mem-xyz");
		});
	});

	describe("token-cap adherence", () => {
		it("force-split respects maxTokens on mixed CJK/non-CJK input", () => {
			const text = "あ".repeat(1450) + "y".repeat(3550);
			const chunks = chunk(text);
			for (const c of chunks) {
				expect(c.tokenCount).toBeLessThanOrEqual(448);
			}
		});

		it("respects maxTokens on CJK-heavy input and is deterministic", () => {
			const text = "あ".repeat(2000);
			const a = chunk(text);
			const b = chunk(text);
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
			for (const c of a) {
				expect(c.tokenCount).toBeLessThanOrEqual(448);
			}
		});

		it("respects maxTokens when there is no whitespace in band", () => {
			const text = "x".repeat(3000);
			const chunks = chunk(text);
			expect(chunks.length).toBeGreaterThan(1);
			for (const c of chunks) {
				expect(c.tokenCount).toBeLessThanOrEqual(448);
			}
		});

		it("force-split never cuts an emoji in half", () => {
			// One ASCII char puts every emoji on an odd offset, so the cut lands between
			// the two UTF-16 halves of one unless it steps back.
			const text = `a${"\u{1F600}".repeat(1000)}`;
			const chunks = chunk(text, { contentType: "prose" });
			expect(chunks.length).toBeGreaterThan(1);
			const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
			for (const c of chunks) {
				expect(c.chunkText).not.toMatch(loneSurrogate);
				expect(c.tokenCount).toBeLessThanOrEqual(448);
			}
			expect(chunks.at(-1)?.endOffset).toBe(text.length);
		});

		it("respects maxTokens after paragraph boundaries are exhausted", () => {
			const intro = "a".repeat(900);
			const boundarylessTail = "b".repeat(5000);
			const text = `${intro}\n\n${boundarylessTail}`;
			const chunks = chunk(text, { contentType: "prose" });
			expect(chunks.length).toBeGreaterThan(1);
			for (const c of chunks) {
				expect(c.tokenCount).toBeLessThanOrEqual(448);
			}
			expect(chunks[0]?.startOffset).toBe(0);
			expect(chunks.at(-1)?.endOffset).toBe(text.length);
		});

		it("conversation config 4096/4096 preserves front and tail while respecting maxTokens", () => {
			const front = "front-fact ".repeat(900);
			const middle = "middle-fact ".repeat(900);
			const tail = "tail-fact ".repeat(900);
			const text = `user: ${front}\n\nassistant: ok\n\nuser: ${middle}\n\nassistant: ok\n\nuser: ${tail}`;
			const chunks = chunk(text, {
				contentType: "conversation",
				targetTokens: 4096,
				maxTokens: 4096,
			});
			expect(chunks[0]?.chunkText).toContain("front-fact");
			expect(chunks.at(-1)?.chunkText).toContain("tail-fact");
			expect(chunks.every((c) => c.tokenCount <= 4096)).toBe(true);
			expect(chunks.at(-1)?.endOffset).toBe(text.length);
		});
	});

	describe("overlap correctness", () => {
		it("adjacent chunks overlap (cur.start <= prev.end) and never gap", () => {
			const p1 = paragraph(20, "Alpha:");
			const p2 = paragraph(20, "Beta:");
			const p3 = paragraph(20, "Gamma:");
			const text = `${p1}\n\n${p2}\n\n${p3}`;
			const result = chunk(text, { contentType: "prose" });
			expect(result.length).toBeGreaterThan(1);
			// Overlap snaps back to the prior paragraph boundary, so the absolute
			// magnitude varies with paragraph size. The invariants we DO require:
			// (a) no gap between chunks: cur.startOffset <= prev.endOffset.
			// (b) forward progress: cur.startOffset > prev.startOffset.
			for (let i = 1; i < result.length; i++) {
				const prev = result[i - 1];
				const cur = result[i];
				if (!prev || !cur) continue;
				expect(cur.startOffset).toBeLessThanOrEqual(prev.endOffset);
				expect(cur.startOffset).toBeGreaterThan(prev.startOffset);
			}
		});
	});

	describe("boundary at text.length", () => {
		it("last chunk endOffset matches text.length when input ends on a paragraph break", () => {
			const p1 = paragraph(20, "Alpha:");
			const p2 = paragraph(20, "Beta:");
			const p3 = paragraph(20, "Gamma:");
			const text = `${p1}\n\n${p2}\n\n${p3}\n\n`;
			const result = chunk(text, { contentType: "prose" });
			expect(result.at(-1)?.endOffset).toBe(text.length);
		});
	});

	describe("config validation", () => {
		it("rejects invalid config even on empty input", () => {
			expect(() => chunk("", { tokenizerMode: "tiktoken-foo" as never })).toThrow();
			expect(() => chunk("", { minTokens: -1 as never })).toThrow();
		});

		it("rejects tokenizerMode 'tiktoken' until the implementation lands", () => {
			// `tiktoken` is aspirational in PRD §15.1.2 but not implemented in Phase 1.
			// The schema must reject it, not pass through to a runtime crash inside
			// `countTokens`.
			expect(() => chunk("hello world", { tokenizerMode: "tiktoken" as never })).toThrow();
		});
	});

	describe("turn-line regex", () => {
		it("does not cross newlines (speaker class excludes \\n)", () => {
			const text = "Speaker\nSecondLine: body\n[2026-04-28] Real: turn 2";
			const chunks = chunk(text, { contentType: "conversation" });
			// Entire text fits in one chunk; the fake `Speaker\nSecondLine:` must NOT
			// produce a turn boundary that splits the text.
			expect(chunks.length).toBe(1);
		});
	});
});
