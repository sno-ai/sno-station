/** @file retrieval-error-cause.test.ts
 * @purpose Proves a wrapped retrieval failure states its own cause in the text every consumer reports.
 * @boundary The real error class only; the lowest boundary that can prove message composition.
 */

import { describe, expect, it } from "vitest";
import { EmbeddingError, RetrievalError } from "@/shared/errors";

describe("RetrievalError", () => {
	it("says what actually failed, not only that retrieval failed", () => {
		// The measured loss: fifteen identical "Failed to retrieve memories" lines were the only
		// trace on disk of a round that scored nothing, because every consumer reports `message`
		// and drops the Error. The cause here is the real one that round hid.
		const cause = new EmbeddingError("memory-metadata-codec: missing memory category/kind");
		const error = new RetrievalError("Failed to retrieve memories", cause);
		expect(error.message).toContain("Failed to retrieve memories");
		expect(error.message).toContain("memory-metadata-codec: missing memory category/kind");
		// The cause object still travels, so a consumer that does inspect it loses nothing.
		expect(error.cause).toBe(cause);
		expect(error.code).toBe("retrieval_error");
		expect(error.name).toBe("RetrievalError");
	});

	it("stays readable when there is no cause to add", () => {
		const error = new RetrievalError("Failed to retrieve memories");
		expect(error.message).toBe("Failed to retrieve memories");
		expect(error.cause).toBeUndefined();
	});

	it("carries the reason when the cause is not an Error", () => {
		// A rejected promise can carry anything. The message must not gain a stray separator or
		// the string "undefined" — a log line that ends in a colon reads as a truncated log.
		const error = new RetrievalError("Failed to retrieve memories", "rerank endpoint 404");
		expect(error.message).toBe("Failed to retrieve memories");
		expect(error.cause).toBe("rerank endpoint 404");
	});
});
