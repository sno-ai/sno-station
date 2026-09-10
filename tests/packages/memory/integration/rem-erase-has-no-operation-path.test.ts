import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

it("rejects erase and exposes no REM deletion branch", async () => {
	const product = await import("../../../../packages/rem-core/src/index.ts");
	expect(product.parseRemOperationType("erase")).toBeUndefined();
	const server = readFileSync(resolve(repoRoot, "apps/mem-claw/src/sidecar/server.ts"), "utf8");
	expect(server).not.toMatch(/case\s+["']erase["']/u);
	expect(server).not.toMatch(/deleteMemory|DELETE FROM nodix_memories/u);
});
