/** Real fs + real config snapshot writer. No mocks. */

/**
 * Regression for codex finding (config/index.ts:430-447 / batch-C C1):
 *
 * `EMBEDDER_MODEL_DEFAULT` was previously hard-coded to
 * `"qwen3-embedding-4b@1024"` while the actual local default model is
 * `LOCAL_EMBEDDING_MODEL` (the bundled PPLX local model)
 * exported by the embedder package. Hard-coding the wrong string mislabeled
 * every default-provider chunk in eval traces.
 *
 * Fix: `EMBEDDER_MODEL_DEFAULT = LOCAL_EMBEDDING_MODEL` — derive from the
 * embedder package so future regressions to a hard-coded string fail
 * these tests.
 *
 * Three structural assertions, all over real code paths:
 *   1. The constant in `config/index.ts` is `===` the embedder constant.
 *   2. `buildConfigSnapshot()` (the function eval-trace.ts uses) carries
 *      the embedder's value.
 *   3. `writeConfigSnapshot(tmp)` writes a JSON file whose
 *      `EMBEDDER_MODEL_DEFAULT` field equals the embedder's value.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDER_MODEL_DEFAULT } from "../../../../packages/sno-station-mem/config/index.ts";
import {
	buildConfigSnapshot,
	writeConfigSnapshot,
} from "../../../../packages/sno-station-mem/src/engine/eval/trace.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../../packages/embedder/src/index.ts";

describe("EMBEDDER_MODEL_DEFAULT lineage — codex C1 regression", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mem-claw-embedder-prov-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("EMBEDDER_MODEL_DEFAULT === LOCAL_EMBEDDING_MODEL (no hard-coding)", () => {
		// If anyone ever inlines a string here again, this fails the moment
		// the embedder package's constant moves.
		expect(EMBEDDER_MODEL_DEFAULT).toBe(LOCAL_EMBEDDING_MODEL);

		// Defensive: catch the specific bug-string regression (the previous
		// hard-coded value the codex finding called out).
		expect(EMBEDDER_MODEL_DEFAULT).not.toBe("qwen3-embedding-4b@1024");
	});

	it("buildConfigSnapshot() carries LOCAL_EMBEDDING_MODEL as EMBEDDER_MODEL_DEFAULT", () => {
		const snapshot = buildConfigSnapshot();
		expect(snapshot.EMBEDDER_MODEL_DEFAULT).toBe(LOCAL_EMBEDDING_MODEL);
	});

	it("writeConfigSnapshot writes JSON whose EMBEDDER_MODEL_DEFAULT equals LOCAL_EMBEDDING_MODEL", () => {
		writeConfigSnapshot(tmp);
		const onDisk = JSON.parse(
			readFileSync(join(tmp, "config-snapshot.json"), "utf8"),
		) as Record<string, unknown>;
		expect(onDisk.EMBEDDER_MODEL_DEFAULT).toBe(LOCAL_EMBEDDING_MODEL);
	});
});
