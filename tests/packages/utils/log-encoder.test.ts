import { expect, it } from "vitest";
import { sanitizeLogAttributes } from "../../../packages/utils/src/log-encoder.ts";

it("keeps a failed host model call's category and reason readable, and still hides free text", () => {
	const out = sanitizeLogAttributes({
		failure_category: "transport", failure_reason: "no-agent-endpoint", error: "[R5] agent-llm transport: no-agent-endpoint",
	}) as Record<string, unknown>;
	expect(out["failure_category"]).toBe("transport");
	expect(out["failure_reason"]).toBe("no-agent-endpoint");
	expect(out["error"]).toMatchObject({ length: 43 });
});

it("writes the sentence of our own typed errors in plain text, down the cause chain, and still hides other errors' text", () => {
	class EmbeddingError extends Error { constructor(m: string) { super(m); this.name = "EmbeddingError"; } }
	class RetrievalError extends Error { constructor(m: string, cause: unknown) { super(m, { cause }); this.name = "RetrievalError"; } }
	const own = new RetrievalError("Failed to retrieve memories", new EmbeddingError("Embedder chunk of 693 tokens exceeds DEFAULT_MAX_CONTEXT_TOKENS (512)"));
	const out = sanitizeLogAttributes({ error: own }) as { error: { message: string; cause: { message: string } } };
	expect(out.error.message).toBe("Failed to retrieve memories");
	expect(out.error.cause.message).toBe("Embedder chunk of 693 tokens exceeds DEFAULT_MAX_CONTEXT_TOKENS (512)");
	const other = sanitizeLogAttributes({ error: new Error("ENOENT /home/someone/private.txt") }) as { error: Record<string, unknown> };
	expect(other.error["message"]).toBeUndefined();
	expect(other.error["message_sha256"]).toBeDefined();
});
