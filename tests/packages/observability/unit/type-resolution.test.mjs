// Type-resolution test per task §30.3: downstream consumer under strict tsconfig
// SHALL be able to resolve `Event` and `AgentId` from the public entry point.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = resolve(new URL("../../../..", import.meta.url).pathname);
const pkgRoot = join(repoRoot, "packages/sno-observe");

describe("type-resolution for downstream consumers (30.3)", () => {
	it("Event and AgentId resolve under strict tsconfig", () => {
		const dir = mkdtempSync(join(tmpdir(), "sno-observe-type-"));
		try {
			mkdirSync(join(dir, "node_modules", "@snoai"), { recursive: true });
			symlinkSync(pkgRoot, join(dir, "node_modules", "@snoai", "sno-observe"));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify(
					{ name: "type-probe", type: "module", private: true },
					null,
					2,
				),
			);
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify(
					{
						compilerOptions: {
							target: "ES2022",
							module: "NodeNext",
							moduleResolution: "NodeNext",
							strict: true,
							exactOptionalPropertyTypes: true,
							noUncheckedIndexedAccess: true,
							noUnusedLocals: true,
							noUnusedParameters: true,
							noEmit: true,
							skipLibCheck: true,
						},
						include: ["probe.ts"],
					},
					null,
					2,
				),
			);
			writeFileSync(
				join(dir, "probe.ts"),
				[
					`import { createSnoObserve } from "@snoai/sno-observe";`,
					`import type { Event, AgentId, ConsentValue, RuntimeOptions } from "@snoai/sno-observe";`,
					`const a: AgentId = "codex";`,
					`const c: ConsentValue = "metadata-only";`,
					`const e: Event = { event_type: "memory.write", lane: "memory", agent_id: a, payload: { key_hash: "${"a".repeat(64)}", byte_len: 1, content_tokens: 1, tokens_method: "char_approximation" }, consent_level: c };`,
					`const opts: RuntimeOptions = { cwd: "." };`,
					`const observe = createSnoObserve(opts);`,
					`void observe;`,
					`void e;`,
					"",
				].join("\n"),
			);
			// Find tsc — prefer the workspace tsc; fall back to npx.
			const tscBin = join(repoRoot, "node_modules/.bin/tsc");
			const result = spawnSync(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
				cwd: dir,
				encoding: "utf8",
			});
			assert.equal(
				result.status,
				0,
				`tsc failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
