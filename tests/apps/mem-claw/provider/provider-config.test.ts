import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema.ts";

describe("provider config hard cut", () => {
	it("rejects compaction even when disabled", () => {
		expect(() =>
			pluginConfigSchema.parse({
				embedding: { provider: "local-onnx", dimensions: 1024 },
				compaction: { enabled: false },
			}),
		).toThrow(/Unrecognized key.*compaction|compaction/);
	});

	it("keeps generated eval-server config free of compaction", () => {
		const source = readFileSync(
			new URL("../eval-server/memora-eval-server.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("compaction:");
	});
});
