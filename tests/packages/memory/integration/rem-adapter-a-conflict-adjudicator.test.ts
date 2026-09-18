import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	renderAdapterAChatPrompt,
	renderAdapterAPrompt,
	type AdapterAMemoryView,
} from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";

const fixturePath = resolve(
	import.meta.dirname,
	"../../../../packages/sno-station-mem/fixtures/adapter-a-prompt-byte-identity.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	fixtures: Array<{
		id: string;
		renderer: "training" | "chat";
		older: AdapterAMemoryView;
		newer: AdapterAMemoryView;
		utf8Base64: string;
	}>;
};

describe("Adapter A prompt byte identity", () => {
	it("rem-replace-prompt-byte-identity", () => {
		for (const golden of fixture.fixtures) {
			const rendered =
				golden.renderer === "training"
					? renderAdapterAPrompt(golden.older, golden.newer)
					: renderAdapterAChatPrompt({ older: golden.older, newer: golden.newer });

			expect(Buffer.from(rendered, "utf8").toString("base64"), golden.id).toBe(
				golden.utf8Base64,
			);
			expect(rendered, golden.id).not.toContain("\r");
			if (golden.renderer === "training") {
				expect(rendered, golden.id).not.toContain("contentHash");
			}
		}
	});

	for (const golden of fixture.fixtures) {
		it(golden.id, () => {
			const rendered =
				golden.renderer === "training"
					? renderAdapterAPrompt(golden.older, golden.newer)
					: renderAdapterAChatPrompt({ older: golden.older, newer: golden.newer });

			expect(Buffer.from(rendered, "utf8").toString("base64")).toBe(golden.utf8Base64);
			expect(rendered).not.toContain("\r");
			if (golden.renderer === "training") {
				expect(rendered).not.toContain("contentHash");
			}
		});
	}
});
