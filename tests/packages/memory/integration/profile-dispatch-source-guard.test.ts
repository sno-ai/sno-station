import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("profile candidate dispatch source guard", () => {
	it("has no handleProfileMerge definition or call site in runtime source", () => {
		const root = join(process.cwd(), "src");
		const files = [
			"extraction/insight-distill-candidate-processor.ts",
			"extraction/insight-distill-merge-handlers.ts",
			"extraction/memory-extraction-pipeline.ts",
		];
		const hits = files.flatMap((file) => {
			const body = readFileSync(join(root, file), "utf8");
			return body.includes("handleProfileMerge") ? [file] : [];
		});

		expect(hits).toEqual([]);
	});
});
