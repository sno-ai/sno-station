/** Proves the surviving generic JSON reader recovers real provider wrapper drift. */

import { describe, expect, it } from "vitest";
import { extractJsonFromResponse } from "@/shared/llm-json-utils";

describe("extractJsonFromResponse", () => {
	it("returns a top-level array after optional prose", () => {
		const raw = 'Here are the records.\n[{"index":0},{"index":1}]';
		expect(JSON.parse(extractJsonFromResponse(raw) ?? "null")).toHaveLength(2);
	});

	it("returns a top-level object", () => {
		const raw = '{"records":[{"index":0}]}';
		expect(JSON.parse(extractJsonFromResponse(raw) ?? "null")).toEqual({
			records: [{ index: 0 }],
		});
	});

	it("does not open a container on punctuation inside a string", () => {
		const raw = '{"message":"an array [1,2] in prose","ok":true}';
		expect(extractJsonFromResponse(raw)).toBe(raw);
	});

	it("keeps scanning past a literal bracket label", () => {
		const raw = 'Here is [JSON]: {"records":[{"index":0}]}';
		expect(JSON.parse(extractJsonFromResponse(raw) ?? "null")).toEqual({
			records: [{ index: 0 }],
		});
	});

	it("skips an explanatory fence before the JSON fence", () => {
		const raw = [
			"```",
			"I will now parse the records.",
			"```",
			"```json",
			'{"records":[{"index":0}]}',
			"```",
		].join("\n");
		expect(JSON.parse(extractJsonFromResponse(raw) ?? "null")).toEqual({
			records: [{ index: 0 }],
		});
	});
});
